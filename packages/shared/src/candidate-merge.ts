import { EVENT_PARAM } from "./event-params.js";
import {
  compactCategoryKey,
  isValidNavLink,
  normalizeNavLinkPath,
} from "./candidate-link-dedup.js";
import { groupingActionBucketKey } from "./display-labels.js";
import { isPageViewCandidate } from "./page-view.js";
import { taggingAreaOf, taggingPageCategoryOf } from "./tagging-canonical.js";
import type { RecommendedTagCandidate } from "./crawl-job.js";

export interface MergeCandidateLike {
  tag_id: number;
  label?: string;
  text?: string;
  merge_label?: string;
  page_category?: string;
  /** Page tab name */
  category: string;
  /** Screen area display */
  action: string;
  action_key?: string;
  event_name?: string | null;
  /** Direct link when present (preferred over parameters). */
  link_url?: string | null;
  parameters?: { name: string; value_hint: string | null }[];
}

export interface MergeLog {
  kept: number;
  merged: number[];
  reason: "same_href" | "same_merge_label";
  url?: string;
  label?: string;
}

export interface SkippedMergeLog {
  kept: number;
  other: number;
  reason: "diff_page_category" | "diff_area" | "diff_merge_label";
  label: string;
  detail?: string;
}

/** link_url from assembled click parameters or direct field. */
export function getCandidateLinkUrl(
  c: MergeCandidateLike,
  baseUrl = "https://local/"
): string {
  const direct = typeof c.link_url === "string" ? c.link_url.trim() : "";
  if (direct && isValidNavLink(direct)) {
    return normalizeNavLinkPath(direct, baseUrl);
  }
  const p = c.parameters?.find(
    (x) => x.name === EVENT_PARAM.LINK_URL || x.name === "link_url"
  );
  const raw = p?.value_hint;
  if (!raw || !isValidNavLink(raw)) return "";
  return normalizeNavLinkPath(raw, baseUrl);
}

/** Raw LLM merge_label — no code-side normalization. */
export function mergeLabelKey(c: MergeCandidateLike): string {
  return (c.merge_label ?? "").trim();
}

export function mergeDisplayLabel(c: MergeCandidateLike): string {
  const label = (c.label || c.text || "").trim();
  return label || "(버튼명 없음)";
}

function mergePageCategoryKey(c: MergeCandidateLike): string {
  if (c.page_category?.trim()) return c.page_category.trim();
  return c.category?.trim() || "";
}

function mergeAreaKey(c: MergeCandidateLike): string {
  return (c.action || "").trim();
}

/** Tree area tier key — same 영역 only when compact key matches. */
export function mergeCategoryKey(c: MergeCandidateLike): string {
  return compactCategoryKey(c.action || c.category);
}

/** Optional action/event bucket — LLM action_key or event_name only. */
export function mergeActionKey(c: MergeCandidateLike): string {
  return groupingActionBucketKey({
    action: c.action_key || c.action,
    action_key: c.action_key,
    event_name: c.event_name,
  });
}

/**
 * Merge iff same merge_label AND destinations are compatible:
 * - both missing link_url → merge when same page+area
 * - both have link_url → merge only when destinations match
 * - one missing link_url → merge when same page+area (incomplete capture)
 * Different valid destinations never merge.
 */
export function canMergeCandidates(a: MergeCandidateLike, b: MergeCandidateLike): boolean {
  const mergeA = mergeLabelKey(a);
  const mergeB = mergeLabelKey(b);
  if (!mergeA || !mergeB || mergeA !== mergeB) return false;

  const hrefA = getCandidateLinkUrl(a);
  const hrefB = getCandidateLinkUrl(b);

  // Different destinations → always keep separate (성공사례 로고 등).
  if (hrefA && hrefB && hrefA !== hrefB) return false;

  const pageA = mergePageCategoryKey(a);
  const pageB = mergePageCategoryKey(b);
  const areaA = mergeAreaKey(a);
  const areaB = mergeAreaKey(b);
  if (pageA === pageB && areaA === areaB) return true;

  // Same destination can merge even across slight area naming drift.
  if (hrefA && hrefB && hrefA === hrefB) return true;

  return false;
}

function pickPrimaryMember<T extends MergeCandidateLike>(members: T[]): T {
  return [...members].sort((a, b) => a.tag_id - b.tag_id)[0]!;
}

/** Group display: uniform merge_label when present, else shortest raw label. */
function pickDisplayLabelFromMembers<T extends MergeCandidateLike>(members: T[]): string {
  const mergeLabels = members.map((m) => mergeLabelKey(m)).filter(Boolean);
  if (mergeLabels.length === members.length) {
    const unique = new Set(mergeLabels);
    if (unique.size === 1) return mergeLabels[0]!;
  }

  const labels = members.map(mergeDisplayLabel).filter((l) => l && l !== "(버튼명 없음)");
  if (!labels.length) return "(버튼명 없음)";
  const unique = [...new Set(labels)];
  if (unique.length === 1) return unique[0]!;
  unique.sort((a, b) => a.length - b.length || a.localeCompare(b, "ko"));
  return unique[0]!;
}

function mergeReason(a: MergeCandidateLike, b: MergeCandidateLike): MergeLog["reason"] {
  const hrefA = getCandidateLinkUrl(a);
  const hrefB = getCandidateLinkUrl(b);
  if (hrefA && hrefB && hrefA === hrefB) return "same_href";
  return "same_merge_label";
}

function logHrefSkip(
  a: MergeCandidateLike,
  b: MergeCandidateLike,
  skipLogs: SkippedMergeLog[],
  skipPairs: Set<string>
): void {
  const hrefA = getCandidateLinkUrl(a);
  const hrefB = getCandidateLinkUrl(b);
  if (!hrefA || !hrefB || hrefA !== hrefB) return;

  const pairKey = [a.tag_id, b.tag_id].sort((x, y) => x - y).join(":");
  if (skipPairs.has(pairKey)) return;

  if (mergePageCategoryKey(a) !== mergePageCategoryKey(b)) {
    skipPairs.add(pairKey);
    skipLogs.push({
      kept: a.tag_id,
      other: b.tag_id,
      reason: "diff_page_category",
      label: mergeDisplayLabel(a),
      detail: `${mergePageCategoryKey(a)} vs ${mergePageCategoryKey(b)}`,
    });
    return;
  }

  if (mergeAreaKey(a) !== mergeAreaKey(b)) {
    skipPairs.add(pairKey);
    skipLogs.push({
      kept: a.tag_id,
      other: b.tag_id,
      reason: "diff_area",
      label: mergeDisplayLabel(a),
      detail: `${mergeAreaKey(a)} vs ${mergeAreaKey(b)}`,
    });
  }
}

/**
 * Cluster candidates by merge rules (union-find).
 * Same merge_label + (same page/area OR same href) → merge.
 */
export function clusterCandidatesByMerge<T extends MergeCandidateLike>(
  members: T[]
): { clusters: T[][]; mergeLogs: MergeLog[]; skipLogs: SkippedMergeLog[] } {
  const domMembers = members.filter((m) => !isPageViewCandidate(m));
  const n = domMembers.length;
  if (n === 0) return { clusters: [], mergeLogs: [], skipLogs: [] };

  const parent = domMembers.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  };

  const mergeLogs: MergeLog[] = [];
  const skipLogs: SkippedMergeLog[] = [];
  const skipPairs = new Set<string>();

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = domMembers[i]!;
      const b = domMembers[j]!;

      logHrefSkip(a, b, skipLogs, skipPairs);

      if (canMergeCandidates(a, b)) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) {
          union(i, j);
          const reason = mergeReason(a, b);
          const kept = Math.min(a.tag_id, b.tag_id);
          const merged = [a.tag_id, b.tag_id].filter((id) => id !== kept);
          mergeLogs.push({
            kept,
            merged,
            reason,
            url: reason === "same_href" ? getCandidateLinkUrl(a) : undefined,
            label: mergeLabelKey(a) || undefined,
          });
        }
        continue;
      }

      const hrefA = getCandidateLinkUrl(a);
      const hrefB = getCandidateLinkUrl(b);
      if (hrefA || hrefB) continue;

      const labelA = mergeLabelKey(a);
      const labelB = mergeLabelKey(b);
      if (labelA && labelA === labelB && mergeAreaKey(a) !== mergeAreaKey(b)) {
        const pairKey = [a.tag_id, b.tag_id].sort((x, y) => x - y).join(":");
        if (!skipPairs.has(pairKey)) {
          skipPairs.add(pairKey);
          skipLogs.push({
            kept: a.tag_id,
            other: b.tag_id,
            reason: "diff_area",
            label: mergeDisplayLabel(a),
            detail: `${mergeAreaKey(a)} vs ${mergeAreaKey(b)}`,
          });
        }
      }
    }
  }

  const buckets = new Map<number, T[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = buckets.get(root) ?? [];
    list.push(domMembers[i]!);
    buckets.set(root, list);
  }

  const clusters = [...buckets.values()].map((cluster) =>
    [...cluster].sort((a, b) => a.tag_id - b.tag_id)
  );

  return { clusters, mergeLogs, skipLogs };
}

export function formatMergeLog(log: MergeLog): string {
  if (log.reason === "same_href") {
    return `[merge] kept=${log.kept} merged=[${log.merged.join(", ")}] reason=same_href url="${log.url ?? ""}"`;
  }
  return `[merge] kept=${log.kept} merged=[${log.merged.join(", ")}] reason=same_merge_label merge_label="${log.label ?? ""}"`;
}

export function formatSkippedMergeLog(log: SkippedMergeLog): string {
  if (log.reason === "diff_page_category") {
    return `[merge] kept=${log.kept} skipped_diff_page_category button="${log.label}" (${log.detail ?? ""})`;
  }
  if (log.reason === "diff_area") {
    return `[merge] kept=${log.kept} skipped_diff_area button="${log.label}" (${log.detail ?? ""})`;
  }
  return `[merge] kept=${log.kept} skipped_diff_merge_label button="${log.label}" (${log.detail ?? ""})`;
}

/** Adapt RecommendedTagCandidate for merge helpers. */
export function asMergeCandidate(c: RecommendedTagCandidate): MergeCandidateLike {
  const linkFromParams = c.parameters?.find(
    (p) => p.name === EVENT_PARAM.LINK_URL || p.name === "link_url"
  )?.value_hint;
  return {
    tag_id: c.tag_id,
    label: c.label,
    text: c.text,
    merge_label: c.merge_label,
    page_category: taggingPageCategoryOf(c),
    category: c.category,
    action: taggingAreaOf(c),
    action_key: c.action_key,
    event_name: c.event_name,
    link_url: linkFromParams ?? null,
    parameters: c.parameters,
  };
}

export { pickPrimaryMember, pickDisplayLabelFromMembers };
