import type { DomLandmark } from "./dom-path.js";
import type { SnapshotCandidate, SnapshotSuggestion } from "./snapshot-pipeline.js";

/** True when href is a real navigation target (not empty / hash / javascript). */
export function isValidNavLink(href: string | null | undefined): boolean {
  if (!href) return false;
  const h = href.trim();
  if (!h || h === "#" || h.startsWith("#") || /^javascript:/i.test(h)) return false;
  return true;
}

/**
 * Normalize href for destination comparison.
 * Keeps host + pathname + search so external logos (samsung.com vs kurly.com)
 * and query variants (?id=1 vs ?id=2) do not collapse incorrectly.
 */
export function normalizeNavLinkPath(href: string, baseUrl = "https://local/"): string {
  if (!isValidNavLink(href)) return "";
  try {
    const u = new URL(href, baseUrl);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const path = u.pathname || "/";
    const search = u.search || "";
    return `${host}${path}${search}`;
  } catch {
    return (href.split("#")[0] ?? "").trim();
  }
}

export interface LinkDedupLog {
  kept: number;
  removed: number;
  reason: "same_href";
  url: string;
}

export interface SameHrefDedupResult<T extends { tag_id: number }> {
  entries: T[];
  removedTagIds: number[];
  logs: LinkDedupLog[];
}

export interface SameHrefDedupHooks {
  getElement: (tagId: number) => unknown | null;
  contains: (ancestorTagId: number, descendantTagId: number) => boolean;
  resolveHref: (tagId: number) => string;
  leafPriority: (tagId: number) => number;
  isWrapperToExclude?: (tagId: number) => boolean;
}

/**
 * Detect ancestor/descendant pairs that share a valid href (wrapper pattern).
 * Does NOT remove tag_ids — all members are kept for tagging; merge groups them in the tree.
 */
export function dedupeBySameHref<T extends { tag_id: number }>(
  entries: T[],
  hooks: SameHrefDedupHooks
): SameHrefDedupResult<T> {
  const loggedPairs = new Set<string>();
  const logs: LinkDedupLog[] = [];

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const ea = entries[i]!;
      const eb = entries[j]!;
      const aContainsB = hooks.contains(ea.tag_id, eb.tag_id);
      const bContainsA = hooks.contains(eb.tag_id, ea.tag_id);
      if (!aContainsB && !bContainsA) continue;

      const hrefA = hooks.resolveHref(ea.tag_id);
      const hrefB = hooks.resolveHref(eb.tag_id);
      if (!hrefA || !hrefB || hrefA !== hrefB) continue;

      const drop =
        aContainsB && !bContainsA
          ? ea.tag_id
          : bContainsA && !aContainsB
            ? eb.tag_id
            : hooks.leafPriority(ea.tag_id) >= hooks.leafPriority(eb.tag_id)
              ? eb.tag_id
              : ea.tag_id;
      const kept = drop === ea.tag_id ? eb.tag_id : ea.tag_id;

      const pairKey = [kept, drop].sort((x, y) => x - y).join(":");
      if (!loggedPairs.has(pairKey)) {
        loggedPairs.add(pairKey);
        logs.push({ kept, removed: drop, reason: "same_href", url: hrefA });
      }
    }
  }

  return {
    entries: [...entries],
    removedTagIds: [],
    logs,
  };
}

export function formatLinkDedupLog(log: LinkDedupLog): string {
  return `[dedup] kept=${log.kept} wrapper_pair=${log.removed} reason=ancestor_same_href url="${log.url}" (tag_ids preserved)`;
}

/** Collapse whitespace for category comparison. */
export function normalizeCategoryDisplay(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** Compact key: no spaces, lowercase — for fuzzy category grouping. */
export function compactCategoryKey(name: string): string {
  return normalizeCategoryDisplay(name).replace(/\s+/g, "").toLowerCase();
}

/** Section group key: same landmark + same section heading → one category bucket. */
export function sectionGroupKey(
  landmark: DomLandmark | null | undefined,
  sectionHeading: string | null | undefined
): string | null {
  const section = normalizeCategoryDisplay(sectionHeading ?? "");
  if (!section) return null;
  return `${landmark ?? "content"}|${compactCategoryKey(section)}`;
}

/**
 * Pick shortest category whose compact form is a prefix of all others in the group.
 * e.g. "추천 상품" unifies "추천상품 리스트", "추천 상품 리스트".
 */
export function pickCanonicalCategory(categories: string[]): string {
  const cleaned = categories.map(normalizeCategoryDisplay).filter((c) => c.length >= 2);
  if (cleaned.length === 0) return "unknown";
  if (cleaned.length === 1) return cleaned[0]!;

  const withKeys = cleaned.map((c) => ({ c, key: compactCategoryKey(c) }));
  withKeys.sort((a, b) => a.key.length - b.key.length || a.c.length - b.c.length);

  for (const candidate of withKeys) {
    if (withKeys.every((other) => other.key.startsWith(candidate.key) || candidate.key.startsWith(other.key))) {
      return candidate.c;
    }
  }

  const counts = new Map<string, number>();
  for (const { c } of withKeys) {
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best = withKeys[0]!.c;
  let bestCount = 0;
  for (const [c, n] of counts) {
    if (n > bestCount || (n === bestCount && c.length < best.length)) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

/** Unify LLM categories within the same landmark + section_heading group. */
export function unifyCategoriesInSuggestions(
  suggestions: SnapshotSuggestion[],
  candidatesByTagId: Map<number, SnapshotCandidate>
): SnapshotSuggestion[] {
  const groups = new Map<string, SnapshotSuggestion[]>();

  for (const s of suggestions) {
    const c = candidatesByTagId.get(s.tag_id);
    const key = sectionGroupKey(c?.dom_path?.landmark, c?.dom_path?.section_heading);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  const canonicalByTag = new Map<number, string>();
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const canonical = pickCanonicalCategory(group.map((s) => s.category));
    for (const s of group) {
      canonicalByTag.set(s.tag_id, canonical);
    }
  }

  if (canonicalByTag.size === 0) return suggestions;

  return suggestions.map((s) => {
    const canonical = canonicalByTag.get(s.tag_id);
    if (!canonical || canonical === s.category) return s;
    return { ...s, category: canonical };
  });
}
