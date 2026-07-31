import { PAGE_VIEW_EVENT_NAME } from "./event-registry.js";
import { buildPageViewEventParameters, type EventParameter } from "./event-params.js";
import type { EventType } from "./schema.js";
import type { Platform } from "./viewport.js";
import type { PageContextSnapshot } from "./page-context.js";
import { inferPageCategoryHint } from "./page-context.js";
import { buildCanonicalPageViewFields, normalizePageCategory } from "./tagging-canonical.js";
/** Sentinel tag_id for synthetic page_view row (not a DOM element). */
export const PAGE_VIEW_TAG_ID = 0;

export const PAGE_VIEW_ACTION = "page_view";

/** True for synthetic page_view row (tag_id 0) — never DOM-merged. */
export function isPageViewCandidate(c: { tag_id?: number; action?: string }): boolean {
  return c.tag_id === PAGE_VIEW_TAG_ID || c.action === PAGE_VIEW_ACTION;
}

export function buildPageViewParameters(
  ctx: PageContextSnapshot,
  pageCategory: string,
  platform: Platform
): EventParameter[] {
  return buildPageViewEventParameters(ctx, pageCategory, platform);
}

export interface PageViewCandidateInput {
  candidate_id: string;
  state_id: string;
  pageContext: PageContextSnapshot;
  page_category: string;
  platform: Platform;
}

/** Build page_view row for workspace / extract pipeline output. */
export function buildPageViewCandidate(input: PageViewCandidateInput): {
  candidate_id: string;
  tag_id: number;
  state_id: string;
  text: string;
  role: null;
  parental_context: string;
  selector_hint: string;
  selectors_fallback: string[];
  selector_stability: "high";
  recommended_data_hook: null;
  overlay_bbox: null;
  page_category: string;
  category: string;
  action: string;
  action_key: string;
  label: string;
  event_name: string;
  event_type: EventType;
  parameters: EventParameter[];
  picked: boolean;
  platform: Platform;
} {
  const category = normalizePageCategory(
    input.page_category.trim() || inferPageCategoryHint(input.pageContext)
  );
  const canonical = buildCanonicalPageViewFields(category, input.pageContext, input.platform);
  const pageName = canonical.page_category || category;

  return {
    candidate_id: input.candidate_id,
    tag_id: PAGE_VIEW_TAG_ID,
    state_id: input.state_id,
    text: pageName,
    role: null,
    parental_context: "page",
    selector_hint: "document",
    selectors_fallback: [],
    selector_stability: "high",
    recommended_data_hook: null,
    overlay_bbox: null,
    page_category: canonical.page_category ?? category,
    category: canonical.category ?? category,
    action: canonical.action ?? "",
    action_key: canonical.action_key ?? "page_view",
    label: "",
    event_name: PAGE_VIEW_EVENT_NAME,
    event_type: "page",
    parameters: canonical.parameters,
    picked: false,
    platform: input.platform,
  };
}