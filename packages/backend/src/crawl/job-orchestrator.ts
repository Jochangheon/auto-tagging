import type { JobFailureReason, CandidateGroup, CandidateTree, PanelSizeHint } from "@autotag/shared";
import type { LlmProvider, PipelineStageCounts } from "../llm/client.js";
import type { ViewportMode } from "@autotag/shared";
import { resolveCdpDeviceMetrics } from "@autotag/shared";
import {
  bootstrapSession,
  fetchPageHtml,
  navigateSessionToUrl,
  pickLiveViewUrl,
  setViewport,
  setViewportAndReload,
  stopInteraction,
  waitForPageReady,
  type FirecrawlSession,
} from "./firecrawl-interact.js";
import { applyCdpLiveViewViewport, disconnectCdp, setCdpViewport } from "./cdp-session.js";
import { exploreRecursiveMenuAndTag } from "./menu-explorer/explore-recursive-menu.js";
import { tagLiveDom, mergeTagEntries, type LiveTagEntry } from "./tag-live-dom.js";
import type { TagLiveDomStats } from "./tag-live-dom.js";
import { crossViewportPlatformRecheck } from "./platform-crosscheck.js";
import { runExtractPipeline } from "./extract-pipeline.js";
import {
  createJob,
  getJob,
  updateJob,
  updateJobProgress,
  type StoredJob,
} from "./job-store.js";
import { derivePageNameFromHtml } from "./session-page.js";
import { captureAbsPath, capturePageScreenshot } from "./page-capture.js";
import {
  annotateCandidatesCapture,
  applyCaptureBboxes,
  attachElementCaptureResults,
  markCandidatesPendingCapture,
  patchCandidateElementCapture,
  syncCandidateTreeBboxes,
} from "./candidate-capture.js";
import {
  captureElementThumbnailsOffline,
  type ElementCaptureTarget,
} from "./element-capture.js";
import { groupCandidates } from "./candidate-grouper.js";
import { applyPageAliasToCandidates } from "./page-alias.js";
import {
  buildPositionsFromEntries,
  buildPositionsFileFromCandidates,
  candidateHasConfirmedPosition,
  filterCandidatesWithConfirmedPosition,
  writePositionsFile,
} from "./positions-file.js";
import { throwIfCancelled, isJobCancelled } from "./pipeline-cancel.js";
import { logCaptureQc, verifyCaptureQuality } from "./capture-verify.js";
import type { CaptureQcReport } from "./capture-verify.js";
import { injectAuthCookiesForUrl } from "./inject-auth-cookies.js";
import { withAcquiredFirecrawlKey } from "./firecrawl-key-pool.js";
import {
  assertAnalysisUrl,
  assertAnalysisUrlResilient,
} from "./analysis-url-guard.js";
import { unregisterOpenScrapeId } from "./firecrawl-session-registry.js";
import type { MenuPathStep } from "./menu-explorer/types.js";

export interface LiveViewportOpts {
  panel?: PanelSizeHint;
}

/**
 * CDP-first remote viewport; interact as fallback.
 * MO must reload after metrics — otherwise CSS still renders the PC layout and
 * capture later crops the left 390px of a desktop page (broken MO screenshots).
 */
async function ensureRemoteLiveViewport(
  session: FirecrawlSession,
  mode: ViewportMode,
  opts?: LiveViewportOpts
): Promise<{ width: number; height: number }> {
  const target = resolveCdpDeviceMetrics(mode, opts?.panel);

  if (mode === "mo") {
    if (session.cdpUrl) {
      try {
        await setCdpViewport(mode, { cdpUrl: session.cdpUrl, panel: opts?.panel });
        console.log(
          `[viewport] MO metrics+reload via CDP device=${target.width}x${target.height}`
        );
        return target;
      } catch (err) {
        console.warn(
          `[viewport] MO CDP reload failed, falling back to interact: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    await setViewportAndReload(session.scrapeId, mode, [], target);
    return target;
  }

  if (session.cdpUrl) {
    const cdpResult = await applyCdpLiveViewViewport(mode, {
      cdpUrl: session.cdpUrl,
      panel: opts?.panel,
    });
    if (cdpResult.ok) {
      return { width: cdpResult.width, height: cdpResult.height };
    }
  }

  await setViewport(session.scrapeId, mode, target);
  return target;
}

export interface DevAnalyzeResult {
  ok: true;
  job_id: string;
  status: "awaiting_pick";
  url: string;
  scrape_id: string;
  live_view_url: string | null;
  cdp_url: string | null;
  html_length: number;
  candidate_count: number;
  group_count: number;
  gnb_hover_opened: string[];
  llm_source: LlmProvider;
  candidates_total_input: number;
  candidates_succeeded: number;
  dropped: Array<{ tag_id: number; reason: string }>;
  llm_calls_made: number;
  splits_occurred: number;
  pipeline_stage_counts?: PipelineStageCounts;
  groups: CandidateGroup[];
  tree?: CandidateTree;
  page_name?: string;
  candidates: StoredJob["candidates"];
  capture_url?: string | null;
  capture_width?: number | null;
  capture_height?: number | null;
  capture_qc?: CaptureQcReport | null;
}

export interface DevAnalyzeFailure {
  ok: false;
  job_id?: string;
  status: "failed";
  error: string;
  failure_reason: JobFailureReason;
  llm_source?: LlmProvider;
}

export type DevAnalyzeResponse = DevAnalyzeResult | DevAnalyzeFailure;

export interface OrchestratorSession {
  session: FirecrawlSession;
  job: StoredJob;
}

export interface CollectArtifacts {
  html: string;
  entries: LiveTagEntry[];
  tag_stats: TagLiveDomStats;
  gnb_hover_opened: string[];
  path_by_tag_id: Record<number, MenuPathStep[]>;
  captureMeta: Awaited<ReturnType<typeof capturePageScreenshot>>;
  fc_ms: number;
  nav_reuse: boolean;
}

export interface NameWithLlmResult {
  candidates: StoredJob["candidates"];
  groups: CandidateGroup[];
  candidate_tree: CandidateTree;
  group_count: number;
  html_length: number;
  gnb_hover_opened: string[];
  llm_source: LlmProvider;
  meta: NonNullable<StoredJob["extract_meta"]>;
  capture_url?: string | null;
  capture_width?: number | null;
  capture_height?: number | null;
  capture_qc?: CaptureQcReport | null;
  llm_ms: number;
}

export interface ViewportPipelineResult extends NameWithLlmResult {
  /**
   * Resolves once offline element capture has settled.
   * Firecrawl is already released before naming — callers need not hold a session.
   */
  capturesSettled: Promise<void>;
  fc_ms: number;
  nav_reuse: boolean;
}

/** Release Firecrawl scrape + CDP for this session only. */
export async function releaseFirecrawlSession(
  session: Pick<FirecrawlSession, "scrapeId" | "cdpUrl"> | null | undefined
): Promise<void> {
  if (!session?.scrapeId) return;
  if (session.cdpUrl) {
    await disconnectCdp(session.cdpUrl).catch(() => {});
  }
  try {
    await stopInteraction(session.scrapeId);
  } catch {
    /* ignore */
  }
  unregisterOpenScrapeId(session.scrapeId);
}

/**
 * FC phase: bootstrap/reuse session already open → explore → page PNG → artifacts.
 * Does NOT run LLM. Caller must release the session (unless host-group reuse).
 */
export async function collectWithFirecrawl(
  jobId: string,
  session: FirecrawlSession,
  url: string,
  viewport: ViewportMode,
  opts: { skipViewportSet?: boolean; nav_reuse?: boolean } = {}
): Promise<CollectArtifacts> {
  const t0 = Date.now();
  const navReuse = opts.nav_reuse === true;

  if (!opts.skipViewportSet) {
    await setViewport(session.scrapeId, viewport);
    await waitForPageReady(session.scrapeId);
  }

  throwIfCancelled(jobId);

  updateJobProgress(jobId, {
    stage: "collecting",
    step: navReuse ? "navigate_reuse" : "collect_elements",
    progress: { current: 0, total: 1 },
  });

  const explore = await exploreRecursiveMenuAndTag(session, url, viewport);
  await assertAnalysisUrl(session, url);
  let entries = explore.entries;
  let tagStats = explore.tag_stats;
  const gnbHoverOpened = explore.expand_opened;
  if (entries.length === 0) {
    const tagged = await tagLiveDom(session.scrapeId, viewport);
    tagged.entries = await crossViewportPlatformRecheck(session, viewport, tagged.entries);
    entries = tagged.entries;
    tagStats = tagged.stats;
  }

  throwIfCancelled(jobId);

  const collectedCount = entries.length || tagStats.tagged || tagStats.raw_matched;
  updateJobProgress(jobId, {
    stage: "collecting",
    progress: { current: collectedCount, total: Math.max(collectedCount, 1) },
  });

  updateJobProgress(jobId, {
    stage: "tagging",
    step: "tag_live_dom",
    progress: {
      current: tagStats.tagged,
      total: Math.max(tagStats.raw_matched, tagStats.tagged, 1),
    },
  });

  if (entries.length === 0) {
    await waitForPageReady(session.scrapeId);
  }

  updateJobProgress(jobId, {
    stage: "tagging",
    step: "page_capture",
    progress: { current: 0, total: 1 },
  });

  throwIfCancelled(jobId);

  // keepAlive: host-group reuse / viewport retag still need this CDP after collect.
  // Callers that are done with Firecrawl must call releaseFirecrawlSession.
  const captureMeta = await capturePageScreenshot(session, jobId, viewport, url, {
    keepAlive: true,
    skipHeavyPrep: entries.length > 0,
  });

  if (captureMeta?.tag_entries?.length) {
    const before = entries.length;
    entries = mergeTagEntries(entries, captureMeta.tag_entries);
    tagStats = {
      ...tagStats,
      tagged: entries.length,
      raw_matched: Math.max(tagStats.raw_matched, entries.length),
    };
    console.log(
      `[collect] capture merge job=${jobId.slice(0, 8)} explore=${before} ` +
        `capture=${captureMeta.tag_entries.length} merged=${entries.length}`
    );
  }

  const positionsFile = buildPositionsFromEntries(entries, {
    jobId,
    viewport,
    pageUrl: url,
    pageWidth: captureMeta?.width ?? 0,
    pageHeight: captureMeta?.height ?? 0,
    captureBboxes: captureMeta?.bboxes ?? {},
  });
  await writePositionsFile(jobId, positionsFile);
  updateJob(jobId, { element_positions: positionsFile });
  console.log(
    `[positions] saved job=${jobId.slice(0, 8)} viewport=${viewport} ` +
      `count=${positionsFile.positions.length} ` +
      `with_bbox=${positionsFile.positions.filter((p) => p.bbox && p.bbox.w > 0 && p.bbox.h > 0).length}`
  );

  throwIfCancelled(jobId);

  let html = (captureMeta?.html ?? "").trim();
  if (!html) {
    html = await fetchPageHtml(session.scrapeId);
  } else {
    console.log(`[collect] html from capture (${html.length} chars) — skipped interact fetch`);
  }

  updateJob(jobId, {
    status: "extracting",
    html,
    html_length: html.length,
    live_entries: entries,
    gnb_hover_opened: gnbHoverOpened,
    viewport,
    capture_url: captureMeta?.url ?? null,
    capture_width: captureMeta?.width ?? null,
    capture_height: captureMeta?.height ?? null,
  });

  const fc_ms = Date.now() - t0;
  console.log(
    `[timing] fc_ms=${fc_ms} nav_reuse=${navReuse} job=${jobId.slice(0, 8)} viewport=${viewport}`
  );

  return {
    html,
    entries,
    tag_stats: tagStats,
    gnb_hover_opened: gnbHoverOpened,
    path_by_tag_id: explore.path_by_tag_id,
    captureMeta,
    fc_ms,
    nav_reuse: navReuse,
  };
}

/** LLM phase: naming/grouping from collect artifacts — no Firecrawl session. */
export async function nameWithLlm(
  jobId: string,
  url: string,
  viewport: ViewportMode,
  artifacts: CollectArtifacts,
  opts: { llm_model?: string } = {}
): Promise<NameWithLlmResult> {
  const t0 = Date.now();
  throwIfCancelled(jobId);

  const { html, entries, tag_stats: tagStats, captureMeta, gnb_hover_opened: gnbHoverOpened } =
    artifacts;
  const stateId = `${viewport}-base-${jobId.slice(0, 8)}`;
  const jobForAlias = getJob(jobId);
  const pageAlias = jobForAlias?.page_alias?.trim() || undefined;

  const extracted = await runExtractPipeline({
    html,
    entries,
    menu_path_by_tag_id: artifacts.path_by_tag_id,
    state_id: stateId,
    source_url: url,
    viewport,
    llm_model: opts.llm_model,
    tag_stats: tagStats,
    page_category_override: pageAlias,
    cancelCheck: () => isJobCancelled(jobId),
    onNamingProgress: (current, total) => {
      updateJobProgress(jobId, {
        stage: "naming",
        step: "llm_extract",
        progress: { current, total: Math.max(total, 1) },
      });
    },
    onGroupingProgress: (current, total) => {
      updateJobProgress(jobId, {
        stage: "grouping",
        step: "group_candidates",
        progress: { current, total: Math.max(total, 1) },
      });
    },
  });

  const effectivePageAlias =
    pageAlias || extracted.page_category?.trim() || derivePageNameFromHtml(html, url);
  if (!pageAlias && effectivePageAlias) {
    updateJob(jobId, { page_alias: effectivePageAlias });
  }

  const candidatesNamed = effectivePageAlias
    ? applyPageAliasToCandidates(
        extracted.candidates,
        effectivePageAlias,
        extracted.page_context
      )
    : extracted.candidates;

  const candidatesWithBbox = applyCaptureBboxes(
    candidatesNamed,
    captureMeta?.bboxes ?? {},
    entries
  );

  const droppedNoBbox = candidatesWithBbox.filter(
    (c) => c.tag_id !== 0 && !candidateHasConfirmedPosition(c)
  ).length;
  if (droppedNoBbox > 0) {
    console.log(
      `[positions] ${droppedNoBbox} candidates lack bbox — kept in pick list, capture may skip`
    );
  }

  const regrouped = groupCandidates(candidatesWithBbox);

  const candidatesForPositions = filterCandidatesWithConfirmedPosition(candidatesWithBbox);
  const positionsSynced = buildPositionsFileFromCandidates(candidatesForPositions, {
    jobId,
    viewport,
    pageUrl: url,
    pageWidth: captureMeta?.width ?? 0,
    pageHeight: captureMeta?.height ?? 0,
    captureUrl: captureMeta?.url ?? null,
  });
  await writePositionsFile(jobId, positionsSynced);
  updateJob(jobId, { element_positions: positionsSynced });
  console.log(
    `[positions] synced job=${jobId.slice(0, 8)} viewport=${viewport} ` +
      `count=${positionsSynced.positions.length} ` +
      `with_bbox=${positionsSynced.positions.filter((p) => p.bbox && p.bbox.w > 0 && p.bbox.h > 0).length}`
  );

  const candidatesPending = markCandidatesPendingCapture(candidatesWithBbox);
  const candidateTreePending = syncCandidateTreeBboxes(regrouped.tree, candidatesPending);

  updateJob(jobId, {
    status: "awaiting_pick",
    step: "awaiting_pick",
    candidates: candidatesPending,
    groups: regrouped.groups,
    candidate_tree: candidateTreePending,
    llm_source: extracted.llm_source,
    error_message: null,
    failure_reason: null,
    extract_meta: extracted.meta,
    viewport,
    capture_url: captureMeta?.url ?? null,
    capture_width: captureMeta?.width ?? null,
    capture_height: captureMeta?.height ?? null,
    capture_qc: null,
  });

  updateJobProgress(jobId, {
    stage: "grouping",
    progress: {
      current: extracted.candidates.length,
      total: Math.max(extracted.candidates.length, 1),
    },
  });
  updateJobProgress(jobId, { stage: "done", progress: { current: 1, total: 1 } });

  const llm_ms = Date.now() - t0;
  console.log(`[timing] llm_ms=${llm_ms} job=${jobId.slice(0, 8)} viewport=${viewport}`);

  return {
    candidates: candidatesPending,
    groups: regrouped.groups,
    candidate_tree: candidateTreePending,
    group_count: extracted.group_count,
    html_length: html.length,
    gnb_hover_opened: gnbHoverOpened,
    llm_source: extracted.llm_source,
    meta: extracted.meta,
    capture_url: captureMeta?.url ?? null,
    capture_width: captureMeta?.width ?? null,
    capture_height: captureMeta?.height ?? null,
    capture_qc: null,
    llm_ms,
  };
}

/**
 * Capture phase: crop element PNGs from the page screenshot — no browser session.
 */
function markPendingCapturesFailed(jobId: string): void {
  const j = getJob(jobId);
  if (!j?.candidates?.length) return;
  const candidates = j.candidates.map((c) => {
    if (c.tag_id === 0) return c;
    if (c.capture_status === "done" && c.element_capture_url) return c;
    return {
      ...c,
      capture_status: "failed" as const,
      no_capture: true,
      element_capture_url: null,
      capture_found: false,
    };
  });
  updateJob(jobId, { candidates });
}

export async function captureFromArtifacts(
  jobId: string,
  url: string,
  viewport: ViewportMode,
  artifacts: CollectArtifacts
): Promise<number> {
  const t0 = Date.now();
  if (isJobCancelled(jobId)) return 0;

  const job = getJob(jobId);
  if (!job?.candidates?.length) return 0;

  const { captureMeta, entries } = artifacts;
  let pageWidth = captureMeta?.width ?? 0;
  let pageHeight = captureMeta?.height ?? 0;

  // Prefer on-disk PNG size (source of truth for offline crop).
  try {
    const { access } = await import("node:fs/promises");
    const abs = captureAbsPath(jobId, viewport);
    await access(abs);
    const sharp = (await import("sharp")).default;
    const meta = await sharp(abs).metadata();
    if (meta.width && meta.height) {
      pageWidth = meta.width;
      pageHeight = meta.height;
    }
  } catch {
    console.warn(
      `[element-capture] page PNG missing job=${jobId.slice(0, 8)} viewport=${viewport} — marking captures failed`
    );
    markPendingCapturesFailed(jobId);
    return Date.now() - t0;
  }

  if (pageWidth < 32 || pageHeight < 32) {
    console.warn(
      `[element-capture] page PNG too small ${pageWidth}x${pageHeight} job=${jobId.slice(0, 8)}`
    );
    markPendingCapturesFailed(jobId);
    return Date.now() - t0;
  }

  const targets: ElementCaptureTarget[] = job.candidates
    .filter((c) => c.tag_id > 0)
    .map((c) => ({
      tag_id: c.tag_id,
      menu_reveal_path: c.menu_reveal_path,
      bbox: c.overlay_bbox,
    }));

  const actionableTotal = targets.length;
  updateJobProgress(jobId, {
    step: "element_capture",
    progress: { current: 0, total: Math.max(actionableTotal, 1) },
  });

  let elementCaptures: Map<number, import("./element-capture.js").ElementCaptureResult>;
  try {
    elementCaptures = await captureElementThumbnailsOffline(
      jobId,
      viewport,
      targets,
      { width: pageWidth, height: pageHeight },
      (current, total) => {
        updateJobProgress(jobId, {
          step: "element_capture",
          progress: { current, total },
        });
      },
      (tagId, result) => {
        const j = getJob(jobId);
        if (!j) return;
        const patchedCandidates = patchCandidateElementCapture(j.candidates, tagId, result);
        const patchedTree = syncCandidateTreeBboxes(
          j.candidate_tree ?? {
            categories: [],
            member_total: 0,
            category_count: 0,
            action_count: 0,
            label_group_count: 0,
          },
          patchedCandidates
        );
        updateJob(jobId, { candidates: patchedCandidates, candidate_tree: patchedTree });
      }
    );
  } catch (err) {
    console.error(
      `[element-capture] offline phase crashed job=${jobId.slice(0, 8)}:`,
      err instanceof Error ? err.message : err
    );
    markPendingCapturesFailed(jobId);
    return Date.now() - t0;
  }

  const jobAfter = getJob(jobId);
  if (!jobAfter) return Date.now() - t0;

  const candidates = annotateCandidatesCapture(
    attachElementCaptureResults(jobAfter.candidates, elementCaptures),
    captureMeta?.height ?? null
  );
  const candidate_tree = syncCandidateTreeBboxes(
    jobAfter.candidate_tree ?? {
      categories: [],
      member_total: 0,
      category_count: 0,
      action_count: 0,
      label_group_count: 0,
    },
    candidates
  );

  const positionsFinal = buildPositionsFileFromCandidates(candidates, {
    jobId,
    viewport,
    pageUrl: url,
    pageWidth,
    pageHeight,
    captureUrl: captureMeta?.url ?? null,
  });
  await writePositionsFile(jobId, positionsFinal);

  const positionsSaved = positionsFinal.positions.length;
  const captureQc = verifyCaptureQuality({
    captureBboxes: captureMeta?.bboxes ?? {},
    captureWidth: pageWidth,
    captureHeight: pageHeight,
    entries,
    candidates,
    modalCleared: captureMeta?.modal_cleared,
    pngBytes: captureMeta?.png_bytes,
    elementCaptureOk: [...elementCaptures.values()].filter((r) => r.ok).length,
    elementCaptureTotal: elementCaptures.size,
    positionsSaved,
  });
  logCaptureQc(captureQc, jobId, viewport);

  updateJob(jobId, {
    candidates,
    candidate_tree,
    capture_qc: captureQc,
    element_positions: positionsFinal,
  });

  updateJobProgress(jobId, {
    step: "capture_verify",
    progress: {
      current: captureQc.with_overlay_bbox,
      total: Math.max(captureQc.candidate_count, 1),
    },
  });

  const capture_ms = Date.now() - t0;
  console.log(`[timing] capture_ms=${capture_ms} job=${jobId.slice(0, 8)} viewport=${viewport}`);
  return capture_ms;
}

/** Collect + LLM extract at a viewport (reuse existing Firecrawl session). */
export async function executeViewportRetag(
  jobId: string,
  session: FirecrawlSession,
  url: string,
  viewport: ViewportMode,
  opts: { llm_model?: string } = {}
): Promise<ViewportPipelineResult> {
  const job = getJob(jobId);
  if (!job) throw new Error("job not found");

  updateJobProgress(jobId, {
    status: "crawling",
    stage: "crawling",
    step: viewport === "mo" ? "switch_mo" : "switch_pc",
    progress: { current: 0, total: 1 },
  });

  await setViewportAndReload(session.scrapeId, viewport, []);

  const result = await runViewportPipeline(jobId, session, url, viewport, {
    ...opts,
    skipViewportSet: true,
    releaseSession: false,
  });
  await result.capturesSettled;
  return result;
}

/**
 * Full pipeline: collect → (optional release) → LLM → offline capture.
 * `releaseSession` defaults true so Firecrawl is free during LLM.
 */
async function runViewportPipeline(
  jobId: string,
  session: FirecrawlSession,
  url: string,
  viewport: ViewportMode,
  opts: {
    llm_model?: string;
    skipViewportSet?: boolean;
    releaseSession?: boolean;
    nav_reuse?: boolean;
  }
): Promise<ViewportPipelineResult> {
  const artifacts = await collectWithFirecrawl(jobId, session, url, viewport, {
    skipViewportSet: opts.skipViewportSet,
    nav_reuse: opts.nav_reuse,
  });

  if (opts.releaseSession !== false) {
    await releaseFirecrawlSession(session);
  }

  const named = await nameWithLlm(jobId, url, viewport, artifacts, {
    llm_model: opts.llm_model,
  });

  const capturesSettled = captureFromArtifacts(jobId, url, viewport, artifacts)
    .then(() => undefined)
    .catch((err) => {
      console.error(
        `[element-capture] offline phase crashed job=${jobId.slice(0, 8)}:`,
        err instanceof Error ? err.message : err
      );
    });

  return {
    ...named,
    capturesSettled,
    fc_ms: artifacts.fc_ms,
    nav_reuse: artifacts.nav_reuse,
  };
}

/**
 * Collect-only path for batch host reuse: navigate existing session then collect.
 * On navigate failure, caller should fall back to a fresh bootstrap.
 */
export async function collectWithSessionReuse(
  jobId: string,
  session: FirecrawlSession,
  url: string,
  viewport: ViewportMode,
  opts: { panel?: PanelSizeHint; auth_owner_user_id?: string | null } = {}
): Promise<CollectArtifacts> {
  updateJobProgress(jobId, {
    status: "crawling",
    stage: "crawling",
    step: "navigate_reuse",
    progress: { current: 0, total: 1 },
  });

  await navigateSessionToUrl(session, url);
  updateJob(jobId, {
    scrape_id: session.scrapeId,
    cdp_url: session.cdpUrl ?? null,
    step: "page_ready",
  });

  await ensureRemoteLiveViewport(session, viewport, { panel: opts.panel });
  if (opts.auth_owner_user_id) {
    const auth = await injectAuthCookiesForUrl(session, url, opts.auth_owner_user_id);
    if (auth.injected) {
      console.log(
        `[analyze] auth cookies applied (reuse) label=${auth.label} count=${auth.cookie_count}`
      );
    }
  }
  await assertAnalysisUrl(session, url);
  try {
    await waitForPageReady(session.scrapeId);
  } catch (readyErr) {
    await assertAnalysisUrlResilient(session, url, readyErr);
    throw readyErr;
  }
  await assertAnalysisUrl(session, url);

  return collectWithFirecrawl(jobId, session, url, viewport, {
    skipViewportSet: true,
    nav_reuse: true,
  });
}

/** Open Firecrawl session + live view only (no collect, LLM, or tagging). */
export async function executeViewOnlyLiveView(
  jobId: string,
  url: string,
  viewport: ViewportMode,
  opts?: LiveViewportOpts & { preserveOtherSessions?: boolean }
): Promise<{ session: FirecrawlSession; live_view_url: string | null }> {
  return withAcquiredFirecrawlKey(jobId, async () =>
    executeViewOnlyLiveViewInner(jobId, url, viewport, opts)
  );
}

async function executeViewOnlyLiveViewInner(
  jobId: string,
  url: string,
  viewport: ViewportMode,
  opts?: LiveViewportOpts & { preserveOtherSessions?: boolean }
): Promise<{ session: FirecrawlSession; live_view_url: string | null }> {
  const job = getJob(jobId);
  if (!job) throw new Error("job not found");

  updateJobProgress(jobId, {
    status: "crawling",
    stage: "crawling",
    step: "bootstrap",
    progress: { current: 0, total: 1 },
  });

  const session = await bootstrapSession(url, {
    preserveOtherSessions: opts?.preserveOtherSessions,
  });

  updateJob(jobId, {
    scrape_id: session.scrapeId,
    cdp_url: session.cdpUrl ?? null,
    step: "page_ready",
    viewport,
  });

  updateJobProgress(jobId, {
    stage: "crawling",
    progress: { current: 1, total: 1 },
  });

  await ensureRemoteLiveViewport(session, viewport, opts);
  await waitForPageReady(session.scrapeId);

  const liveViewUrl = pickLiveViewUrl(session);

  updateJob(jobId, {
    status: "awaiting_pick",
    step: "awaiting_pick",
    live_view_url: liveViewUrl,
    candidates: [],
    groups: [],
    candidate_tree: undefined,
    error_message: null,
    failure_reason: null,
  });
  updateJobProgress(jobId, { stage: "done", progress: { current: 1, total: 1 } });

  return { session, live_view_url: liveViewUrl };
}

/** Open the URL and take a page PNG — no tagging. Used for project covers. */
export async function executePreviewCapture(
  url: string,
  viewport: ViewportMode
): Promise<{ job_id: string; capture_url: string | null }> {
  const { job_id } = startDevAnalyzeJob(url);
  return withAcquiredFirecrawlKey(job_id, async () => {
    const session = await bootstrapSession(url);
    try {
      await ensureRemoteLiveViewport(session, viewport);
      await waitForPageReady(session.scrapeId);
      const shot = await capturePageScreenshot(session, job_id, viewport, url, {
        skipHeavyPrep: true,
      });
      return { job_id, capture_url: shot?.url ?? null };
    } finally {
      await stopInteraction(session.scrapeId).catch(() => {});
    }
  });
}

/** Create job and return id immediately — pipeline runs via executeDevAnalyzeJob. */
export function startDevAnalyzeJob(url: string): { job_id: string } {
  const job = createJob(url);
  updateJobProgress(job.job_id, {
    status: "crawling",
    step: "bootstrap",
    stage: "crawling",
    progress: { current: 0, total: 1 },
  });
  return { job_id: job.job_id };
}

/** Crawl + extract for dev UI — returns session handles for highlight. */
export async function executeDevAnalyzeJob(
  jobId: string,
  url: string,
  opts: {
    llm_model?: string;
    viewport?: ViewportMode;
    panel?: PanelSizeHint;
    onSessionReady?: (session: FirecrawlSession) => void;
    preserveOtherSessions?: boolean;
    /** Reuse a pre-login Firecrawl session (cookies already set). */
    existingSession?: FirecrawlSession;
    /** Authenticated app user whose saved site session may be injected. */
    auth_owner_user_id?: string | null;
  } = {}
): Promise<{
  response: DevAnalyzeResponse;
  session?: OrchestratorSession;
  /** Resolves once Phase 2 (background element captures) has settled. */
  capturesSettled: Promise<void>;
}> {
  const viewport = opts.viewport ?? "pc";
  const job = getJob(jobId);
  if (!job) {
    return {
      response: {
        ok: false,
        status: "failed",
        error: "job not found",
        failure_reason: "unknown",
      },
      capturesSettled: Promise.resolve(),
    };
  }

  const run = () => executeDevAnalyzeJobInner(jobId, url, opts, viewport, job);
  if (opts.existingSession) {
    return run();
  }
  return withAcquiredFirecrawlKey(jobId, run);
}

async function executeDevAnalyzeJobInner(
  jobId: string,
  url: string,
  opts: {
    llm_model?: string;
    viewport?: ViewportMode;
    panel?: PanelSizeHint;
    onSessionReady?: (session: FirecrawlSession) => void;
    preserveOtherSessions?: boolean;
    existingSession?: FirecrawlSession;
    auth_owner_user_id?: string | null;
    /** When true, leave Firecrawl open after collect (host-group reuse). */
    holdSessionAfterCollect?: boolean;
  },
  viewport: ViewportMode,
  job: StoredJob
): Promise<{
  response: DevAnalyzeResponse;
  session?: OrchestratorSession;
  capturesSettled: Promise<void>;
  artifacts?: CollectArtifacts;
}> {
  let session: FirecrawlSession | undefined;
  try {
    updateJobProgress(jobId, {
      status: "crawling",
      step: "bootstrap",
      stage: "crawling",
      progress: { current: 0, total: 1 },
    });
    session =
      opts.existingSession ??
      (await bootstrapSession(url, {
        preserveOtherSessions: opts.preserveOtherSessions,
      }));
    opts.onSessionReady?.(session);

    updateJob(jobId, {
      scrape_id: session.scrapeId,
      cdp_url: session.cdpUrl ?? null,
      step: "page_ready",
    });

    updateJobProgress(jobId, {
      stage: "crawling",
      progress: { current: 1, total: 1 },
    });
    await ensureRemoteLiveViewport(session, viewport, { panel: opts.panel });

    // Apply pre-saved browser cookies (local Chrome login) before explore/tag.
    if (!opts.existingSession) {
      const auth = await injectAuthCookiesForUrl(
        session,
        url,
        opts.auth_owner_user_id ?? null
      );
      if (auth.error) {
        console.warn(`[analyze] auth cookie inject warning: ${auth.error}`);
      } else if (auth.injected) {
        console.log(
          `[analyze] auth cookies applied label=${auth.label} count=${auth.cookie_count}`
        );
      }
    }

    await assertAnalysisUrl(session, url);
    try {
      await waitForPageReady(session.scrapeId);
    } catch (readyErr) {
      await assertAnalysisUrlResilient(session, url, readyErr);
      throw readyErr;
    }
    await assertAnalysisUrl(session, url);

    // Collect → release FC (unless host reuse) → LLM → offline capture.
    const releaseSession = opts.holdSessionAfterCollect !== true && !opts.existingSession;
    const extracted = await runViewportPipeline(jobId, session, url, viewport, {
      llm_model: opts.llm_model,
      skipViewportSet: true,
      releaseSession,
    });

    // Live view handle is cleared when we release; reopen via reopenLiveViewForJob.
    updateJob(jobId, {
      status: "awaiting_pick",
      step: "awaiting_pick",
      live_view_url: releaseSession ? null : pickLiveViewUrl(session),
      scrape_id: releaseSession ? undefined : session.scrapeId,
      cdp_url: releaseSession ? null : session.cdpUrl ?? null,
    });

    const completed = getJob(jobId)!;

    const pageName = completed.html
      ? derivePageNameFromHtml(completed.html, url)
      : undefined;

    return {
      response: {
        ok: true,
        job_id: completed.job_id,
        status: "awaiting_pick",
        url,
        page_name: pageName,
        scrape_id: releaseSession ? "" : session.scrapeId,
        live_view_url: releaseSession ? null : pickLiveViewUrl(session),
        cdp_url: releaseSession ? null : session.cdpUrl ?? null,
        html_length: extracted.html_length,
        candidate_count: extracted.candidates.length,
        group_count: extracted.group_count,
        groups: extracted.groups,
        tree: extracted.candidate_tree,
        gnb_hover_opened: extracted.gnb_hover_opened,
        llm_source: extracted.llm_source,
        candidates_total_input: extracted.meta.candidates_total_input,
        candidates_succeeded: extracted.meta.candidates_succeeded,
        dropped: extracted.meta.dropped,
        llm_calls_made: extracted.meta.llm_calls_made,
        splits_occurred: extracted.meta.splits_occurred,
        pipeline_stage_counts: extracted.meta.pipeline_stage_counts,
        candidates: extracted.candidates,
        capture_url: extracted.capture_url ?? null,
        capture_width: extracted.capture_width ?? null,
        capture_height: extracted.capture_height ?? null,
        capture_qc: extracted.capture_qc ?? null,
      },
      // Session already released for the default path — static preview only.
      session: releaseSession ? undefined : { session, job: completed },
      capturesSettled: extracted.capturesSettled,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failureReason = classifyFailure(message);
    const llmSource = extractLlmSourceFromError(message);

    if (session) {
      await releaseFirecrawlSession(session).catch(() => {});
    }

    updateJob(jobId, {
      status: "failed",
      step: "failed",
      error_message: message,
      failure_reason: failureReason,
      llm_source: llmSource,
    });
    updateJobProgress(jobId, { stage: "failed" });

    return {
      response: {
        ok: false,
        job_id: jobId,
        status: "failed",
        error: message,
        failure_reason: failureReason,
        llm_source: llmSource,
      },
      capturesSettled: Promise.resolve(),
    };
  }
}

/** @deprecated Use startDevAnalyzeJob + executeDevAnalyzeJob for async polling. */
export async function runDevAnalyzeJob(
  url: string,
  opts: { llm_model?: string } = {}
): Promise<{
  response: DevAnalyzeResponse;
  session?: OrchestratorSession;
  capturesSettled: Promise<void>;
}> {
  const { job_id } = startDevAnalyzeJob(url);
  return executeDevAnalyzeJob(job_id, url, opts);
}

/** Re-open Firecrawl live view for an existing analyzed job (no LLM re-extract). */
export async function reopenLiveViewForJob(
  jobId: string,
  url: string,
  viewport: ViewportMode,
  opts?: LiveViewportOpts & { preserveOtherSessions?: boolean }
): Promise<{ session: FirecrawlSession; live_view_url: string | null }> {
  return withAcquiredFirecrawlKey(jobId, async () =>
    reopenLiveViewForJobInner(jobId, url, viewport, opts)
  );
}

async function reopenLiveViewForJobInner(
  jobId: string,
  url: string,
  viewport: ViewportMode,
  opts?: LiveViewportOpts & { preserveOtherSessions?: boolean }
): Promise<{ session: FirecrawlSession; live_view_url: string | null }> {
  const job = getJob(jobId);
  if (!job) throw new Error("job not found");

  updateJobProgress(jobId, {
    status: "crawling",
    stage: "crawling",
    step: "bootstrap",
    progress: { current: 0, total: 1 },
  });

  const session = await bootstrapSession(url, {
    preserveOtherSessions: opts?.preserveOtherSessions,
  });

  updateJob(jobId, {
    scrape_id: session.scrapeId,
    cdp_url: session.cdpUrl ?? null,
    step: "page_ready",
    viewport,
  });

  updateJobProgress(jobId, {
    stage: "crawling",
    progress: { current: 1, total: 1 },
  });

  await ensureRemoteLiveViewport(session, viewport, opts);
  await waitForPageReady(session.scrapeId);

  const liveViewUrl = pickLiveViewUrl(session);
  updateJob(jobId, {
    status: "awaiting_pick",
    step: "awaiting_pick",
    live_view_url: liveViewUrl,
  });
  updateJobProgress(jobId, { stage: "done", progress: { current: 1, total: 1 } });

  return { session, live_view_url: liveViewUrl };
}

/** Stop Firecrawl session after dev analyze (on error path). */
export async function stopOrchestratorSession(scrapeId: string): Promise<void> {
  await stopInteraction(scrapeId);
}

function classifyFailure(message: string): JobFailureReason {
  const lower = message.toLowerCase();
  if (lower.includes("openrouter") || lower.includes("llm") || lower.includes("extract")) {
    return "extract_error";
  }
  if (lower.includes("firecrawl") || lower.includes("scrape")) {
    return "firecrawl_error";
  }
  if (lower.includes("timeout")) return "timeout";
  if (lower.includes("budget")) return "budget_exceeded";
  return "unknown";
}

function extractLlmSourceFromError(message: string): LlmProvider | undefined {
  if (message.includes("openrouter")) return "openrouter";
  if (message.includes("gemini")) return "gemini";
  return undefined;
}

export function getActiveJob(jobId: string): StoredJob | undefined {
  return getJob(jobId);
}
