/**
 * Persist / hydrate PageNode for a logged-in user (fast JSONB path).
 */
import type { PageNode, ViewportMode } from "@autotag/shared";
import { normalizePageUrl, selectionKey } from "@autotag/shared";
import { isDatabaseConfigured } from "./pool.js";
import {
  getPageAnalysis,
  listPageAnalysesForUrls,
  upsertPageAnalysis,
  updatePageAnalysisPayload,
  type PageAnalysisRow,
} from "./page-analyses.js";
import {
  getAnalysisSession,
  upsertSessionPage,
  updateSessionSelection,
  type AnalysisSession,
} from "../crawl/job-store.js";

export async function persistPageForUser(
  userId: string | null | undefined,
  projectId: string | null | undefined,
  page: PageNode,
  selection?: Record<string, boolean> | null
): Promise<void> {
  if (!userId || !projectId || !isDatabaseConfigured()) return;
  try {
    await upsertPageAnalysis({ userId, projectId, page, selection: selection ?? null });
  } catch (err) {
    console.warn(
      "[db] persist page failed:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function persistSessionPageSelection(
  userId: string | null | undefined,
  sessionId: string
): Promise<void> {
  if (!userId || !isDatabaseConfigured()) return;
  const session = getAnalysisSession(sessionId);
  if (!session?.selection || !session.project_id) return;

  // Group selection keys by page and upsert selection slice per page
  for (const page of session.pages) {
    const norm = normalizePageUrl(page.page_url);
    const vp = (page.active_viewport ?? "pc") as ViewportMode;
    const slice: Record<string, boolean> = {};
    for (const [key, val] of Object.entries(session.selection)) {
      if (key.startsWith(`${norm}::`)) slice[key] = val;
    }
    try {
      await updatePageAnalysisPayload({
        userId,
        projectId: session.project_id,
        pageUrl: norm,
        viewport: vp,
        page,
        selection: Object.keys(slice).length ? slice : session.selection,
      });
    } catch (err) {
      console.warn(
        "[db] persist selection failed:",
        err instanceof Error ? err.message : err
      );
    }
  }
}

export type CachedUrlHit = {
  url: string;
  viewport: ViewportMode;
  page: PageNode;
  selection: Record<string, boolean> | null;
  from_cache: true;
};

/** Batch lookup cached analyses for URLs (one query). */
export async function loadCachedPagesForUrls(
  userId: string,
  projectId: string,
  urls: Array<{ url: string; viewport?: ViewportMode }>
): Promise<CachedUrlHit[]> {
  if (!isDatabaseConfigured() || !urls.length) return [];
  const rows = await listPageAnalysesForUrls(userId, projectId, urls);
  return rows.map((row) => ({
    url: row.page_url_norm,
    viewport: (row.viewport || "pc") as ViewportMode,
    page: row.payload,
    selection: row.selection,
    from_cache: true as const,
  }));
}

export async function hydrateSessionFromCache<
  T extends { url: string; alias?: string; viewport?: ViewportMode },
>(
  sessionId: string,
  userId: string,
  projectId: string,
  urls: T[],
  opts?: { forceUrls?: Set<string> }
): Promise<{ hits: CachedUrlHit[]; misses: T[] }> {
  const force = opts?.forceUrls ?? new Set<string>();
  const toLookup = urls.filter((u) => {
    const key = `${normalizePageUrl(u.url)}::${u.viewport ?? "pc"}`;
    return !force.has(key) && !force.has(normalizePageUrl(u.url));
  });

  const hits = await loadCachedPagesForUrls(userId, projectId, toLookup);
  const hitKeys = new Set(
    hits.map((h) => `${normalizePageUrl(h.url)}::${h.viewport}`)
  );

  for (const hit of hits) {
    const page: PageNode = {
      ...hit.page,
      page_url: normalizePageUrl(hit.url),
      active_viewport: hit.viewport,
    };
    // Preserve alias override from request if provided
    const req = urls.find(
      (u) =>
        normalizePageUrl(u.url) === page.page_url &&
        (u.viewport ?? "pc") === hit.viewport
    );
    if (req?.alias) {
      page.page_name = req.alias;
    }
    upsertSessionPage(sessionId, page);
    if (hit.selection) {
      updateSessionSelection(sessionId, hit.selection);
    } else {
      // Ensure default selection keys exist
      const sel: Record<string, boolean> = {};
      for (const c of page.candidates || []) {
        sel[selectionKey(page.page_url, c.tag_id)] = c.selected !== false;
      }
      updateSessionSelection(sessionId, sel);
    }
  }

  const misses = urls.filter((u) => {
    const key = `${normalizePageUrl(u.url)}::${u.viewport ?? "pc"}`;
    if (force.has(key) || force.has(normalizePageUrl(u.url))) return true;
    return !hitKeys.has(key);
  });

  return { hits, misses };
}

export async function getCachedPage(
  userId: string,
  projectId: string,
  url: string,
  viewport: ViewportMode
): Promise<PageAnalysisRow | null> {
  if (!isDatabaseConfigured()) return null;
  return getPageAnalysis(userId, projectId, url, viewport);
}

export function sessionAfterUpsert(sessionId: string): AnalysisSession | undefined {
  return getAnalysisSession(sessionId);
}
