import { randomUUID } from "node:crypto";
import type { CandidateGroup, CandidateTree, RecommendedTagCandidate, SnapshotSuggestion, ViewportMode } from "@autotag/shared";
import {
  buildPageViewCandidate,
  inferPageCategoryHint,
  withLandmark,
  actionFromEventName,
  unifyCategoriesInSuggestions,
  applyBannerCategoryHints,
  isBannerDomContext,
  canonicalBannerCategory,
  applyCanonicalTaggingFields,
  resolveTaggingPageCategory,
  reconcileHiddenReasonWithBbox,
  type PageContextSnapshot,
} from "@autotag/shared";
import type { HiddenReason } from "@autotag/shared";
import { htmlToTaggedMarkdown, candidatesToMarkdown } from "../snapshot/md-converter.js";
import { hydrateSnapshot, findByTagId } from "../snapshot/hydrate.js";
import {
  analyzeExtractWithLlm,
  type ExtractLlmBatchMeta,
  type LlmProvider,
  type PipelineStageCounts,
} from "../llm/client.js";
import type { LiveTagEntry, TagLiveDomStats } from "./tag-live-dom.js";
import { liveEntriesToSnapshotCandidates } from "./live-tag-adapter.js";
import {
  buildSelectorFromCheerio,
  domPathContextFromCheerio,
  linkUrlFromCheerio,
  resolveNavLinkFromCheerio,
  parentalContextFromCheerio,
} from "./selector-from-cheerio.js";
import { groupCandidates, type GroupCandidatesResult } from "./candidate-grouper.js";
import { computeCandidatePlatformStats, filterEntriesByViewport } from "./platform-classifier.js";
import { collectPageContextFromHtml } from "./collect-page-context.js";
import { dedupeLiveEntriesBeforeExtract } from "./candidate-entry-dedup.js";

export interface ExtractPipelineInput {
  html: string;
  entries: LiveTagEntry[];
  state_id: string;
  source_url?: string;
  llm_model?: string;
  tag_stats?: TagLiveDomStats;
  menu_path_by_tag_id?: Record<number, import("./tag-live-dom.js").MenuRevealPathStep[]>;
  page_context?: PageContextSnapshot;
  viewport?: ViewportMode;
  /** User URL-list alias (e.g. "메인") — overrides LLM page_category for taxonomy. */
  page_category_override?: string;
  /** Returns true once the user has stopped the job — aborts the LLM batches. */
  cancelCheck?: () => boolean;
  onNamingProgress?: (current: number, total: number) => void;
  onGroupingProgress?: (current: number, total: number) => void;
}

export interface ExtractPipelineResult {
  candidates: RecommendedTagCandidate[];
  groups: CandidateGroup[];
  tree: CandidateTree;
  group_count: number;
  llm_source: LlmProvider;
  markdown_length: number;
  meta: ExtractLlmBatchMeta;
  page_category?: string;
  page_context?: PageContextSnapshot;
}

export async function runExtractPipeline(
  input: ExtractPipelineInput
): Promise<ExtractPipelineResult> {
  const doc = hydrateSnapshot(input.html);
  const pageContext =
    input.page_context ??
    (input.source_url ? collectPageContextFromHtml(input.html, input.source_url) : undefined);
  const categoryOverride = input.page_category_override?.trim() || undefined;
  const pageCategoryHint =
    categoryOverride || (pageContext ? inferPageCategoryHint(pageContext) : undefined);
  const viewportPlatform: ViewportMode = input.viewport ?? "pc";

  const linkByTagId = buildLinkUrlMap(doc, input.entries, input.source_url);

  const { entries: dedupedEntries } = dedupeLiveEntriesBeforeExtract(
    doc,
    input.entries,
    input.source_url
  );
  const viewportEntries = filterEntriesByViewport(dedupedEntries, viewportPlatform);

  const snapshotCandidates = enrichCandidatesWithDomPath(
    doc,
    liveEntriesToSnapshotCandidates(viewportEntries, linkByTagId),
    viewportEntries,
    linkByTagId
  );

  if (snapshotCandidates.length === 0) {
    const emptyStages = buildPipelineStageCounts(
      input.tag_stats ?? { raw_matched: 0, tagged: 0, dropped_cap: 0 },
      0,
      0,
      []
    );
    const pageOnly: RecommendedTagCandidate[] = [];
    if (pageContext) {
      pageOnly.push(
        buildPageViewCandidate({
          candidate_id: `${input.state_id}-page-view-${randomUUID().slice(0, 8)}`,
          state_id: input.state_id,
          pageContext,
          page_category: pageCategoryHint ?? "페이지",
          platform: viewportPlatform === "mo" ? "MO" : "PC",
        })
      );
    }
    return {
      candidates: pageOnly,
      groups: [],
      tree: {
        categories: [],
        member_total: 0,
        category_count: 0,
        action_count: 0,
        label_group_count: 0,
      },
      group_count: 0,
      llm_source: resolveExtractLlmSource(),
      markdown_length: 0,
      meta: {
        candidates_total_input: 0,
        candidates_succeeded: 0,
        dropped: [],
        llm_calls_made: 0,
        splits_occurred: 0,
        pipeline_stage_counts: emptyStages,
      },
      page_category: pageCategoryHint,
      page_context: pageContext,
    };
  }

  const markdown = `${htmlToTaggedMarkdown(doc)}\n\n${candidatesToMarkdown(snapshotCandidates)}`;

  const candidateTotal = snapshotCandidates.length;
  input.onNamingProgress?.(0, candidateTotal);

  const { suggestions, llm_source, meta, page_category: llmPageCategory } = await analyzeExtractWithLlm({
    version: input.state_id,
    markdown,
    candidates: snapshotCandidates,
    url: input.source_url,
    stageTitle: pageContext?.page_title,
    pageContext,
    pageCategoryHint,
    llm_model: input.llm_model,
  }, {
    cancelCheck: input.cancelCheck,
    onBatchComplete: (current, total) => {
      input.onNamingProgress?.(current, total);
    },
  });

  const candidatesByTagId = new Map(snapshotCandidates.map((c) => [c.tag_id, c]));
  const unifiedSuggestions = applyBannerCategoryHints(
    unifyCategoriesInSuggestions(suggestions, candidatesByTagId),
    candidatesByTagId
  );

  const llmNamedOutput = unifiedSuggestions.filter((s) => s.event_name?.length > 0).length;
  const pipeline_stage_counts = buildPipelineStageCounts(
    input.tag_stats ?? { raw_matched: viewportEntries.length, tagged: viewportEntries.length, dropped_cap: 0 },
    snapshotCandidates.length,
    llmNamedOutput,
    meta.dropped
  );

  logPipelineStages(pipeline_stage_counts);

  const suggestionByTag = new Map(unifiedSuggestions.map((s) => [s.tag_id, s]));
  const candidates: RecommendedTagCandidate[] = [];
  const pageCategory = categoryOverride || llmPageCategory?.trim() || pageCategoryHint || "페이지";

  for (const entry of viewportEntries) {
    const rawSuggestion =
      suggestionByTag.get(entry.tag_id) ?? buildEntryFallbackSuggestion(entry);
    const suggestion = normalizeSuggestionFromDom(rawSuggestion, entry);
    const platform = (entry.platform === "MO" || entry.platform === "PC"
      ? entry.platform
      : viewportPlatform === "mo"
        ? "MO"
        : "PC") as import("@autotag/shared").Platform;

    const $el = findByTagId(doc, entry.tag_id);
    const selectorPkg = $el
      ? buildSelectorFromCheerio(doc.$, $el.get(0)!)
      : {
          selector_hint: `[data-tag-id="${entry.tag_id}"]`,
          selectors_fallback: [],
          selector_stability: "high" as const,
          recommended_data_hook: null,
        };

    const parental_context = $el
      ? parentalContextFromCheerio(doc.$, $el.get(0)!)
      : "";

    const baseCandidate: RecommendedTagCandidate = {
      candidate_id: `${input.state_id}-${entry.tag_id}-${randomUUID().slice(0, 8)}`,
      tag_id: entry.tag_id,
      state_id: input.state_id,
      text: entry.text,
      role: inferRole(entry.tag),
      parental_context,
      selector_hint: selectorPkg.selector_hint,
      selectors_fallback: selectorPkg.selectors_fallback,
      selector_stability: selectorPkg.selector_stability,
      recommended_data_hook: selectorPkg.recommended_data_hook,
      overlay_bbox: entry.bbox,
      hidden_reason: reconcileHiddenReasonWithBbox(
        (entry.visibility?.hidden_reason ?? inferHiddenReason(entry.bbox)) as HiddenReason,
        entry.bbox
      ),
      platform: entry.platform ?? "All",
      platform_reason: entry.platform_reason,
      menu_reveal_path:
        entry.menu_reveal_path ?? input.menu_path_by_tag_id?.[entry.tag_id],
      category: pageCategory,
      action: suggestion.category,
      action_key: suggestion.action,
      label: suggestion.label,
      event_name: suggestion.event_name,
      event_type: "click",
      parameters: [],
      picked: false,
    };

    candidates.push(
      applyCanonicalTaggingFields(baseCandidate, {
        page_category: resolveTaggingPageCategory(pageCategory, suggestion.category),
        area_raw: suggestion.category,
        label: suggestion.label,
        merge_label: suggestion.merge_label,
        event_name: suggestion.event_name,
        action_key: suggestion.action,
        platform,
        pageContext,
        link_url: linkByTagId.get(entry.tag_id) ?? null,
        llmExtras: suggestion.parameters ?? [],
      })
    );
  }

  if (pageContext) {
    candidates.unshift(
      buildPageViewCandidate({
        candidate_id: `${input.state_id}-page-view-${randomUUID().slice(0, 8)}`,
        state_id: input.state_id,
        pageContext,
        page_category: pageCategory,
        platform: viewportPlatform === "mo" ? "MO" : "PC",
      })
    );
  }

  input.onGroupingProgress?.(0, candidates.length);

  const grouped: GroupCandidatesResult = groupCandidates(candidates);

  const platformStats = computeCandidatePlatformStats(candidates);
  console.log(
    `[platform] pipeline distribution PC=${platformStats.PC} MO=${platformStats.MO} ` +
      `All=${platformStats.All} total=${platformStats.total}`
  );

  const llmDropped = meta.dropped.length;
  console.log(
    `[정합성] extract-pipeline entries=${viewportEntries.length} candidates=${candidates.length} ` +
      `tree categories=${grouped.tree.category_count} actions=${grouped.tree.action_count} ` +
      `labels=${grouped.tree.label_group_count} llm_synthesized=${llmDropped}`
  );
  // page_view candidate (tag_id 0) is synthesized, not a DOM entry — exclude from parity check.
  const domCandidateCount = candidates.filter((c) => c.tag_id !== 0).length;
  if (domCandidateCount !== viewportEntries.length) {
    console.error(
      `[정합성 ERROR] extract-pipeline dom_candidates(${domCandidateCount}) !== entries(${viewportEntries.length})`
    );
  }

  return {
    candidates,
    groups: grouped.groups,
    tree: grouped.tree,
    group_count: grouped.tree.label_group_count,
    llm_source,
    markdown_length: markdown.length,
    meta: {
      ...meta,
      pipeline_stage_counts,
    },
    page_category: pageCategory,
    page_context: pageContext,
  };
}

function buildPipelineStageCounts(
  tagStats: TagLiveDomStats,
  llmInput: number,
  llmNamedOutput: number,
  dropped: ExtractLlmBatchMeta["dropped"]
): PipelineStageCounts {
  const dropped_by_reason: Record<string, number> = {};
  for (const d of dropped) {
    dropped_by_reason[d.reason] = (dropped_by_reason[d.reason] ?? 0) + 1;
  }

  return {
    raw_dom_matched: tagStats.raw_matched,
    tag_id_assigned: tagStats.tagged,
    llm_input: llmInput,
    llm_named_output: llmNamedOutput,
    dropped: dropped.length,
    dropped_by_reason,
  };
}

function logPipelineStages(stages: PipelineStageCounts): void {
  const reasonStr = Object.entries(stages.dropped_by_reason)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
  console.log(
    `[autotag] pipeline stages: (a)=${stages.raw_dom_matched} (b)=${stages.tag_id_assigned} ` +
      `(c)=${stages.llm_input} (d)=${stages.llm_named_output} (e)=${stages.dropped} ` +
      `dropped={${reasonStr || "none"}}`
  );
}

function buildEntryFallbackSuggestion(entry: LiveTagEntry): import("@autotag/shared").SnapshotSuggestion {
  const name = entry.text.trim();
  const revealedViaMenu = (entry.menu_reveal_path?.length ?? 0) > 0;
  let areaRaw = "unknown";
  if (entry.dom_path && isBannerDomContext(entry.dom_path)) {
    areaRaw = canonicalBannerCategory(entry.dom_path);
  } else if (entry.dom_path?.landmark === "gnb" || revealedViaMenu) {
    // MO drawer items often lack header landmark — menu path is enough for GNB.
    areaRaw = "global/gnb";
  } else if (entry.dom_path?.landmark === "fnb") {
    areaRaw = "global/fnb";
  } else if (entry.platform_reason?.includes("fixed-bottom-nav")) {
    areaRaw = "global/fnb";
  } else if (entry.dom_path?.section_heading?.trim()) {
    areaRaw = entry.dom_path.section_heading.trim();
  }

  const actionKey =
    areaRaw === "global/gnb" ? "click_gnb" : areaRaw === "global/fnb" ? "click_fnb" : actionFromEventName("클릭");

  const label =
    isBannerDomContext(entry.dom_path) && /^배너\d*$/i.test(name)
      ? "배너"
      : name || "[button]";

  return {
    tag_id: entry.tag_id,
    category: areaRaw,
    action: actionKey,
    label,
    merge_label: label,
    event_name: "클릭",
    rationale: "ambiguous — manual review (pipeline_fallback)",
    parameters: [],
  };
}

/** Landmark / layout signals override vague LLM areas (배너, unknown). */
function normalizeSuggestionFromDom(
  suggestion: SnapshotSuggestion,
  entry: LiveTagEntry
): SnapshotSuggestion {
  let category = suggestion.category?.trim() || "unknown";
  const landmark = entry.dom_path?.landmark;
  const revealedViaMenu = (entry.menu_reveal_path?.length ?? 0) > 0;

  if (landmark === "gnb" || revealedViaMenu) category = "global/gnb";
  else if (landmark === "fnb") category = "global/fnb";
  else if (entry.platform_reason?.includes("fixed-bottom-nav")) category = "global/fnb";

  const vague =
    category === "unknown" ||
    category === "배너" ||
    category === "메인 배너" ||
    category === "banner" ||
    category === "hero";

  if (
    vague &&
    !revealedViaMenu &&
    entry.dom_path?.section_heading?.trim() &&
    !isBannerDomContext(entry.dom_path)
  ) {
    category = entry.dom_path.section_heading.trim();
  }

  let action = suggestion.action;
  if (category === "global/gnb") action = "click_gnb";
  else if (category === "global/fnb") action = "click_fnb";

  if (category === suggestion.category && action === suggestion.action) return suggestion;
  return { ...suggestion, category, action };
}

function resolveExtractLlmSource(): LlmProvider {
  const forced = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (forced === "mock") {
    throw new Error("LLM_PROVIDER=mock is no longer supported");
  }
  if (forced === "gemini") return "gemini";
  return "openrouter";
}

function inferHiddenReason(bbox: LiveTagEntry["bbox"]): HiddenReason {
  if (!bbox || (bbox.w <= 0 && bbox.h <= 0)) return "zero_size";
  return "visible";
}

function inferRole(tag: string): string | null {
  if (tag === "button") return "button";
  if (tag === "a") return "link";
  if (tag === "input") return "textbox";
  return null;
}

function enrichCandidatesWithDomPath(
  doc: ReturnType<typeof hydrateSnapshot>,
  candidates: ReturnType<typeof liveEntriesToSnapshotCandidates>,
  entries: LiveTagEntry[],
  linkByTagId: Map<number, string | null>
): ReturnType<typeof liveEntriesToSnapshotCandidates> {
  return candidates.map((c) => {
    const entry = entries.find((e) => e.tag_id === c.tag_id);
    const link_url = linkByTagId.get(c.tag_id) ?? c.link_url ?? null;
    if (entry?.dom_path?.dom_path) {
      return { ...c, dom_path: withLandmark(entry.dom_path), link_url };
    }
    const $el = findByTagId(doc, c.tag_id);
    if ($el) {
      return {
        ...c,
        dom_path: withLandmark(domPathContextFromCheerio(doc.$, $el.get(0)!)),
        link_url: link_url ?? resolveNavLinkFromCheerio(doc.$, $el.get(0)!, undefined),
      };
    }
    return { ...c, link_url };
  });
}

function buildLinkUrlMap(
  doc: ReturnType<typeof hydrateSnapshot>,
  entries: LiveTagEntry[],
  sourceUrl?: string
): Map<number, string | null> {
  const map = new Map<number, string | null>();
  for (const entry of entries) {
    const $el = findByTagId(doc, entry.tag_id);
    let href: string | null = null;
    if ($el) {
      href = resolveNavLinkFromCheerio(doc.$, $el.get(0)!, sourceUrl);
    }
    if (!href) {
      href = extractHrefFromHints(entry.identification_hints, sourceUrl);
    }
    map.set(entry.tag_id, href);
  }
  return map;
}

function extractHrefFromHints(hints: string | undefined, baseUrl?: string): string | null {
  if (!hints) return null;
  const m = hints.match(/(?:^|\|)\s*href=([^\s|]+)/i);
  if (!m?.[1]) return null;
  const raw = m[1].trim();
  if (!raw || raw === "#" || /^javascript:/i.test(raw)) return null;
  try {
    const resolved = new URL(raw, baseUrl || "https://example.local/");
    if (baseUrl) {
      try {
        const base = new URL(baseUrl);
        if (resolved.origin === base.origin) {
          return resolved.pathname + resolved.search;
        }
      } catch {
        /* absolute */
      }
    }
    return resolved.origin + resolved.pathname + resolved.search;
  } catch {
    return raw.startsWith("/") ? raw : `/${raw}`;
  }
}
