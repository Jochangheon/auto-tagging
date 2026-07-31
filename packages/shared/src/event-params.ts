import type { Platform } from "./viewport.js";
import type { PageContextSnapshot } from "./page-context.js";

/** Canonical analytics parameter keys — LLM must not invent new keys. */
export const EVENT_PARAM = {
  PLATFORM: "platform",
  PAGE_LOCATION: "page_location",
  PAGE_PATH: "page_path",
  PAGE_TITLE: "page_title",
  PAGE_REFERRER: "page_referrer",
  PAGE_CATEGORY: "page_category",
  /** Pageview-only: human page name (alias). Not used on click events. */
  PAGE_NAME: "page_name",
  CATEGORY: "category",
  ACTION: "action",
  LABEL: "label",
  LINK_URL: "link_url",
  DIRECTION: "direction",
} as const;

export type EventParamName = (typeof EVENT_PARAM)[keyof typeof EVENT_PARAM];

export interface EventParameter {
  name: EventParamName | string;
  value_hint: string | null;
}

const ALLOWED_LLM_CLICK_EXTRAS = new Set<string>([EVENT_PARAM.DIRECTION]);

/** Strip LLM-generated keys outside the allowlist (detail goes in fixed keys). */
export function filterLlmClickExtras(
  params: { name: string; value_hint: string | null }[]
): EventParameter[] {
  return params.filter((p) => ALLOWED_LLM_CLICK_EXTRAS.has(p.name));
}

function dedupeParams(params: EventParameter[]): EventParameter[] {
  const seen = new Set<string>();
  const out: EventParameter[] = [];
  for (const p of params) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(p);
  }
  return out;
}

/** All events: platform + page URL facts (when available). */
export function buildBaseEventParameters(opts: {
  platform: Platform;
  pageContext?: PageContextSnapshot;
}): EventParameter[] {
  const out: EventParameter[] = [{ name: EVENT_PARAM.PLATFORM, value_hint: opts.platform }];
  if (opts.pageContext) {
    out.push(
      { name: EVENT_PARAM.PAGE_LOCATION, value_hint: opts.pageContext.page_location },
      { name: EVENT_PARAM.PAGE_PATH, value_hint: opts.pageContext.page_path },
      { name: EVENT_PARAM.PAGE_TITLE, value_hint: opts.pageContext.page_title || null }
    );
  }
  return out;
}

export function buildPageViewEventParameters(
  ctx: PageContextSnapshot,
  pageCategory: string,
  platform: Platform
): EventParameter[] {
  const pageName = pageCategory.trim() || "페이지";
  // Pageview: no category / action / label — page identity is page_name.
  return dedupeParams([
    { name: EVENT_PARAM.PLATFORM, value_hint: platform },
    { name: EVENT_PARAM.PAGE_LOCATION, value_hint: ctx.page_location },
    { name: EVENT_PARAM.PAGE_PATH, value_hint: ctx.page_path },
    { name: EVENT_PARAM.PAGE_TITLE, value_hint: ctx.page_title || null },
    { name: EVENT_PARAM.PAGE_REFERRER, value_hint: ctx.page_referrer || null },
    { name: EVENT_PARAM.PAGE_CATEGORY, value_hint: pageName },
    { name: EVENT_PARAM.PAGE_NAME, value_hint: pageName },
  ]);
}

/** Click events: base + page category + area(action) + label + link_url + optional direction. */
export function buildClickEventParameters(opts: {
  page_category: string;
  action: string;
  label: string;
  platform: Platform;
  pageContext?: PageContextSnapshot;
  link_url?: string | null;
  llmExtras?: { name: string; value_hint: string | null }[];
}): EventParameter[] {
  const page_category = opts.page_category.trim() || "페이지";
  const action = opts.action.trim() || "기타";
  const extras = filterLlmClickExtras(opts.llmExtras ?? []);
  return dedupeParams([
    ...buildBaseEventParameters({ platform: opts.platform, pageContext: opts.pageContext }),
    { name: EVENT_PARAM.PAGE_CATEGORY, value_hint: page_category },
    { name: EVENT_PARAM.CATEGORY, value_hint: page_category },
    { name: EVENT_PARAM.ACTION, value_hint: action },
    { name: EVENT_PARAM.LABEL, value_hint: opts.label },
    { name: EVENT_PARAM.LINK_URL, value_hint: opts.link_url ?? null },
    ...extras,
  ]);
}
