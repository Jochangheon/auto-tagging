import { Router } from "express";
import { readFile } from "node:fs/promises";
import { connectOverCdp, disconnectCdp, getCdpPage, applyCdpLiveViewViewport } from "../crawl/cdp-session.js";
import { setViewportAndReload, pickLiveViewUrl } from "../crawl/firecrawl-interact.js";
import { getFirecrawlKeyPoolStatus } from "../crawl/firecrawl-key-pool.js";
import { fetchLlmCreditUsage } from "../llm/client.js";
import { cleanupRegisteredSessions } from "../crawl/firecrawl-session-registry.js";
import {
  executeDevAnalyzeJob,
  executeViewportRetag,
  executeViewOnlyLiveView,
  startDevAnalyzeJob,
  stopOrchestratorSession,
  type OrchestratorSession,
} from "../crawl/job-orchestrator.js";
import { captureAbsPath } from "../crawl/page-capture.js";
import { elementCaptureAbsPath } from "../crawl/element-capture.js";
import { readPositionsFile } from "../crawl/positions-file.js";
import { getJob, updateJob, updateJobProgress, resolveAnalysisSession, upsertSessionPage, getSessionResult, getAnalysisSession, updateSessionSelection, setSessionTaxonomy, setSessionOwnerUserId } from "../crawl/job-store.js";
import { editPageCandidates, replaceSessionPage } from "../crawl/candidate-edit.js";
import { hydrateSessionFromCache, persistPageForUser, persistSessionPageSelection } from "../db/persist-page.js";
import { getRequestUserId } from "../auth/middleware.js";
import { getProject, saveProjectTaxonomy } from "../db/projects.js";
import { buildPageNodeFromJob, derivePageNameFromHtml, pageNodeFromSnapshot } from "../crawl/session-page.js";
import {
  buildViewportSnapshot,
  type ViewportCache,
  type ViewportSnapshot,
} from "../crawl/viewport-snapshot.js";
import type {
  ViewportMode,
  PanelSizeHint,
  TaxonomyDescriptionsRegistry,
  TaxonomyViewModel,
  PageNode,
} from "@autotag/shared";
import { parseViewportMode, normalizePageUrl } from "@autotag/shared";
import type { FirecrawlSession } from "../crawl/firecrawl-interact.js";
import { describeTaxonomyForCandidates } from "../llm/taxonomy-describe.js";
import { buildTaxonomyViewModel, taxonomyToSnapshotPayload } from "../taxonomy/taxonomy-builder.js";
import { saveTaxonomySnapshot } from "../taxonomy/taxonomy-snapshot.js";
import { taxonomyToXlsxBuffer } from "../taxonomy/taxonomy-excel.js";
import { selectionKey } from "@autotag/shared";
import { verifyElementPositionsWithVision } from "../llm/position-vision-verify.js";
import {
  getBatchAnalyze,
  forceResetPipelines,
  isBatchAnalyzeRunning,
  isCapturePhasePending,
  startBatchAnalyze,
  stopBatchAnalyze,
} from "../dev/batch-analyze-queue.js";
import {
  clearAllAuthCookies,
  deleteAuthCookies,
  getAuthCookieRecord,
  listAuthCookies,
  toAuthCookiePublic,
  upsertAuthCookies,
} from "../crawl/auth-cookie-store.js";
import {
  cancelInteractiveLogin,
  completeInteractiveLogin,
  getInteractiveLoginStatus,
  startInteractiveLogin,
} from "../crawl/interactive-login-session.js";
import {
  discoverSiteUrls,
  discoverSiteUrlsProgressive,
} from "../crawl/site-url-discovery.js";

export const devTestRouter = Router();

function tabAliasFromPage(page: PageNode | null | undefined): string | undefined {
  const pageView = page?.candidates?.find((candidate) => candidate.tag_id === 0);
  const candidateAlias =
    pageView?.page_category?.trim() ||
    pageView?.parameters
      ?.find((parameter) => parameter.name === "page_category")
      ?.value_hint?.trim();
  if (candidateAlias) return candidateAlias;
  const value = page?.page_name?.replace(/\s*·\s*(PC|MO)\s*$/i, "").trim();
  return value || undefined;
}

function descriptionsFromTaxonomy(
  taxonomy: TaxonomyViewModel
): TaxonomyDescriptionsRegistry {
  const registry: TaxonomyDescriptionsRegistry = { events: {}, properties: {} };
  for (const tab of taxonomy.tabs) {
    if (tab.kind === "page_category") {
      for (const row of tab.event_rows) {
        registry.events[row.row_key] = {
          trigger: row.trigger || "",
          description: row.description || "",
          note: row.note || "",
        };
      }
    } else if (tab.kind === "common") {
      for (const row of tab.variable_rows) {
        registry.properties[row.name] = {
          description: row.description || "",
          note: row.note || "",
        };
      }
    }
  }
  return registry;
}

async function requireOwnedProject(
  req: Parameters<typeof getRequestUserId>[0],
  projectId: string
): Promise<{ userId: string; projectId: string }> {
  const userId = getRequestUserId(req);
  if (!userId) throw new Error("authentication_required");
  if (!projectId) throw new Error("project_id_required");
  const project = await getProject(userId, projectId);
  if (!project) throw new Error("project_not_found");
  return { userId, projectId: project.id };
}

function getOwnedSession(
  req: Parameters<typeof getRequestUserId>[0],
  sessionId: string
) {
  const userId = getRequestUserId(req);
  const session = getAnalysisSession(sessionId);
  if (!userId || !session || session.owner_user_id !== userId || !session.project_id) {
    return null;
  }
  return session;
}

interface ActiveDevState {
  session: FirecrawlSession;
  sessionId: string;
  jobId: string;
  url: string;
  pageName: string;
  llm_model?: string;
  live_view_url: string | null;
  viewportCache: ViewportCache;
  activeViewport: ViewportMode;
  panelHint?: PanelSizeHint;
  lastSwitchError?: string | null;
}

let activeDev: ActiveDevState | null = null;
/** Session bootstrapped during analyze before activeDev is committed. */
let sessionHold: ActiveDevState | null = null;
let runningAnalyzeJobId: string | null = null;
let runningViewportSwitch = false;
let runningViewOnlyJobId: string | null = null;
let pipelineGeneration = 0;

function isPipelineStale(gen: number): boolean {
  return gen !== pipelineGeneration;
}

/** Cancel in-flight analyze / viewport / view-only work (stale handlers exit quietly). */
function preemptPipeline(): number {
  pipelineGeneration += 1;
  runningAnalyzeJobId = null;
  runningViewportSwitch = false;
  runningViewOnlyJobId = null;
  return pipelineGeneration;
}

function beginAnalyzePipeline(jobId: string): number {
  const gen = preemptPipeline();
  runningAnalyzeJobId = jobId;
  return gen;
}

function devContext(): ActiveDevState | null {
  return activeDev ?? sessionHold;
}

function promoteSessionHold(): ActiveDevState | null {
  if (activeDev) return activeDev;
  if (!sessionHold) return null;
  activeDev = sessionHold;
  sessionHold = null;
  return activeDev;
}

function parsePanelHint(body: Record<string, unknown>): PanelSizeHint | undefined {
  const w = Number(body?.panel_width);
  const h = Number(body?.panel_height);
  const panel: PanelSizeHint = {};
  if (Number.isFinite(w) && w > 0) panel.width = Math.round(w);
  if (Number.isFinite(h) && h > 0) panel.height = Math.round(h);
  return panel.width || panel.height ? panel : undefined;
}

function orchestrator(): OrchestratorSession | null {
  if (!activeDev) return null;
  const job = getJob(activeDev.jobId);
  if (!job) return null;
  return { session: activeDev.session, job };
}

async function teardownSession(): Promise<void> {
  await disconnectCdp();
  const scrapeId = activeDev?.session.scrapeId ?? sessionHold?.session.scrapeId;
  if (scrapeId) {
    await stopOrchestratorSession(scrapeId);
  }
  activeDev = null;
  sessionHold = null;
  await cleanupRegisteredSessions();
}

function tagRestoreFromSnapshot(snapshot: ViewportSnapshot) {
  return snapshot.candidates.map((c) => ({
    tag_id: c.tag_id,
    selector_hint: c.selector_hint,
  }));
}

async function reconnectCdp(): Promise<void> {
  if (!activeDev?.session.cdpUrl) return;
  const cdpUrl = activeDev.session.cdpUrl;
  await disconnectCdp(cdpUrl);
  const page = await connectOverCdp(cdpUrl);
  if (page) {
    await applyCdpLiveViewViewport(activeDev.activeViewport, {
      panel: activeDev.panelHint,
      page,
      cdpUrl,
    });
  }
}

async function applyViewportToBrowser(
  mode: ViewportMode,
  restoreTags: Array<{ tag_id: number; selector_hint: string }>
): Promise<void> {
  if (!activeDev) throw new Error("no_active_session");
  await setViewportAndReload(activeDev.session.scrapeId, mode, restoreTags);
  await reconnectCdp();
  activeDev.activeViewport = mode;
}

function applySnapshotToJob(snapshot: ViewportSnapshot): void {
  if (!activeDev) return;
  updateJob(activeDev.jobId, {
    candidates: snapshot.candidates,
    groups: snapshot.groups,
    candidate_tree: snapshot.candidate_tree,
    html_length: snapshot.html_length,
    gnb_hover_opened: snapshot.gnb_hover_opened,
    llm_source: snapshot.llm_source,
    extract_meta: snapshot.extract_meta,
    viewport: snapshot.viewport,
  });
  updateJobProgress(activeDev.jobId, { stage: "done", progress: { current: 1, total: 1 } });
  const job = getJob(activeDev.jobId);
  if (job) {
    syncJobToSession(activeDev.sessionId, job, activeDev.url, snapshot.viewport);
  }
}

function syncJobToSession(sessionId: string, job: NonNullable<ReturnType<typeof getJob>>, url: string, viewport: ViewportMode): void {
  const pageName = job.html ? derivePageNameFromHtml(job.html, url) : undefined;
  const pageNode = buildPageNodeFromJob(job, { pageName, viewport });
  upsertSessionPage(sessionId, pageNode);
  const session = getAnalysisSession(sessionId);
  if (session?.owner_user_id && session.project_id) {
    void persistPageForUser(
      session.owner_user_id,
      session.project_id,
      pageNode,
      session.selection ?? null
    );
  }
}

function sessionPayload(sessionId?: string | null): Record<string, unknown> {
  if (!sessionId) return {};
  const session = getSessionResult(sessionId);
  if (!session) return {};
  return {
    session_id: session.session_id,
    pages: session.pages,
    active_page_url: session.active_page_url,
    session_updated_at: session.updated_at,
    selection: session.selection ?? {},
    taxonomy: session.taxonomy ?? null,
    taxonomy_confirmed_at: session.taxonomy_confirmed_at ?? null,
  };
}

function jobPayload(job: NonNullable<ReturnType<typeof getJob>>, sessionId?: string | null): Record<string, unknown> {
  const liveMeta = activeDev?.session.liveViewMeta ?? null;
  return {
    status: "awaiting_pick",
    url: job.source_url,
    scrape_id: job.scrape_id,
    live_view_url: job.live_view_url,
    live_view_session: liveMeta,
    cdp_url: job.cdp_url,
    html_length: job.html_length,
    gnb_hover_opened: job.gnb_hover_opened ?? [],
    llm_source: job.llm_source,
    candidate_count: job.candidates.length,
    group_count: job.candidate_tree?.label_group_count ?? job.groups.length,
    groups: job.groups,
    tree: job.candidate_tree ?? null,
    candidates: job.candidates,
    active_viewport: activeDev?.activeViewport ?? job.viewport ?? "pc",
    capture_url: job.capture_url ?? null,
    capture_width: job.capture_width ?? null,
    capture_height: job.capture_height ?? null,
    capture_qc: job.capture_qc ?? null,
    viewport_cached: {
      pc: !!activeDev?.viewportCache.pc,
      mo: !!activeDev?.viewportCache.mo,
    },
    switch_error: activeDev?.lastSwitchError ?? null,
    ...sessionPayload(sessionId ?? activeDev?.sessionId),
    ...(job.extract_meta
      ? {
          candidates_total_input: job.extract_meta.candidates_total_input,
          candidates_succeeded: job.extract_meta.candidates_succeeded,
          dropped: job.extract_meta.dropped,
          llm_calls_made: job.extract_meta.llm_calls_made,
          splits_occurred: job.extract_meta.splits_occurred,
          pipeline_stage_counts: job.extract_meta.pipeline_stage_counts,
        }
      : {}),
  };
}

function parseSiteMapBody(body: Record<string, unknown> | undefined): {
  url: string;
  limit: number;
  sitemap: "skip" | "include" | "only";
  includeSubdomains: boolean;
  ignoreQueryParameters: boolean;
  search: string | undefined;
  timeoutMs: number | undefined;
} {
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const limitRaw = Number(body?.limit);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(5000, limitRaw)) : 100;
  const sitemapRaw = String(body?.sitemap || "include").trim();
  const sitemap: "skip" | "include" | "only" =
    sitemapRaw === "skip" || sitemapRaw === "only" || sitemapRaw === "include"
      ? sitemapRaw
      : "include";
  const includeSubdomains = body?.includeSubdomains === true;
  const ignoreQueryParameters = body?.ignoreQueryParameters !== false;
  const search = typeof body?.search === "string" ? body.search : undefined;
  const timeoutRaw = Number(body?.timeoutMs ?? body?.timeout);
  const timeoutMs = Number.isFinite(timeoutRaw) ? timeoutRaw : undefined;
  return { url, limit, sitemap, includeSubdomains, ignoreQueryParameters, search, timeoutMs };
}

/**
 * POST /api/dev/site-map — discover page URLs for a seed domain (Firecrawl /map).
 * Pre-analysis only: never starts crawl/LLM/tagging.
 * Body: { url, limit?, sitemap?, includeSubdomains?, ignoreQueryParameters?, search? }
 */
devTestRouter.post("/site-map", async (req, res) => {
  const parsed = parseSiteMapBody(req.body as Record<string, unknown> | undefined);
  if (!parsed.url) return res.status(400).json({ ok: false, error: "url required" });

  const result = await discoverSiteUrls({
    url: parsed.url,
    limit: parsed.limit,
    sitemap: parsed.sitemap,
    includeSubdomains: parsed.includeSubdomains,
    ignoreQueryParameters: parsed.ignoreQueryParameters,
    search: parsed.search,
    timeoutMs: parsed.timeoutMs,
  });

  if (!result.ok) {
    console.warn(`[dev-test] site-map failed: ${result.error}`);
    const timedOut = /timed out|timeout|시간 초과|초과/i.test(result.error);
    return res.status(timedOut ? 504 : 502).json({ ok: false, error: result.error });
  }

  console.log(
    `[dev-test] site-map seed=${result.seed_url} links=${result.links.length} raw=${result.raw_count} filtered=${result.filtered_out} (no analyze)`
  );
  return res.status(200).json({
    ok: true,
    seed_url: result.seed_url,
    links: result.links,
    raw_count: result.raw_count,
    filtered_out: result.filtered_out,
    analyze_started: false,
  });
});

/**
 * POST /api/dev/site-map-stream — NDJSON progressive URL discovery.
 * Emits seed immediately, then batches as smaller map steps finish.
 * On timeout: stops (no retry) and keeps partial links.
 */
devTestRouter.post("/site-map-stream", async (req, res) => {
  const parsed = parseSiteMapBody(req.body as Record<string, unknown> | undefined);
  if (!parsed.url) return res.status(400).json({ ok: false, error: "url required" });

  const ac = new AbortController();
  const onClose = () => ac.abort();
  req.on("close", onClose);

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
    (res as { flushHeaders: () => void }).flushHeaders();
  }

  const writeEvent = (ev: unknown) => {
    if (res.writableEnded || ac.signal.aborted) return;
    res.write(`${JSON.stringify(ev)}\n`);
  };

  try {
    await discoverSiteUrlsProgressive(
      {
        url: parsed.url,
        limit: parsed.limit,
        sitemap: parsed.sitemap,
        includeSubdomains: parsed.includeSubdomains,
        ignoreQueryParameters: parsed.ignoreQueryParameters,
        search: parsed.search,
        timeoutMs: parsed.timeoutMs,
        signal: ac.signal,
      },
      async (ev) => {
        writeEvent(ev);
        if (ev.type === "done") {
          console.log(
            `[dev-test] site-map-stream done seed=${ev.seed_url} links=${ev.links.length} (no analyze)`
          );
        } else if (ev.type === "stopped") {
          console.warn(
            `[dev-test] site-map-stream stopped reason=${ev.reason} total=${ev.total} seed=${ev.seed_url}`
          );
        } else if (ev.type === "error") {
          console.warn(`[dev-test] site-map-stream error: ${ev.error}`);
        }
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeEvent({ type: "error", error: msg });
  } finally {
    req.off("close", onClose);
    if (!res.writableEnded) res.end();
  }
});

/** POST /api/dev/auth-cookies — save cookies from local browser login */
devTestRouter.post("/auth-cookies", (req, res) => {
  const site_url = typeof req.body?.site_url === "string" ? req.body.site_url.trim() : "";
  const cookies_raw =
    typeof req.body?.cookies === "string"
      ? req.body.cookies
      : typeof req.body?.cookies_raw === "string"
        ? req.body.cookies_raw
        : "";
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : undefined;

  const result = upsertAuthCookies({
    site_url,
    cookies_raw,
    label,
    owner_user_id: getRequestUserId(req),
  });
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }
  console.log(
    `[dev-test] auth-cookies saved host=${result.record.host} count=${result.record.cookie_count}`
  );
  return res.status(200).json({ ok: true, ...toAuthCookiePublic(result.record) });
});

/** GET /api/dev/auth-cookies — list saved auth cookie packs */
devTestRouter.get("/auth-cookies", (req, res) => {
  return res
    .status(200)
    .json({ ok: true, sessions: listAuthCookies(getRequestUserId(req)) });
});

/** DELETE /api/dev/auth-cookies/:id — remove one cookie pack */
devTestRouter.delete("/auth-cookies/:id", (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "id required" });
  const ownerUserId = getRequestUserId(req);
  if (!getAuthCookieRecord(id, ownerUserId)) {
    return res.status(404).json({ ok: false, error: "auth_cookies_not_found" });
  }
  deleteAuthCookies(id, ownerUserId);
  return res.status(200).json({ ok: true });
});

/** DELETE /api/dev/auth-cookies — clear all */
devTestRouter.delete("/auth-cookies", (req, res) => {
  clearAllAuthCookies(getRequestUserId(req));
  return res.status(200).json({ ok: true });
});

/** Start a local browser window in which the user can log in normally. */
devTestRouter.post("/interactive-login/start", async (req, res) => {
  const siteUrl = typeof req.body?.site_url === "string" ? req.body.site_url.trim() : "";
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : undefined;
  if (!siteUrl) return res.status(400).json({ ok: false, error: "site_url required" });

  try {
    const result = await startInteractiveLogin({
      siteUrl,
      label,
      ownerUserId: getRequestUserId(req),
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: message });
  }
});

/** Report whether the login window is still open (no auto-detection of login). */
devTestRouter.get("/interactive-login/:id/status", async (req, res) => {
  try {
    const result = await getInteractiveLoginStatus(
      String(req.params.id || ""),
      getRequestUserId(req)
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message === "login_session_not_found" ? 404 : 500;
    return res.status(status).json({ ok: false, error: message });
  }
});

/** Capture cookies/localStorage from the logged-in browser and close it. */
devTestRouter.post("/interactive-login/:id/complete", async (req, res) => {
  try {
    const result = await completeInteractiveLogin(
      String(req.params.id || ""),
      getRequestUserId(req)
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      message === "login_session_not_found"
        ? 404
        : message === "login_not_completed" || message === "login_state_not_found"
          ? 409
          : 500;
    return res.status(status).json({ ok: false, error: message });
  }
});

devTestRouter.delete("/interactive-login/:id", async (req, res) => {
  const deleted = await cancelInteractiveLogin(
    String(req.params.id || ""),
    getRequestUserId(req)
  );
  return res.status(deleted ? 200 : 404).json({
    ok: deleted,
    ...(deleted ? {} : { error: "login_session_not_found" }),
  });
});

/** POST /api/dev/view-only — scrape + interact live view only (no LLM/tagging) */
devTestRouter.post("/view-only", async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!url) {
    return res.status(400).json({ ok: false, error: "url required" });
  }

  const viewport = parseViewportMode(req.body?.viewport) ?? "pc";
  const panelHint = parsePanelHint(req.body ?? {});
  const reuseSession = req.body?.reuse_session === true;
  const sessionIdRaw =
    typeof req.body?.session_id === "string" ? req.body.session_id.trim() : "";
  const analysisSession = resolveAnalysisSession(sessionIdRaw || null);
  const sessionId = analysisSession.session_id;

  if (reuseSession && activeDev?.live_view_url) {
    const liveMeta = activeDev.session.liveViewMeta ?? null;
    const liveUrl = pickLiveViewUrl(activeDev.session);
    if (liveUrl) {
      try {
        if (activeDev.activeViewport !== viewport) {
          await applyViewportToBrowser(viewport, []);
          activeDev.activeViewport = viewport;
        }
        await reconnectCdp();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ ok: false, error: message });
      }
      return res.status(200).json({
        ok: true,
        reused: true,
        session_id: sessionId,
        job_id: activeDev.jobId,
        live_view_url: liveUrl,
        live_view_session: liveMeta,
        active_viewport: activeDev.activeViewport,
      });
    }
  }

  if (runningAnalyzeJobId || runningViewportSwitch || runningViewOnlyJobId || isBatchAnalyzeRunning()) {
    return res.status(409).json({
      ok: false,
      error: "pipeline_already_running",
      job_id: runningAnalyzeJobId ?? runningViewOnlyJobId,
    });
  }

  const { job_id } = startDevAnalyzeJob(url);
  runningViewOnlyJobId = job_id;

  try {
    await teardownSession();
    const { session, live_view_url } = await executeViewOnlyLiveView(job_id, url, viewport, {
      panel: panelHint,
    });
    const job = getJob(job_id)!;

    activeDev = {
      session,
      sessionId,
      jobId: job_id,
      url,
      pageName: url,
      live_view_url,
      viewportCache: {},
      activeViewport: viewport,
      panelHint,
    };

    await reconnectCdp();

    console.log(`[dev-test] view-only ok url=${url} viewport=${viewport} live=${!!live_view_url}`);

    return res.status(200).json({
      ok: true,
      reused: false,
      session_id: sessionId,
      job_id,
      live_view_url,
      live_view_session: session.liveViewMeta ?? null,
      active_viewport: viewport,
      candidate_count: job.candidates.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[dev-test] view-only failed:", message);
    updateJobProgress(job_id, { stage: "failed" });
    return res.status(500).json({ ok: false, error: message, job_id });
  } finally {
    runningViewOnlyJobId = null;
  }
});

/** POST /api/dev/sync-viewport — re-apply CDP viewport to current dev panel size (non-fatal) */
devTestRouter.post("/sync-viewport", async (req, res) => {
  if (!activeDev?.session.cdpUrl) {
    return res.status(409).json({ ok: false, error: "no_active_session" });
  }

  const panelHint = parsePanelHint(req.body ?? {}) ?? activeDev.panelHint;
  if (panelHint) activeDev.panelHint = panelHint;

  try {
    const cdpUrl = activeDev.session.cdpUrl;
    let page = getCdpPage(cdpUrl);
    if (!page) {
      page = await connectOverCdp(cdpUrl);
    }
    const result = await applyCdpLiveViewViewport(activeDev.activeViewport, {
      panel: panelHint,
      page: page ?? undefined,
      cdpUrl,
    });
    return res.status(200).json({
      ok: result.ok,
      width: result.width,
      height: result.height,
      error: result.error ?? null,
      metrics: result.metrics ?? null,
      active_viewport: activeDev.activeViewport,
      panel: panelHint ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[dev-test] sync-viewport failed:", message);
    return res.status(500).json({ ok: false, error: message });
  }
});

/** GET /api/dev/credits — Firecrawl pool + LLM balances */
devTestRouter.get("/credits", async (_req, res) => {
  const [firecrawlPool, llm] = await Promise.all([getFirecrawlKeyPoolStatus(), fetchLlmCreditUsage()]);

  return res.status(200).json({
    remaining: firecrawlPool.total_remaining,
    firecrawl: {
      remaining: firecrawlPool.total_remaining,
      key_count: firecrawlPool.key_count,
      pool: firecrawlPool,
      error: firecrawlPool.total_remaining == null ? "pool credit sum unavailable" : null,
    },
    llm,
  });
});

/** GET /api/dev/jobs/:id/progress */
devTestRouter.get("/jobs/:id/progress", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ ok: false, error: "job not found" });
  }

  const payload: Record<string, unknown> = {
    ok: true,
    job_id: job.job_id,
    stage: job.stage,
    stage_label: job.stage_label,
    step: job.step,
    progress: job.progress,
    percent: job.percent,
    active_viewport: activeDev?.activeViewport ?? job.viewport ?? "pc",
  };

  const wantLite = req.query.lite === "1" || req.query.lite === "true";

  if (job.stage === "done") {
    if (wantLite) {
      // Capture-watch polls with ?lite=1 — avoid shipping full tree/groups/session.
      payload.status = "awaiting_pick";
      payload.step = job.step;
      payload.capture_url = job.capture_url ?? null;
      payload.capture_width = job.capture_width ?? null;
      payload.capture_height = job.capture_height ?? null;
      payload.candidate_count = job.candidates?.length ?? 0;
      payload.candidates = (job.candidates ?? []).map((c) => ({
        tag_id: c.tag_id,
        capture_status: c.capture_status ?? null,
        overlay_bbox: c.overlay_bbox ?? null,
        element_capture_url: c.element_capture_url ?? null,
      }));
    } else {
      Object.assign(payload, jobPayload(job, activeDev?.sessionId));
    }
  }

  if (job.stage === "failed") {
    payload.status = "failed";
    payload.error = job.error_message ?? "unknown error";
    payload.failure_reason = job.failure_reason;
    payload.llm_source = job.llm_source;
  }

  return res.status(200).json(payload);
});

/** GET /api/dev/sessions/:id — accumulated pages in dev workspace session */
devTestRouter.get("/sessions/:id", (req, res) => {
  if (!getOwnedSession(req, req.params.id)) {
    return res.status(404).json({ ok: false, error: "session_not_found" });
  }
  const session = getSessionResult(req.params.id);
  if (!session) {
    return res.status(404).json({ ok: false, error: "session_not_found" });
  }
  return res.status(200).json({ ok: true, ...session });
});

/** POST /api/dev/analyze — bootstrap + selected viewport tagging */
devTestRouter.post("/analyze", async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!url) {
    return res.status(400).json({ ok: false, error: "url required" });
  }

  if (runningAnalyzeJobId || runningViewportSwitch || runningViewOnlyJobId || isBatchAnalyzeRunning()) {
    return res.status(409).json({
      ok: false,
      error: "pipeline_already_running",
      job_id: runningAnalyzeJobId ?? runningViewOnlyJobId,
    });
  }

  const viewport = parseViewportMode(req.body?.viewport) ?? "pc";
  const panelHint = parsePanelHint(req.body ?? {});
  const llm_model = typeof req.body?.llm_model === "string" ? req.body.llm_model : undefined;
  const sessionIdRaw =
    typeof req.body?.session_id === "string" ? req.body.session_id.trim() : "";
  const analysisSession = resolveAnalysisSession(sessionIdRaw || null);
  const sessionId = analysisSession.session_id;
  const ownerUserId = getRequestUserId(req);

  const { job_id } = startDevAnalyzeJob(url);
  const gen = beginAnalyzePipeline(job_id);

  res.status(200).json({
    ok: true,
    job_id,
    session_id: sessionId,
    status: "started",
    active_viewport: viewport,
  });

  void (async () => {
    try {
      await teardownSession();
      if (isPipelineStale(gen)) return;

      const { response, capturesSettled } = await executeDevAnalyzeJob(job_id, url, {
        llm_model,
        viewport,
        panel: panelHint,
        auth_owner_user_id: ownerUserId,
        onSessionReady: (bootSession) => {
          if (isPipelineStale(gen)) return;
          sessionHold = {
            session: bootSession,
            sessionId,
            jobId: job_id,
            url,
            pageName: url,
            llm_model,
            live_view_url: pickLiveViewUrl(bootSession),
            viewportCache: {},
            activeViewport: viewport,
            panelHint,
          };
        },
      });

      if (isPipelineStale(gen)) return;

      if (!response.ok) {
        updateJobProgress(job_id, { stage: "failed" });
        return;
      }

      const job = getJob(job_id)!;
      syncJobToSession(sessionId, job, url, viewport);

      const snapshot = buildViewportSnapshot(viewport, {
        candidates: job.candidates,
        groups: job.groups,
        candidate_tree: job.candidate_tree,
        html_length: job.html_length ?? response.html_length,
        gnb_hover_opened: job.gnb_hover_opened ?? [],
        llm_source: job.llm_source,
        extract_meta: job.extract_meta,
      });

      // Firecrawl is released after collect (before LLM). Static page/element
      // captures do not need a live session — clear any bootstrap hold.
      sessionHold = null;
      activeDev = null;

      console.log(
        `[dev-test] analyze phase1 done viewport=${viewport} candidates=${job.candidates.length} groups=${job.groups.length} capture=${!!job.capture_url}`
      );

      // Offline PNG crop — no Firecrawl/CDP required.
      await capturesSettled;
      if (isPipelineStale(gen)) return;

      const jobAfterCaptures = getJob(job_id);
      console.log(
        `[dev-test] analyze phase2 done candidates=${jobAfterCaptures?.candidates.length ?? 0} capture_qc_ok=${jobAfterCaptures?.capture_qc?.ok ?? "n/a"}`
      );

      await teardownSession();
    } catch (err) {
      if (isPipelineStale(gen)) return;
      console.error("[dev-test] analyze pipeline error:", err);
      updateJobProgress(job_id, { stage: "failed" });
    } finally {
      if (!isPipelineStale(gen)) {
        runningAnalyzeJobId = null;
      }
    }
  })();
});

/** POST /api/dev/batch-analyze — queue N URLs with concurrent workers */
devTestRouter.post("/batch-analyze", async (req, res) => {
  const rawUrls = req.body?.urls;
  if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
    return res.status(400).json({ ok: false, error: "urls array required" });
  }

  // Allow multiple concurrent batches (PC/MO pool + reanalyze). Only block when a
  // legacy single-job analyze / view-only session holds the interactive pipeline.
  if (runningAnalyzeJobId || runningViewportSwitch || runningViewOnlyJobId) {
    return res.status(409).json({
      ok: false,
      error: "pipeline_already_running",
      job_id: runningAnalyzeJobId ?? runningViewOnlyJobId,
    });
  }

  const viewport = parseViewportMode(req.body?.viewport) ?? "pc";
  const forceAll = req.body?.force === true || req.body?.force_reanalyze === true;
  const forceUrlsRaw = Array.isArray(req.body?.force_urls) ? req.body.force_urls : [];
  const forceUrls = new Set<string>();
  if (forceAll) {
    /* force all below */
  } else {
    for (const u of forceUrlsRaw) {
      if (typeof u === "string" && u.trim()) forceUrls.add(normalizePageUrl(u.trim()));
    }
  }

  const projectId =
    typeof req.body?.project_id === "string" ? req.body.project_id.trim() : "";
  let owned: { userId: string; projectId: string };
  try {
    owned = await requireOwnedProject(req, projectId);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return res
      .status(error === "project_not_found" ? 404 : 400)
      .json({ ok: false, error });
  }
  const userId = owned.userId;
  const sessionIdRaw =
    typeof req.body?.session_id === "string" ? req.body.session_id.trim() : "";
  const analysisSession = resolveAnalysisSession(
    sessionIdRaw || null,
    userId,
    owned.projectId
  );
  const sessionId = analysisSession.session_id;
  if (userId) setSessionOwnerUserId(sessionId, userId);

  const urls: Array<{ url: string; alias?: string; viewport: ViewportMode }> = [];
  for (const entry of rawUrls) {
    if (typeof entry === "string") {
      const url = entry.trim();
      if (url) urls.push({ url, viewport });
      continue;
    }
    if (entry && typeof entry === "object") {
      const url = typeof entry.url === "string" ? entry.url.trim() : "";
      if (!url) continue;
      const alias = typeof entry.alias === "string" ? entry.alias.trim() : undefined;
      const itemViewport = parseViewportMode(entry.viewport) ?? viewport;
      urls.push({ url, alias: alias || undefined, viewport: itemViewport });
      if (entry.force === true) forceUrls.add(normalizePageUrl(url));
    }
  }

  if (!urls.length) {
    return res.status(400).json({ ok: false, error: "no valid urls" });
  }

  if (forceAll) {
    for (const u of urls) forceUrls.add(normalizePageUrl(u.url));
  }

  let cacheHits: Array<{ url: string; viewport: ViewportMode }> = [];
  let urlsToAnalyze = urls;
  if (userId && !forceAll) {
    try {
      const { hits, misses } = await hydrateSessionFromCache(
        sessionId,
        userId,
        owned.projectId,
        urls,
        { forceUrls }
      );
      cacheHits = hits.map((h) => ({ url: h.url, viewport: h.viewport }));
      urlsToAnalyze = misses;
      console.log(
        `[dev-test] cache hits=${hits.length} miss=${misses.length} session=${sessionId.slice(0, 8)}`
      );
    } catch (err) {
      console.warn(
        "[dev-test] cache hydrate failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  // All URLs served from cache — no crawl needed
  if (!urlsToAnalyze.length) {
    return res.status(200).json({
      ok: true,
      batch_id: null,
      session_id: sessionId,
      status: "done",
      concurrency: 0,
      total: urls.length,
      cache_hits: cacheHits.length,
      from_cache: cacheHits,
      items: urls.map((u) => {
        const cachedPage = getAnalysisSession(sessionId)?.pages.find(
            (p) =>
              normalizePageUrl(p.page_url) === normalizePageUrl(u.url) &&
              (p.active_viewport ?? "pc") === u.viewport
          );
        return {
          url: u.url,
          alias: u.alias || tabAliasFromPage(cachedPage),
          viewport: u.viewport,
          status: "done",
          from_cache: true,
          candidate_count: cachedPage?.candidate_count ?? 0,
        };
      }),
      ...sessionPayload(sessionId),
    });
  }

  preemptPipeline();

  const batch = await startBatchAnalyze(sessionId, urlsToAnalyze, viewport, {
    onBatchComplete: async (_batch) => {
      console.log(
        `[dev-test] batch done session=${sessionId.slice(0, 8)} analyzed=${urlsToAnalyze.length} cached=${cacheHits.length}`
      );
    },
  });

  return res.status(200).json({
    ok: true,
    batch_id: batch.batch_id,
    session_id: sessionId,
    status: batch.status,
    concurrency: batch.concurrency,
    total: batch.total + cacheHits.length,
    cache_hits: cacheHits.length,
    from_cache: cacheHits,
    items: [
      ...cacheHits.map((h) => ({
        url: h.url,
        alias: tabAliasFromPage(
          getAnalysisSession(sessionId)?.pages.find(
            (p) =>
              normalizePageUrl(p.page_url) === normalizePageUrl(h.url) &&
              (p.active_viewport ?? "pc") === h.viewport
          )
        ),
        viewport: h.viewport,
        status: "done" as const,
        from_cache: true,
      })),
      ...batch.items,
    ],
  });
});

/** GET /api/dev/batch/:id/progress — poll batch queue status */
devTestRouter.get("/batch/:id/progress", (req, res) => {
  const batch = getBatchAnalyze(req.params.id);
  if (!batch) {
    return res.status(404).json({ ok: false, error: "batch_not_found" });
  }
  return res.status(200).json({
    ok: true,
    ...batch,
    capture_pending: isCapturePhasePending(),
  });
});

/** POST /api/dev/batch/:id/stop — stop a running batch (cancel queue + sessions) */
devTestRouter.post("/batch/:id/stop", (req, res) => {
  const ok = stopBatchAnalyze(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: "batch_not_found" });
  // Also clear single-job analyze locks so the UI can restart immediately.
  preemptPipeline();
  return res.status(200).json({ ok: true, stopped: true });
});

/** POST /api/dev/pipeline/reset — force-clear stuck pipeline_already_running locks */
devTestRouter.post("/pipeline/reset", (_req, res) => {
  const result = forceResetPipelines();
  preemptPipeline();
  return res.status(200).json({ ok: true, ...result });
});

/** POST /api/dev/switch-viewport — PC/MO 전환 + (캐시 없으면) 재태깅 */
devTestRouter.post("/switch-viewport", async (req, res) => {
  const mode = parseViewportMode(req.body?.mode ?? req.body?.viewport);
  if (!mode) {
    return res.status(400).json({ ok: false, error: "mode required (pc|mo)" });
  }

  const ctx = devContext();
  if (!ctx) {
    return res.status(409).json({ ok: false, error: "no_active_session" });
  }

  if (ctx.activeViewport === mode && activeDev) {
    const job = getJob(activeDev.jobId);
    if (!job) return res.status(404).json({ ok: false, error: "job not found" });
    return res.status(200).json({
      ok: true,
      cached: true,
      active_viewport: mode,
      ...jobPayload(job, activeDev.sessionId),
    });
  }

  const cached = ctx.viewportCache[mode];
  if (cached) {
    try {
      promoteSessionHold();
      await applyViewportToBrowser(mode, tagRestoreFromSnapshot(cached));
      applySnapshotToJob(cached);
      console.log(`[dev-test] viewport → ${mode} (cached, ${cached.candidate_count} items)`);
      const job = getJob(activeDev!.jobId)!;
      return res.status(200).json({
        ok: true,
        cached: true,
        active_viewport: mode,
        ...jobPayload(job, activeDev!.sessionId),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[dev-test] switch-viewport cache restore failed:", message);
      return res.status(500).json({ ok: false, error: message });
    }
  }

  const gen = preemptPipeline();
  const dev = promoteSessionHold();
  if (!dev) {
    return res.status(409).json({ ok: false, error: "no_active_session" });
  }

  runningViewportSwitch = true;
  res.status(200).json({
    ok: true,
    started: true,
    job_id: dev.jobId,
    active_viewport: mode,
  });

  const llm_model = dev.llm_model;

  void (async () => {
    const prevMode = dev.activeViewport;
    try {
      if (activeDev?.jobId === dev.jobId) {
        activeDev.lastSwitchError = null;
      }

      const result = await executeViewportRetag(dev.jobId, dev.session, dev.url, mode, { llm_model });
      if (isPipelineStale(gen)) return;

      const snapshot = buildViewportSnapshot(mode, {
        candidates: result.candidates,
        groups: result.groups,
        candidate_tree: result.candidate_tree,
        html_length: result.html_length,
        gnb_hover_opened: result.gnb_hover_opened,
        llm_source: result.llm_source,
        extract_meta: result.meta,
      });

      if (activeDev?.jobId === dev.jobId && !isPipelineStale(gen)) {
        activeDev.viewportCache[mode] = snapshot;
        activeDev.activeViewport = mode;
        activeDev.lastSwitchError = null;
        applySnapshotToJob(snapshot);
        await reconnectCdp();
      }

      console.log(
        `[dev-test] viewport → ${mode} (retagged, ${snapshot.candidate_count} items)`
      );
    } catch (err) {
      if (isPipelineStale(gen)) return;
      const message = err instanceof Error ? err.message : String(err);
      console.error("[dev-test] switch-viewport retag failed:", err);

      const prevCached = dev.viewportCache[prevMode];
      if (prevCached && activeDev?.jobId === dev.jobId) {
        try {
          await applyViewportToBrowser(prevMode, tagRestoreFromSnapshot(prevCached));
          applySnapshotToJob(prevCached);
          activeDev.activeViewport = prevMode;
          activeDev.lastSwitchError = message;
          console.warn(`[dev-test] rolled back to ${prevMode} after ${mode} retag failed`);
        } catch (rollbackErr) {
          console.error("[dev-test] viewport rollback failed:", rollbackErr);
          updateJobProgress(dev.jobId, { stage: "failed" });
        }
      } else {
        updateJobProgress(dev.jobId, { stage: "failed" });
      }
    } finally {
      if (!isPipelineStale(gen)) {
        runningViewportSwitch = false;
      }
    }
  })();
});

/** GET /api/dev/captures/:jobId/tags/:tagId.png — per-element capture (bbox baked in) */
devTestRouter.get("/captures/:jobId/tags/:tagId.png", async (req, res) => {
  const jobId = req.params.jobId?.trim();
  const tagId = Number.parseInt(req.params.tagId ?? "", 10);
  if (!jobId || !Number.isFinite(tagId) || tagId <= 0) {
    return res.status(400).json({ ok: false, error: "invalid_element_capture_path" });
  }
  try {
    const buffer = await readFile(elementCaptureAbsPath(jobId, tagId));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(buffer);
  } catch {
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).type("text/plain").send("element_capture_missing");
  }
});

/** GET /api/dev/captures/:jobId/positions.json — element bbox positions saved at tagging */
devTestRouter.get("/captures/:jobId/positions.json", async (req, res) => {
  const jobId = req.params.jobId?.trim();
  if (!jobId) {
    return res.status(400).json({ ok: false, error: "invalid_job_id" });
  }
  const file = await readPositionsFile(jobId);
  if (!file) {
    return res.status(404).json({ ok: false, error: "positions_missing" });
  }
  return res.status(200).json({ ok: true, ...file });
});

/** POST /api/dev/positions/validate — visually check every saved bbox on a page capture. */
devTestRouter.post("/positions/validate", async (req, res) => {
  const sessionId = String(req.body?.session_id ?? "").trim();
  const jobId = String(req.body?.job_id ?? "").trim();
  const session = getOwnedSession(req, sessionId);
  if (!session) {
    return res.status(403).json({ ok: false, error: "session_not_owned" });
  }
  const page = session.pages.find((item) => item.job_id === jobId);
  if (!page) {
    return res.status(404).json({ ok: false, error: "session_page_not_found" });
  }
  const positionsFile = await readPositionsFile(jobId);
  if (!positionsFile?.positions?.length) {
    return res.status(404).json({ ok: false, error: "positions_missing" });
  }
  try {
    const report = await verifyElementPositionsWithVision({
      jobId,
      viewport: page.active_viewport === "mo" ? "mo" : "pc",
      positions: positionsFile.positions,
    });
    return res.status(200).json({ ok: true, report });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[dev-test] position vision validation failed:", message);
    return res.status(502).json({ ok: false, error: message });
  }
});

/** GET /api/dev/captures/:jobId/:filename — full-page page_view screenshot (pc.png | mo.png) */
devTestRouter.get("/captures/:jobId/:filename", async (req, res) => {
  const jobId = req.params.jobId?.trim();
  const match = /^(pc|mo)\.png$/i.exec(req.params.filename ?? "");
  const viewport = parseViewportMode(match?.[1]);
  if (!jobId || !viewport) {
    return res.status(400).json({ ok: false, error: "invalid_capture_path" });
  }

  try {
    const buffer = await readFile(captureAbsPath(jobId, viewport));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(buffer);
  } catch {
    // Never return JSON here — browsers treat it as a broken <img>.
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).type("text/plain").send("capture_file_missing");
  }
});

/** PUT /api/dev/selection — persist checkbox state */
devTestRouter.put("/selection", async (req, res) => {
  const sessionId =
    typeof req.body?.session_id === "string" ? req.body.session_id.trim() : "";
  const selection = req.body?.selection;
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "session_id required" });
  }
  if (!selection || typeof selection !== "object") {
    return res.status(400).json({ ok: false, error: "selection object required" });
  }

  const patch: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(selection as Record<string, unknown>)) {
    if (typeof v === "boolean") patch[k] = v;
  }

  const ownedSession = getOwnedSession(req, sessionId);
  if (!ownedSession) {
    return res.status(404).json({ ok: false, error: "session_not_found" });
  }

  const session = updateSessionSelection(sessionId, patch);
  if (!session) {
    return res.status(404).json({ ok: false, error: "session_not_found" });
  }

  void persistSessionPageSelection(ownedSession.owner_user_id, sessionId);

  const total = session.pages.reduce((n, p) => n + (p.candidates?.length ?? 0), 0);
  const selected = Object.entries(session.selection ?? {}).filter(([, v]) => v !== false).length;

  return res.status(200).json({
    ok: true,
    session_id: sessionId,
    selection: session.selection,
    selected_count: selected,
    total_count: total,
  });
});

/**
 * PATCH /api/dev/candidates — edit category/action/label/event_name and regroup.
 * Same group key → merge into existing bucket (overwrite/join rule).
 */
devTestRouter.patch("/candidates", async (req, res) => {
  const sessionId =
    typeof req.body?.session_id === "string" ? req.body.session_id.trim() : "";
  const pageUrl =
    typeof req.body?.page_url === "string" ? normalizePageUrl(req.body.page_url.trim()) : "";
  const viewport = parseViewportMode(req.body?.viewport) ?? "pc";
  const tagIdsRaw = req.body?.tag_ids;
  const tagIds = Array.isArray(tagIdsRaw)
    ? tagIdsRaw.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n !== 0)
    : typeof req.body?.tag_id === "number"
      ? [req.body.tag_id]
      : [];

  if (!sessionId) return res.status(400).json({ ok: false, error: "session_id required" });
  if (!pageUrl) return res.status(400).json({ ok: false, error: "page_url required" });
  if (!tagIds.length) return res.status(400).json({ ok: false, error: "tag_ids required" });

  const patch = {
    page_category:
      typeof req.body?.page_category === "string" ? req.body.page_category : undefined,
    action: typeof req.body?.action === "string" ? req.body.action : undefined,
    label: typeof req.body?.label === "string" ? req.body.label : undefined,
    merge_label:
      typeof req.body?.merge_label === "string" ? req.body.merge_label : undefined,
    event_name:
      typeof req.body?.event_name === "string" ? req.body.event_name : undefined,
    link_url:
      typeof req.body?.link_url === "string" || req.body?.link_url === null
        ? req.body.link_url
        : undefined,
    direction:
      typeof req.body?.direction === "string" || req.body?.direction === null
        ? req.body.direction
        : undefined,
  };
  if (
    patch.page_category == null &&
    patch.action == null &&
    patch.label == null &&
    patch.merge_label == null &&
    patch.event_name == null &&
    patch.link_url === undefined &&
    patch.direction === undefined
  ) {
    return res.status(400).json({ ok: false, error: "no_fields_to_patch" });
  }

  const session = getOwnedSession(req, sessionId);
  if (!session) return res.status(404).json({ ok: false, error: "session_not_found" });

  const page = session.pages.find(
    (p) =>
      normalizePageUrl(p.page_url) === pageUrl && (p.active_viewport ?? "pc") === viewport
  );
  if (!page) return res.status(404).json({ ok: false, error: "page_not_found" });

  try {
    const updatedPage = editPageCandidates(page, tagIds, patch);
    replaceSessionPage(sessionId, updatedPage);
    if (updatedPage.job_id) {
      updateJob(updatedPage.job_id, {
        candidates: updatedPage.candidates,
        groups: updatedPage.groups,
        candidate_tree: updatedPage.tree,
      });
    }
    const owner = session.owner_user_id;
    if (owner && session.project_id) {
      await persistPageForUser(
        owner,
        session.project_id,
        updatedPage,
        getAnalysisSession(sessionId)?.selection ?? null
      );
    }
    return res.status(200).json({
      ok: true,
      session_id: sessionId,
      page: updatedPage,
      ...sessionPayload(sessionId),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(400).json({ ok: false, error: msg });
  }
});

/** POST /api/dev/confirm — selected items → taxonomy */
devTestRouter.post("/confirm", async (req, res) => {
  const sessionId =
    typeof req.body?.session_id === "string" ? req.body.session_id.trim() : "";
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "session_id required" });
  }

  const session = getOwnedSession(req, sessionId);
  if (!session?.pages.length) {
    return res.status(404).json({ ok: false, error: "session_not_found" });
  }

  const selection = session.selection ?? {};
  const total = session.pages.reduce((n, p) => n + (p.candidates?.length ?? 0), 0);
  const selectedCandidates = session.pages.flatMap((page) =>
    (page.candidates ?? []).filter((c) => selection[selectionKey(page.page_url, c.tag_id)] !== false)
  );
  const selected = selectedCandidates.length;
  const excluded = total - selected;

  console.log(`[select] total=${total} selected=${selected} excluded=${excluded}`);

  const llm_model = typeof req.body?.llm_model === "string" ? req.body.llm_model : undefined;

  try {
    const describeResult = await describeTaxonomyForCandidates({
      pages: session.pages,
      selection,
      llm_model,
    });

    const taxonomy = buildTaxonomyViewModel({
      session_id: sessionId,
      pages: session.pages,
      selection,
      descriptions: describeResult.registry,
    });

    const snapshotPayload = taxonomyToSnapshotPayload(taxonomy);
    saveTaxonomySnapshot(snapshotPayload);
    setSessionTaxonomy(sessionId, taxonomy);
    if (session.owner_user_id && session.project_id) {
      await saveProjectTaxonomy({
        userId: session.owner_user_id,
        projectId: session.project_id,
        taxonomy,
      });
    }

    return res.status(200).json({
      ok: true,
      session_id: sessionId,
      selected_count: selected,
      excluded_count: excluded,
      total_count: total,
      taxonomy,
      describe: {
        created_events: describeResult.created_events,
        created_properties: describeResult.created_properties,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[dev-test] confirm failed:", message);
    return res.status(500).json({ ok: false, error: message });
  }
});

/**
 * PATCH /api/dev/taxonomy/rows — edit a taxonomy row and synchronize every
 * source candidate represented by that row.
 */
devTestRouter.patch("/taxonomy/rows", async (req, res) => {
  const sessionId =
    typeof req.body?.session_id === "string" ? req.body.session_id.trim() : "";
  const rowKey = typeof req.body?.row_key === "string" ? req.body.row_key.trim() : "";
  if (!sessionId || !rowKey) {
    return res.status(400).json({ ok: false, error: "session_id and row_key required" });
  }
  const session = getOwnedSession(req, sessionId);
  if (!session?.taxonomy) {
    return res.status(404).json({ ok: false, error: "taxonomy_not_confirmed" });
  }
  const sourceRow = session.taxonomy.tabs
    .filter((tab) => tab.kind === "page_category")
    .flatMap((tab) => tab.event_rows)
    .find((row) => row.row_key === rowKey);
  if (!sourceRow) {
    return res.status(404).json({ ok: false, error: "taxonomy_row_not_found" });
  }

  const textPatch = (name: string): string | undefined =>
    typeof req.body?.[name] === "string" ? req.body[name].trim() : undefined;
  const nullablePatch = (name: string): string | null | undefined =>
    req.body?.[name] === null
      ? null
      : typeof req.body?.[name] === "string"
        ? req.body[name].trim()
        : undefined;
  const candidatePatch = {
    page_category: textPatch("page_category"),
    action: textPatch("action"),
    label: textPatch("label"),
    merge_label: textPatch("label"),
    event_name: textPatch("event_name"),
    link_url: nullablePatch("link_url"),
    direction: nullablePatch("direction"),
  };
  const trigger = textPatch("trigger");
  const description = textPatch("description");
  const note = textPatch("note");
  const hasCandidatePatch = Object.values(candidatePatch).some((value) => value !== undefined);
  if (
    !hasCandidatePatch &&
    trigger === undefined &&
    description === undefined &&
    note === undefined
  ) {
    return res.status(400).json({ ok: false, error: "no_fields_to_patch" });
  }

  try {
    const affectedCandidateIds = new Set(sourceRow.members.map((member) => member.candidate_id));
    if (hasCandidatePatch) {
      for (const page of [...session.pages]) {
        const tagIds = (page.candidates ?? [])
          .filter((candidate) => affectedCandidateIds.has(candidate.candidate_id))
          .map((candidate) => candidate.tag_id);
        if (!tagIds.length) continue;
        const updatedPage = editPageCandidates(page, tagIds, candidatePatch);
        replaceSessionPage(sessionId, updatedPage);
        if (updatedPage.job_id) {
          updateJob(updatedPage.job_id, {
            candidates: updatedPage.candidates,
            groups: updatedPage.groups,
            candidate_tree: updatedPage.tree,
          });
        }
        if (session.owner_user_id && session.project_id) {
          await persistPageForUser(
            session.owner_user_id,
            session.project_id,
            updatedPage,
            getAnalysisSession(sessionId)?.selection ?? null
          );
        }
      }
    }

    const descriptions = descriptionsFromTaxonomy(session.taxonomy);
    const taxonomy = buildTaxonomyViewModel({
      session_id: sessionId,
      pages: session.pages,
      selection: session.selection ?? {},
      descriptions,
    });
    for (const tab of taxonomy.tabs) {
      if (tab.kind !== "page_category") continue;
      for (const row of tab.event_rows) {
        const containsEditedCandidate = row.members.some((member) =>
          affectedCandidateIds.has(member.candidate_id)
        );
        if (!containsEditedCandidate) continue;
        row.trigger = trigger ?? sourceRow.trigger;
        row.description = description ?? sourceRow.description;
        row.note = note ?? sourceRow.note;
      }
    }

    setSessionTaxonomy(sessionId, taxonomy);
    saveTaxonomySnapshot(taxonomyToSnapshotPayload(taxonomy));
    if (session.owner_user_id && session.project_id) {
      await saveProjectTaxonomy({
        userId: session.owner_user_id,
        projectId: session.project_id,
        taxonomy,
      });
    }
    return res.status(200).json({
      ok: true,
      session_id: sessionId,
      taxonomy,
      ...sessionPayload(sessionId),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[dev-test] taxonomy row edit failed:", message);
    return res.status(400).json({ ok: false, error: message });
  }
});

/** GET /api/dev/taxonomy — latest taxonomy for session */
devTestRouter.get("/taxonomy", (req, res) => {
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id.trim() : "";
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "session_id required" });
  }
  const session = getOwnedSession(req, sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: "session_not_found" });
  }
  if (!session.taxonomy) {
    return res.status(404).json({ ok: false, error: "taxonomy_not_confirmed" });
  }
  return res.status(200).json({ ok: true, taxonomy: session.taxonomy });
});

/** GET /api/dev/taxonomy/export — Excel download */
devTestRouter.get("/taxonomy/export", async (req, res) => {
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id.trim() : "";
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "session_id required" });
  }
  const session = getOwnedSession(req, sessionId);
  if (!session?.taxonomy) {
    return res.status(404).json({ ok: false, error: "taxonomy_not_confirmed" });
  }
  const buf = await taxonomyToXlsxBuffer(session.taxonomy);
  const filename = `taxonomy-${session.taxonomy.site_key}-${Date.now()}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(buf);
});

/** POST /api/dev/stop */
devTestRouter.post("/stop", async (_req, res) => {
  const had = !!activeDev || !!sessionHold;
  await teardownSession();
  preemptPipeline();
  return res.status(200).json({ ok: true, stopped: had });
});
