import type {
  CandidateTree,
  RecommendedTagCandidate,
  TaxonomyCategoryTab,
  TaxonomyCommonTab,
  TaxonomyCommonVariableRow,
  TaxonomyDescriptionsRegistry,
  TaxonomyMemberCandidate,
  TaxonomySnapshotPayload,
  TaxonomySummary,
  TaxonomyTab,
  TaxonomyUniqueEventRow,
  TaxonomyViewModel,
} from "@autotag/shared";
import {
  EVENT_PARAM,
  TAXONOMY_COMMON_VARIABLES,
  TAXONOMY_TAB_COMMON,
  TAXONOMY_TAB_OTHER,
  buildUniqueEventRowKey,
  candidateVisibleInTaggingViewport,
  formatTaxonomyCell,
  labelGroupVisibleInTaggingViewport,
  paramValueFromCandidate,
  selectionKey,
  taggingAreaOf,
  taggingPageCategoryOf,
  taggingParamsRecord,
  buildElementLocation,
  type ElementLocationPageMeta,
} from "@autotag/shared";
import type { PageNode, Platform, ViewportMode } from "@autotag/shared";
import { groupCandidates } from "../crawl/candidate-grouper.js";

export interface BuildTaxonomyInput {
  session_id: string;
  pages: PageNode[];
  selection: Record<string, boolean>;
  descriptions: TaxonomyDescriptionsRegistry;
}

interface EnrichedLabelRow {
  page_url: string;
  page_category: string;
  event_name: string;
  category: string;
  category_display: string;
  action: string;
  action_display: string;
  label: string;
  direction: string | null;
  sort_y: number;
  sort_x: number;
  members: RecommendedTagCandidate[];
  viewport: ViewportMode;
  capture_url: string | null;
  capture_width: number | null;
  capture_height: number | null;
}

function siteKeyFromPages(pages: PageNode[]): string {
  if (!pages.length) return "unknown";
  try {
    const host = new URL(pages[0]!.page_url).hostname.replace(/^www\./, "");
    return host || "unknown";
  } catch {
    return "unknown";
  }
}

function isSelected(
  pageUrl: string,
  tagId: number,
  selection: Record<string, boolean>
): boolean {
  return selection[selectionKey(pageUrl, tagId)] !== false;
}

function candidatesOf(page: PageNode): RecommendedTagCandidate[] {
  return page.candidates ?? [];
}

function candidateMapForPage(page: PageNode): Map<number, RecommendedTagCandidate> {
  return new Map(candidatesOf(page).map((c) => [c.tag_id, c]));
}

function treeForPage(page: PageNode): CandidateTree {
  if (page.tree?.categories?.length) return page.tree;
  return groupCandidates(candidatesOf(page)).tree;
}

function pageCategoryFallback(candidates: RecommendedTagCandidate[]): string | null {
  const pv = candidates.find((c) => c.tag_id === 0);
  if (!pv) return null;
  return (
    paramValueFromCandidate(pv, EVENT_PARAM.PAGE_CATEGORY)?.trim() ??
    pv.label?.trim() ??
    null
  );
}

function paramDirection(c: RecommendedTagCandidate): string | null {
  return paramValueFromCandidate(c, EVENT_PARAM.DIRECTION)?.trim() || null;
}

function paramLinkUrl(c: RecommendedTagCandidate): string | null {
  return paramValueFromCandidate(c, EVENT_PARAM.LINK_URL)?.trim() || null;
}

function normalizeTaxonomyDisplay(value: string): string {
  return value.trim().toUpperCase() === "FNB" ? "Footer" : value.trim();
}

/** 카/액/라 identity — same triple on every analyzed page → 공통. */
function taxonomyCalKey(row: EnrichedLabelRow): string {
  return [
    normalizeTaxonomyDisplay(row.category_display || row.category),
    normalizeTaxonomyDisplay(row.action_display || row.action),
    row.label.trim(),
  ]
    .map((value) => value.toLowerCase())
    .join("\0");
}

function screenIdOf(row: EnrichedLabelRow): string {
  return `${row.page_url}::${row.viewport}`;
}

/**
 * Keys whose 카/액/라 appear on every analyzed screen (page×viewport).
 * No name allowlist (GNB/Footer/푸터) — LLM labels just need to match across screens.
 */
function findCrossScreenCommonKeys(rows: EnrichedLabelRow[]): Set<string> {
  const screens = new Set<string>();
  for (const row of rows) {
    if (row.event_name === "페이지뷰") continue;
    screens.add(screenIdOf(row));
  }
  if (screens.size < 2) return new Set();

  const keyScreens = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.event_name === "페이지뷰") continue;
    const key = taxonomyCalKey(row);
    let set = keyScreens.get(key);
    if (!set) {
      set = new Set();
      keyScreens.set(key, set);
    }
    set.add(screenIdOf(row));
  }

  const common = new Set<string>();
  for (const [key, present] of keyScreens) {
    let all = true;
    for (const screen of screens) {
      if (!present.has(screen)) {
        all = false;
        break;
      }
    }
    if (all) common.add(key);
  }
  return common;
}

/** Merge same 카/액/라 rows from every screen into one taxonomy row. */
function mergeCommonLabelRows(rows: EnrichedLabelRow[]): EnrichedLabelRow {
  const sorted = sortLabelRows(rows);
  const primary = sorted[0]!;
  const members = sorted.flatMap((row) => row.members);
  members.sort((a, b) => a.tag_id - b.tag_id);
  const area = normalizeTaxonomyDisplay(primary.category_display || primary.action_display);
  return {
    ...primary,
    // Common tab: show area as page_category (not a single page's alias).
    page_category: area,
    category: area,
    category_display: area,
    action: normalizeTaxonomyDisplay(primary.action_display),
    action_display: normalizeTaxonomyDisplay(primary.action_display),
    members,
    sort_y: Math.min(...sorted.map((row) => row.sort_y)),
    sort_x: Math.min(...sorted.map((row) => row.sort_x)),
  };
}

function buildParamsForCandidate(
  c: RecommendedTagCandidate,
  _pageCategoryFallbackVal: string | null,
  _pageCategoryDisplay: string,
  _areaDisplay: string,
  _labelDisplay: string,
  pageMeta?: ElementLocationPageMeta
): Record<string, string | null> {
  return taggingParamsRecord(c, pageMeta);
}

function resolvePageCategory(
  c: RecommendedTagCandidate,
  fallback: string | null
): string {
  const fromParam = paramValueFromCandidate(c, EVENT_PARAM.PAGE_CATEGORY)?.trim();
  if (fromParam) return fromParam;
  if (fallback?.trim()) return fallback.trim();
  return TAXONOMY_TAB_OTHER;
}

function collectLabelRowsFromTree(
  pages: PageNode[],
  selection: Record<string, boolean>
): EnrichedLabelRow[] {
  const out: EnrichedLabelRow[] = [];

  for (const page of pages) {
    const viewport: ViewportMode = page.active_viewport ?? "pc";
    const all = candidatesOf(page);
    const fallback = pageCategoryFallback(all);
    const byTag = candidateMapForPage(page);
    const platformOf = (tagId: number): Platform | undefined => byTag.get(tagId)?.platform;

    const tree = treeForPage(page);
    for (const cat of tree.categories) {
      const pageCategoryDisplay = cat.display_category || cat.category;
      for (const act of cat.actions) {
        for (const lg of act.label_groups) {
          if (!labelGroupVisibleInTaggingViewport(lg, viewport, platformOf)) continue;

          const tagIds = lg.member_tag_ids ?? lg.members.map((m) => m.tag_id);
          const selectedTagIds = tagIds.filter((id) => isSelected(page.page_url, id, selection));
          if (!selectedTagIds.length) continue;

          const visibleCandidates = selectedTagIds
            .map((id) => byTag.get(id))
            .filter((c): c is RecommendedTagCandidate => !!c)
            .filter((c) => candidateVisibleInTaggingViewport(c, viewport));
          if (!visibleCandidates.length) continue;

          visibleCandidates.sort((a, b) => a.tag_id - b.tag_id);
          const primary = visibleCandidates[0]!;
          const page_category = normalizeTaxonomyDisplay(taggingPageCategoryOf(primary));
          const isPageView =
            primary.tag_id === 0 ||
            primary.action_key === "page_view" ||
            primary.event_name === "페이지뷰";
          // Pageview: no 카/액/라 — page identity lives in page_name param.
          const areaDisplay = isPageView
            ? ""
            : normalizeTaxonomyDisplay(taggingAreaOf(primary));
          const labelDisplay = isPageView
            ? ""
            : lg.display_label || lg.label || primary.label;
          const event_name =
            primary.event_name?.trim() || (isPageView ? "페이지뷰" : "클릭");

          out.push({
            page_url: page.page_url,
            page_category,
            event_name,
            category: areaDisplay,
            category_display: areaDisplay,
            action: areaDisplay,
            action_display: areaDisplay,
            label: labelDisplay,
            direction: paramDirection(primary),
            sort_y: lg.sort_y,
            sort_x: lg.sort_x,
            members: visibleCandidates,
            viewport,
            capture_url: page.capture_url ?? null,
            capture_width: page.capture_width ?? null,
            capture_height: page.capture_height ?? null,
          });
        }
      }
    }
  }

  return out;
}

/** Label rows for taxonomy matrix — shared with LLM describe step. */
export function collectTaxonomyLabelRows(
  pages: PageNode[],
  selection: Record<string, boolean>
): EnrichedLabelRow[] {
  return collectLabelRowsFromTree(pages, selection);
}

/**
 * Partition into cross-screen common rows (merged) + page-scoped rows.
 * Describe + view model must use the same merged keys so 발생시점/설명 match.
 */
export function partitionTaxonomyLabelRows(labelRows: EnrichedLabelRow[]): {
  commonRows: EnrichedLabelRow[];
  pageRows: EnrichedLabelRow[];
} {
  const commonKeys = findCrossScreenCommonKeys(labelRows);
  const commonGroups = new Map<string, EnrichedLabelRow[]>();
  const pageRows: EnrichedLabelRow[] = [];
  for (const row of labelRows) {
    if (row.event_name !== "페이지뷰" && commonKeys.has(taxonomyCalKey(row))) {
      const key = taxonomyCalKey(row);
      const group = commonGroups.get(key) ?? [];
      group.push(row);
      commonGroups.set(key, group);
      continue;
    }
    pageRows.push(row);
  }
  return {
    commonRows: [...commonGroups.values()].map(mergeCommonLabelRows),
    pageRows,
  };
}

/** Rows the LLM should document — same identity as final taxonomy event rows. */
export function collectTaxonomyRowsForDescribe(
  pages: PageNode[],
  selection: Record<string, boolean>
): EnrichedLabelRow[] {
  const { commonRows, pageRows } = partitionTaxonomyLabelRows(
    collectLabelRowsFromTree(pages, selection)
  );
  return [...commonRows, ...pageRows];
}

function eventDocForRowKey(
  rowKey: string,
  descriptions: TaxonomyDescriptionsRegistry
): { trigger: string; description: string; note: string } | null {
  const exact = descriptions.events[rowKey];
  if (exact?.trigger || exact?.description) {
    return {
      trigger: exact.trigger ?? "",
      description: exact.description ?? "",
      note: exact.note ?? "",
    };
  }
  // Fallback: match by event|cat|action|label|direction (ignore page_category prefix).
  const parts = rowKey.split("|");
  if (parts.length >= 6) {
    const suffix = parts.slice(1).join("|");
    for (const [key, doc] of Object.entries(descriptions.events)) {
      const kp = key.split("|");
      if (kp.length >= 6 && kp.slice(1).join("|") === suffix) {
        if (doc?.trigger || doc?.description) {
          return {
            trigger: doc.trigger ?? "",
            description: doc.description ?? "",
            note: doc.note ?? "",
          };
        }
      }
    }
  }
  return null;
}

function defaultEventDoc(row: EnrichedLabelRow): {
  trigger: string;
  description: string;
  note: string;
} {
  if (row.event_name === "페이지뷰") {
    const page = row.page_category || "페이지";
    return {
      trigger: `${page} 페이지가 로드·노출되었을 때`,
      description: `${page} 페이지 조회를 측정합니다.`,
      note: "-",
    };
  }
  const area = normalizeTaxonomyDisplay(
    row.category_display || row.action_display || "화면"
  );
  const label = row.label.trim() || "요소";
  return {
    trigger: `${area}에서 '${label}'을(를) 클릭했을 때`,
    description: `${area}의 ${label} 클릭을 측정합니다.`,
    note: "-",
  };
}

function pickExample(values: (string | null | undefined)[]): string | null {
  for (const v of values) {
    const t = v?.trim();
    if (t) return t;
  }
  return null;
}

function toMemberCandidate(
  c: RecommendedTagCandidate,
  pageUrl: string,
  pageCategoryFallbackVal: string | null,
  pageCategoryDisplay: string,
  areaDisplay: string,
  labelDisplay: string,
  eventName: string,
  pageMeta: ElementLocationPageMeta
): TaxonomyMemberCandidate {
  return {
    tag_id: c.tag_id,
    candidate_id: c.candidate_id,
    page_url: pageUrl,
    label: labelDisplay,
    link_url: paramLinkUrl(c),
    params: buildParamsForCandidate(
      c,
      pageCategoryFallbackVal,
      pageCategoryDisplay,
      areaDisplay,
      labelDisplay,
      pageMeta
    ),
    event_name: eventName,
    element_location: buildElementLocation(c, pageMeta),
  };
}

function labelRowToUniqueRow(
  row: EnrichedLabelRow,
  pageCategoryFallbackVal: string | null,
  descriptions: TaxonomyDescriptionsRegistry
): TaxonomyUniqueEventRow {
  const row_key = buildUniqueEventRowKey(
    row.page_category,
    row.event_name,
    row.category_display,
    row.action_display,
    row.label,
    row.direction
  );
  const doc = eventDocForRowKey(row_key, descriptions) ?? defaultEventDoc(row);
  const members = row.members
    .map((c) =>
      toMemberCandidate(
        c,
        row.page_url,
        pageCategoryFallbackVal,
        row.category_display,
        row.action_display,
        row.label,
        row.event_name,
        {
          viewport: row.viewport,
          page_width: row.capture_width ?? undefined,
          page_height: row.capture_height ?? undefined,
          capture_url: row.capture_url,
        }
      )
    )
    .sort((a, b) => a.tag_id - b.tag_id);
  const platform = pickExample(members.map((m) => m.params[EVENT_PARAM.PLATFORM]));

  return {
    row_key,
    page_category: normalizeTaxonomyDisplay(row.page_category),
    event_name: row.event_name,
    trigger: doc.trigger,
    description: doc.description,
    note: doc.note,
    platform,
    category: row.category,
    category_display: row.category_display,
    action: row.action,
    action_display: row.action_display,
    label: row.label,
    label_example: row.label,
    link_url_example: pickExample(members.map((m) => m.link_url)),
    direction: row.direction,
    member_count: members.length,
    members,
  };
}

function sortPageCategories(categories: string[]): string[] {
  const others = categories.filter((c) => c === TAXONOMY_TAB_OTHER);
  const rest = categories.filter((c) => c !== TAXONOMY_TAB_OTHER).sort((a, b) => a.localeCompare(b, "ko"));
  return [...rest, ...others];
}

function sortLabelRows(rows: EnrichedLabelRow[]): EnrichedLabelRow[] {
  return [...rows].sort((a, b) => {
    if (a.event_name === "페이지뷰") return -1;
    if (b.event_name === "페이지뷰") return 1;
    if (a.sort_y !== b.sort_y) return a.sort_y - b.sort_y;
    if (a.sort_x !== b.sort_x) return a.sort_x - b.sort_x;
    if (a.event_name !== b.event_name) return a.event_name.localeCompare(b.event_name, "ko");
    if (a.category_display !== b.category_display) {
      return a.category_display.localeCompare(b.category_display, "ko");
    }
    if (a.action_display !== b.action_display) {
      return a.action_display.localeCompare(b.action_display, "ko");
    }
    return a.label.localeCompare(b.label, "ko");
  });
}

function inferParamType(values: (string | null)[]): "String" | "Double" {
  const nonNull = values.filter((v): v is string => !!v?.trim());
  if (!nonNull.length) return "String";
  if (nonNull.every((v) => /^-?\d+(\.\d+)?$/.test(v.trim()))) return "Double";
  return "String";
}

function buildCommonTab(
  rows: EnrichedLabelRow[],
  pages: PageNode[],
  descriptions: TaxonomyDescriptionsRegistry
): TaxonomyCommonTab {
  const enrichedParams: Record<string, string | null>[] = [];
  for (const page of pages) {
    const fallback = pageCategoryFallback(candidatesOf(page));
    for (const row of rows.filter((r) => r.page_url === page.page_url)) {
      for (const c of row.members) {
        enrichedParams.push(
          buildParamsForCandidate(
            c,
            fallback,
            row.category_display,
            row.action_display,
            row.label
          )
        );
      }
    }
  }

  const usedEventsByParam = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const name of TAXONOMY_COMMON_VARIABLES) {
      for (const c of row.members) {
        const val = paramValueFromCandidate(c, name);
        if (!val?.trim()) continue;
        const set = usedEventsByParam.get(name) ?? new Set<string>();
        set.add(row.event_name);
        usedEventsByParam.set(name, set);
      }
    }
  }

  const variable_rows: TaxonomyCommonVariableRow[] = TAXONOMY_COMMON_VARIABLES.map((name) => {
    const values = enrichedParams.map((p) => p[name] ?? null);
    const desc = descriptions.properties[name] ?? { description: "", note: "" };
    return {
      name,
      type: inferParamType(values),
      description: desc.description,
      note: desc.note,
      sample_value: pickExample(values),
      used_events: [...(usedEventsByParam.get(name) ?? [])].sort(),
    };
  });

  return {
    kind: "common",
    tab_id: "common",
    tab_label: TAXONOMY_TAB_COMMON,
    variable_rows,
  };
}

function buildSummary(tabs: TaxonomyTab[]): TaxonomySummary {
  let event_count = 0;
  for (const tab of tabs) {
    if (tab.kind !== "page_category") continue;
    event_count += tab.event_rows.length;
  }
  const commonTab = tabs.find((t): t is TaxonomyCommonTab => t.kind === "common");
  return {
    event_count,
    parameter_count: commonTab?.variable_rows.length ?? TAXONOMY_COMMON_VARIABLES.length,
  };
}

function countIncludedLabelGroups(pages: PageNode[], selection: Record<string, boolean>): number {
  let n = 0;
  for (const page of pages) {
    const viewport: ViewportMode = page.active_viewport ?? "pc";
    const byTag = candidateMapForPage(page);
    const platformOf = (tagId: number): Platform | undefined => byTag.get(tagId)?.platform;
    const tree = treeForPage(page);
    for (const cat of tree.categories) {
      for (const act of cat.actions) {
        for (const lg of act.label_groups) {
          if (!labelGroupVisibleInTaggingViewport(lg, viewport, platformOf)) continue;
          const tagIds = lg.member_tag_ids ?? lg.members.map((m) => m.tag_id);
          if (!tagIds.some((id) => isSelected(page.page_url, id, selection))) continue;
          n += 1;
        }
      }
    }
  }
  return n;
}

export function buildTaxonomyViewModel(input: BuildTaxonomyInput): TaxonomyViewModel {
  const total = input.pages.reduce((n, p) => n + candidatesOf(p).length, 0);
  const labelRows = collectLabelRowsFromTree(input.pages, input.selection);
  const selectedCount = countIncludedLabelGroups(input.pages, input.selection);
  const siteKey = siteKeyFromPages(input.pages);

  const fallbackByPage = new Map(
    input.pages.map((p) => [p.page_url, pageCategoryFallback(candidatesOf(p))])
  );

  const { commonRows, pageRows } = partitionTaxonomyLabelRows(labelRows);
  const commonEventTab: TaxonomyCategoryTab = {
    kind: "page_category",
    tab_id: "events:common",
    tab_label: "공통",
    scope: "common",
    event_rows: sortLabelRows(commonRows).map((row) =>
      labelRowToUniqueRow(row, fallbackByPage.get(row.page_url) ?? null, input.descriptions)
    ),
  };

  const categoryTabs: TaxonomyCategoryTab[] = [];
  for (const viewport of ["pc", "mo"] as const) {
    const viewportRows = pageRows.filter((row) => row.viewport === viewport);
    const pageCategories = sortPageCategories([
      ...new Set(viewportRows.map((row) => row.page_category)),
    ]);
    for (const page_category of pageCategories) {
      const tabRows = sortLabelRows(
        viewportRows.filter((row) => row.page_category === page_category)
      );
    const event_rows = tabRows.map((r) =>
      labelRowToUniqueRow(r, fallbackByPage.get(r.page_url) ?? null, input.descriptions)
    );
      categoryTabs.push({
        kind: "page_category",
        tab_id: `${viewport}:${page_category}`,
        tab_label: page_category,
        scope: viewport,
        event_rows,
      });
    }
  }

  const commonTab = buildCommonTab(labelRows, input.pages, input.descriptions);
  // No "값 목록" tab — link_url / direction / count lists removed from taxonomy UI.
  const tabs: TaxonomyTab[] = [commonEventTab, ...categoryTabs, commonTab];
  const summary = buildSummary(tabs);

  return {
    version: 3,
    session_id: input.session_id,
    site_key: siteKey,
    confirmed_at: new Date().toISOString(),
    selected_count: selectedCount,
    excluded_count: total - selectedCount,
    total_count: total,
    summary,
    tabs,
  };
}

export function taxonomyToSnapshotPayload(vm: TaxonomyViewModel): TaxonomySnapshotPayload {
  return {
    site_key: vm.site_key,
    saved_at: vm.confirmed_at,
    version: 3,
    summary: vm.summary,
    tabs: vm.tabs,
  };
}

/** Flat row for Excel export (unique event row) — slim columns. */
export function uniqueEventRowToFlatRecord(row: TaxonomyUniqueEventRow): Record<string, string> {
  const isPageView = row.event_name === "페이지뷰";
  const category = isPageView
    ? ""
    : normalizeTaxonomyDisplay(row.category_display ?? row.category ?? "");
  const action = isPageView
    ? ""
    : normalizeTaxonomyDisplay(row.action_display ?? row.action ?? "");
  const label = isPageView ? "" : row.label ?? row.label_example ?? "";
  return {
    이벤트명: row.event_name,
    시점: row.trigger || "-",
    카테고리: isPageView ? "-" : formatTaxonomyCell(category),
    액션: isPageView ? "-" : formatTaxonomyCell(action),
    라벨: isPageView ? "-" : formatTaxonomyCell(label),
    설명: row.description || "-",
  };
}

export type { TaxonomyCommonTab };
