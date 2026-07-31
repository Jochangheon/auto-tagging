import { normalizePageUrl } from "./page-session.js";
import type { RecommendedTagCandidate } from "./crawl-job.js";

/** Selection map key: normalizedPageUrl::tagId */
export function selectionKey(pageUrl: string, tagId: number): string {
  return `${normalizePageUrl(pageUrl)}::${tagId}`;
}

export function parseSelectionKey(key: string): { pageUrl: string; tagId: number } | null {
  const idx = key.lastIndexOf("::");
  if (idx <= 0) return null;
  const pageUrl = key.slice(0, idx);
  const tagId = Number.parseInt(key.slice(idx + 2), 10);
  if (!Number.isFinite(tagId)) return null;
  return { pageUrl, tagId };
}

/** Default: all candidates selected */
export function defaultSelected(_c: RecommendedTagCandidate): boolean {
  return true;
}

export function buildDefaultSelection(
  pageUrl: string,
  candidates: RecommendedTagCandidate[]
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const c of candidates) {
    out[selectionKey(pageUrl, c.tag_id)] = true;
  }
  return out;
}

export function mergeSelection(
  existing: Record<string, boolean>,
  pageUrl: string,
  candidates: RecommendedTagCandidate[]
): Record<string, boolean> {
  const next = { ...existing };
  for (const c of candidates) {
    const key = selectionKey(pageUrl, c.tag_id);
    if (!(key in next)) {
      next[key] = true;
    }
  }
  return next;
}
