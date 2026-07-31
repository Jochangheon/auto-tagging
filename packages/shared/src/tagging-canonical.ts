/**
 * Canonical tagging shape — single source of truth for UI, taxonomy, and transmission JSON.
 *
 * category  = 페이지명 (tab, e.g. 메인)
 * action    = 화면 영역 (e.g. GNB, 배너, 추천 상품)
 * label     = 버튼/링크 이름
 */
import type { RecommendedTagCandidate } from "./crawl-job.js";
import { formatCategoryDisplay } from "./display-labels.js";
import {
  buildElementLocation,
  type ElementLocation,
  type ElementLocationPageMeta,
} from "./element-location.js";
import {
  buildClickEventParameters,
  buildPageViewEventParameters,
  EVENT_PARAM,
  type EventParameter,
} from "./event-params.js";
import type { Platform } from "./viewport.js";
import type { PageContextSnapshot } from "./page-context.js";
import { paramValueFromCandidate } from "./taxonomy.js";

const INTERNAL_ACTION_KEYS = new Set([
  "click",
  "slide_nav",
  "page_view",
  "add_wishlist",
  "interact",
]);

/** Payload sent to analytics / shown in tagging JSON drawer. */
export interface TaggingTransmissionPayload {
  event_name: string;
  page_category: string;
  /** Pageview only — human page name. Absent on click events. */
  page_name?: string | null;
  /** Click events only — not set on pageview. */
  category?: string | null;
  action?: string | null;
  label?: string | null;
  platform?: string | null;
  link_url?: string | null;
  direction?: string | null;
  page_location?: string | null;
  page_path?: string | null;
  page_title?: string | null;
  page_referrer?: string | null;
  /** DOM locator + bbox — shared with positions.json for capture/review */
  element_location?: ElementLocation | null;
}

export interface AssembleTaggingCandidateInput {
  page_category: string;
  /** LLM area field (suggestion.category) */
  area_raw: string;
  label: string;
  merge_label: string;
  event_name: string;
  /** Internal merge key (click, slide_nav, …) */
  action_key: string;
  platform: Platform;
  pageContext?: PageContextSnapshot;
  link_url?: string | null;
  llmExtras?: { name: string; value_hint: string | null }[];
}

export function normalizeAreaDisplay(areaRaw: string): string {
  const trimmed = areaRaw.trim();
  if (!trimmed) return "기타";
  return formatCategoryDisplay(trimmed);
}

export function normalizePageCategory(pageCategory: string): string {
  const trimmed = pageCategory.trim();
  return trimmed || "페이지";
}

/** GNB/Footer are taxonomy-wide tabs — not the page alias (e.g. "메인"). */
export function globalNavPageCategoryFromArea(areaRaw: string): string | null {
  const key = areaRaw.trim().toLowerCase();
  if (key.startsWith("global/gnb")) return "GNB";
  if (key.startsWith("global/fnb")) return "Footer";
  return null;
}

/** Pick page tab: GNB/Footer override alias; otherwise use page name. */
export function resolveTaggingPageCategory(pageCategory: string, areaRaw: string): string {
  const nav = globalNavPageCategoryFromArea(areaRaw);
  if (nav) return nav;
  return normalizePageCategory(pageCategory);
}

/** Build canonical parameters array for a click candidate. */
export function buildCanonicalClickParameters(
  input: AssembleTaggingCandidateInput
): EventParameter[] {
  const page_category = normalizePageCategory(input.page_category);
  const action = normalizeAreaDisplay(input.area_raw);
  return buildClickEventParameters({
    page_category,
    action,
    label: input.label,
    platform: input.platform,
    pageContext: input.pageContext,
    link_url: input.link_url,
    llmExtras: input.llmExtras,
  });
}

/** Apply canonical category/action/label + parameters to a workspace candidate. */
export function applyCanonicalTaggingFields(
  candidate: RecommendedTagCandidate,
  input: AssembleTaggingCandidateInput
): RecommendedTagCandidate {
  const page_category = normalizePageCategory(input.page_category);
  const action = normalizeAreaDisplay(input.area_raw);
  return {
    ...candidate,
    page_category,
    category: page_category,
    action,
    action_key: input.action_key,
    label: input.label,
    merge_label: input.merge_label.trim() || input.label.trim(),
    event_name: input.event_name,
    parameters: buildCanonicalClickParameters(input),
  };
}

/** Read page tab name from candidate (canonical fields first). */
export function taggingPageCategoryOf(c: RecommendedTagCandidate): string {
  if (c.page_category?.trim()) return c.page_category.trim();
  const fromParam = paramValueFromCandidate(c, EVENT_PARAM.PAGE_CATEGORY)?.trim();
  if (fromParam) return fromParam;
  if (c.category?.trim()) return c.category.trim();
  return "기타";
}

/** Read screen area from candidate (canonical action field). */
export function taggingAreaOf(c: RecommendedTagCandidate): string {
  // Pageview has no category/action/label — area is not used.
  if (c.tag_id === 0 || c.action_key === "page_view") {
    return "";
  }
  const rawAction = c.action?.trim();
  if (rawAction && !INTERNAL_ACTION_KEYS.has(rawAction)) return rawAction;
  const fromParam = paramValueFromCandidate(c, EVENT_PARAM.ACTION)?.trim();
  if (fromParam) return fromParam;
  const legacyArea = paramValueFromCandidate(c, EVENT_PARAM.CATEGORY)?.trim();
  if (legacyArea && legacyArea !== taggingPageCategoryOf(c)) return legacyArea;
  return "기타";
}

/** Internal grouping key for merge/tree bucketing. */
export function taggingActionKeyOf(c: RecommendedTagCandidate): string {
  return c.action_key?.trim() || c.action?.trim() || "click";
}

/** Build transmission JSON from canonical candidate fields. */
export function buildTaggingTransmissionPayload(
  c: RecommendedTagCandidate,
  pageMeta?: ElementLocationPageMeta
): TaggingTransmissionPayload {
  const page_category = taggingPageCategoryOf(c);
  const isPageView = c.tag_id === 0 || c.action_key === "page_view";
  const params = Object.fromEntries(
    (c.parameters ?? []).map((p) => [p.name, p.value_hint ?? null])
  ) as Record<string, string | null>;

  if (isPageView) {
    const pageName =
      params[EVENT_PARAM.PAGE_NAME]?.trim() ||
      page_category ||
      "페이지";
    return {
      event_name: c.event_name?.trim() || "페이지뷰",
      page_category,
      page_name: pageName,
      // No category / action / label / element_location on pageview.
      platform: params[EVENT_PARAM.PLATFORM] ?? c.platform ?? null,
      page_location: params[EVENT_PARAM.PAGE_LOCATION] ?? null,
      page_path: params[EVENT_PARAM.PAGE_PATH] ?? null,
      page_title: params[EVENT_PARAM.PAGE_TITLE] ?? null,
      page_referrer: params[EVENT_PARAM.PAGE_REFERRER] ?? null,
    };
  }

  const action = taggingAreaOf(c);
  const label = (c.label || c.text || "").trim();
  return {
    event_name: c.event_name?.trim() || "클릭",
    page_category,
    category: page_category,
    action,
    label,
    platform: params[EVENT_PARAM.PLATFORM] ?? c.platform ?? null,
    link_url: params[EVENT_PARAM.LINK_URL] ?? null,
    direction: params[EVENT_PARAM.DIRECTION] ?? null,
    page_location: params[EVENT_PARAM.PAGE_LOCATION] ?? null,
    page_path: params[EVENT_PARAM.PAGE_PATH] ?? null,
    page_title: params[EVENT_PARAM.PAGE_TITLE] ?? null,
    page_referrer: params[EVENT_PARAM.PAGE_REFERRER] ?? null,
    element_location: buildElementLocation(c, pageMeta),
  };
}

/** Params record for taxonomy member drawer (same keys as transmission payload, minus nested location). */
export function taggingParamsRecord(
  c: RecommendedTagCandidate,
  pageMeta?: ElementLocationPageMeta
): Record<string, string | null> {
  const payload = buildTaggingTransmissionPayload(c, pageMeta);
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "event_name" || k === "element_location") continue;
    if (v == null || String(v).trim() === "") continue;
    out[k] = String(v).trim();
  }
  return out;
}

export function buildCanonicalPageViewFields(
  page_category: string,
  pageContext: PageContextSnapshot,
  platform: Platform
): Pick<
  RecommendedTagCandidate,
  "page_category" | "category" | "action" | "action_key" | "label" | "parameters"
> {
  const pageCat = normalizePageCategory(page_category);
  return {
    page_category: pageCat,
    // Keep page_category for tab identity; do not mirror into 카/액/라.
    category: pageCat,
    action: "",
    action_key: "page_view",
    label: "",
    parameters: buildPageViewEventParameters(pageContext, pageCat, platform),
  };
}
