/** Taxonomy v3 — page_category tabs, unique event rows, member expansion */

import type { RecommendedTagCandidate } from "./crawl-job.js";
import type { ElementLocation } from "./element-location.js";
import { EVENT_PARAM } from "./event-params.js";

/** All param keys (internal). */
export const TAXONOMY_PARAM_COLUMNS = [
  EVENT_PARAM.PAGE_CATEGORY,
  EVENT_PARAM.PAGE_NAME,
  EVENT_PARAM.PLATFORM,
  EVENT_PARAM.CATEGORY,
  EVENT_PARAM.ACTION,
  EVENT_PARAM.LABEL,
  EVENT_PARAM.LINK_URL,
  EVENT_PARAM.DIRECTION,
  EVENT_PARAM.PAGE_LOCATION,
  EVENT_PARAM.PAGE_PATH,
  EVENT_PARAM.PAGE_TITLE,
  EVENT_PARAM.PAGE_REFERRER,
] as const;

export type TaxonomyParamColumn = (typeof TAXONOMY_PARAM_COLUMNS)[number];

/** Shared variables tab columns. */
export const TAXONOMY_COMMON_VARIABLES = [
  EVENT_PARAM.PLATFORM,
  EVENT_PARAM.PAGE_LOCATION,
  EVENT_PARAM.PAGE_PATH,
  EVENT_PARAM.PAGE_TITLE,
  EVENT_PARAM.PAGE_REFERRER,
  EVENT_PARAM.PAGE_CATEGORY,
  EVENT_PARAM.PAGE_NAME,
] as const;

/** Matrix columns on page_category tabs — category/action/label match tagging tree tiers. */
export const TAXONOMY_MATRIX_COLUMNS = [
  EVENT_PARAM.PLATFORM,
  "category",
  "action",
  EVENT_PARAM.LABEL,
] as const;

export const TAXONOMY_TAB_COMMON = "변수 사전";
export const TAXONOMY_TAB_VALUES = "값 목록";
export const TAXONOMY_TAB_OTHER = "기타";

export type TaxonomyTabKind = "common" | "page_category" | "values";
export type TaxonomyScope = "common" | "pc" | "mo";

export interface TaxonomyEventDescription {
  trigger: string;
  description: string;
  note: string;
}

export interface TaxonomyPropertyDescription {
  description: string;
  note: string;
}

export interface TaxonomyDescriptionsRegistry {
  events: Record<string, TaxonomyEventDescription>;
  properties: Record<string, TaxonomyPropertyDescription>;
}

/** Actual tagging point under a unique event row. */
export interface TaxonomyMemberCandidate {
  tag_id: number;
  candidate_id: string;
  page_url: string;
  label: string | null;
  link_url: string | null;
  /** Full params for payload drawer */
  params: Record<string, string | null>;
  event_name: string;
  /** DOM locator + bbox — same object as transmission JSON & positions.json */
  element_location?: ElementLocation | null;
}

/** Dynamic button label template — one taxonomy row covers all buttons under an action. */
export const TAXONOMY_LABEL_BUTTON_VAR = "{{버튼명}}";

/** Unique event = 1 matrix row (카테고리+액션, 라벨은 변수). */
export interface TaxonomyUniqueEventRow {
  row_key: string;
  page_category: string;
  event_name: string;
  trigger: string;
  description: string;
  note: string;
  platform: string | null;
  /** Tagging tree category tier (cat.display_category) */
  category: string | null;
  category_display: string | null;
  /** Tagging tree action tier (act.display_action) */
  action: string | null;
  action_display: string | null;
  /** Tagging tree label — usually {{버튼명}} for click rows */
  label: string | null;
  /** @deprecated use label */
  label_example?: string | null;
  link_url_example: string | null;
  direction: string | null;
  member_count: number;
  members: TaxonomyMemberCandidate[];
  /** Cropped action screenshot with per-element boxes (served via /api/dev/captures/…) */
  action_image_url?: string | null;
}

export interface TaxonomyCommonVariableRow {
  name: string;
  type: "String" | "Double";
  description: string;
  note: string;
  sample_value: string | null;
  used_events: string[];
}

export interface TaxonomyValueEntry {
  value: string;
  count: number;
}

export interface TaxonomyValueListRow {
  param_name: string;
  values: TaxonomyValueEntry[];
}

export interface TaxonomyCategoryTab {
  kind: "page_category";
  tab_id: string;
  tab_label: string;
  /** Common site navigation, or viewport-specific page taxonomy. */
  scope?: TaxonomyScope;
  event_rows: TaxonomyUniqueEventRow[];
}

export interface TaxonomyCommonTab {
  kind: "common";
  tab_id: "common";
  tab_label: typeof TAXONOMY_TAB_COMMON;
  variable_rows: TaxonomyCommonVariableRow[];
}

export interface TaxonomyValuesTab {
  kind: "values";
  tab_id: "values";
  tab_label: typeof TAXONOMY_TAB_VALUES;
  value_rows: TaxonomyValueListRow[];
}

export type TaxonomyTab = TaxonomyCommonTab | TaxonomyCategoryTab | TaxonomyValuesTab;

export interface TaxonomySummary {
  event_count: number;
  parameter_count: number;
}

export interface TaxonomyColumnLabels {
  action_image?: string;
  event_name?: string;
  category?: string;
  action?: string;
  label?: string;
  trigger?: string;
  description?: string;
}

export interface TaxonomyViewModel {
  version: 3;
  session_id: string;
  site_key: string;
  confirmed_at: string;
  selected_count: number;
  excluded_count: number;
  total_count: number;
  summary: TaxonomySummary;
  tabs: TaxonomyTab[];
  column_labels?: TaxonomyColumnLabels;
}

export interface TaxonomySnapshotPayload {
  site_key: string;
  saved_at: string;
  version: 3;
  summary: TaxonomySummary;
  tabs: TaxonomyTab[];
}

/** @deprecated v2 flat row — kept for snapshot migration only */
export interface TaxonomyEventRow {
  event_name: string;
  tag_id: number;
  candidate_id: string;
  trigger: string;
  description: string;
  note: string;
  location: string;
  params: Record<string, string | null>;
}

/** @deprecated v2 page tab */
export interface TaxonomyPageTab {
  page_url: string;
  page_name: string;
  event_dictionary?: unknown[];
  event_rows: TaxonomyEventRow[];
  parameter_rows?: unknown[];
}

export function formatTaxonomyCell(value: string | null | undefined): string {
  const v = value?.trim();
  return v ? v : "-";
}

export function paramValueFromCandidate(
  c: RecommendedTagCandidate,
  paramName: string
): string | null {
  const hit = c.parameters?.find((p) => p.name === paramName);
  return hit?.value_hint ?? null;
}

export function taxonomyEventDocKey(pageCategory: string, eventName: string): string {
  return `${pageCategory}/${eventName}`;
}

export function buildUniqueEventRowKey(
  pageCategory: string,
  eventName: string,
  category: string | null,
  action: string | null,
  label: string | null,
  direction: string | null
): string {
  return `${pageCategory}|${eventName}|${category?.trim() || "-"}|${action?.trim() || "-"}|${label?.trim() || "-"}|${direction?.trim() || "-"}`;
}
