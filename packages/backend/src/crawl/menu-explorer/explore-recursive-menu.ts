import type { Page } from "playwright";
import type { ViewportMode } from "@autotag/shared";
import { connectOverCdp } from "../cdp-session.js";
import type { FirecrawlSession } from "../firecrawl-interact.js";
import { exploreMoMenuAndTag } from "../explore-mo-menu.js";
import { mergeTagEntries, tagLiveDom, type LiveTagEntry, type TagLiveDomStats } from "../tag-live-dom.js";
import { filterEntriesByViewport } from "../platform-classifier.js";
import {
  crossViewportPlatformRecheck,
  crossViewportPlatformRecheckOnPage,
} from "../platform-crosscheck.js";
import { exploreMenuTree } from "./explore-menu-tree.js";
import { pickSiteAdapter } from "./site-adapters/index.js";
import type { MenuPathStep, RecursiveMenuExploreResult } from "./types.js";
import { normalizeMenuPath } from "./types.js";

async function fallbackExplore(
  scrapeId: string,
  pageUrl: string,
  viewport: ViewportMode,
  startedAt: number
): Promise<RecursiveMenuExploreResult> {
  if (viewport === "mo") {
    const legacy = await exploreMoMenuAndTag(scrapeId, pageUrl, viewport);
    return {
      entries: legacy.entries,
      opened_paths: [],
      states_explored: legacy.menus_opened.length + 1,
      expand_opened: legacy.menus_opened,
      skipped: legacy.skipped,
      skipped_triggers: 0,
      tag_stats: legacy.tag_stats,
      path_by_tag_id: {},
      total_elapsed_ms: Date.now() - startedAt,
    };
  }

  const snap = await tagLiveDom(scrapeId, viewport);
  return {
    entries: snap.entries,
    opened_paths: [],
    states_explored: 1,
    expand_opened: [],
    skipped: false,
    skipped_triggers: 0,
    tag_stats: snap.stats,
    path_by_tag_id: {},
    total_elapsed_ms: Date.now() - startedAt,
  };
}

function pathMapToRecord(map: Map<number, MenuPathStep[]>): Record<number, MenuPathStep[]> {
  const out: Record<number, MenuPathStep[]> = {};
  for (const [k, v] of map) out[k] = v;
  return out;
}

function emptyPartial(startedAt: number): RecursiveMenuExploreResult {
  return {
    entries: [],
    opened_paths: [],
    states_explored: 0,
    expand_opened: [],
    skipped: true,
    skipped_triggers: 0,
    tag_stats: { raw_matched: 0, tagged: 0, dropped_cap: 0 },
    path_by_tag_id: {},
    total_elapsed_ms: Date.now() - startedAt,
  };
}

/** CDP menu collect: baseline + panel/hidden (PC flat) or click DFS (MO). */
export async function exploreRecursiveMenuAndTag(
  session: FirecrawlSession,
  pageUrl: string,
  viewport: ViewportMode
): Promise<RecursiveMenuExploreResult> {
  const startedAt = Date.now();

  if (!session.cdpUrl) {
    console.warn("[menu-explorer] no cdpUrl — tagLiveDom fallback");
    return fallbackExplore(session.scrapeId, pageUrl, viewport, startedAt);
  }

  let merged: LiveTagEntry[] = [];
  let tagStats: TagLiveDomStats = { raw_matched: 0, tagged: 0, dropped_cap: 0 };
  const pathByTagId = new Map<number, MenuPathStep[]>();
  const openedPaths: MenuPathStep[][] = [];
  let skippedTriggers = 0;

  try {
    const page = await connectOverCdp(session.cdpUrl, pageUrl);
    if (!page) {
      return fallbackExplore(session.scrapeId, pageUrl, viewport, startedAt);
    }

    const adapter = pickSiteAdapter(pageUrl, viewport);

    const onSnapshot = async (entries: LiveTagEntry[], path: MenuPathStep[]) => {
      merged = mergeTagEntries(merged, entries);
      if (path.length) openedPaths.push(path);
      for (const e of entries) {
        if (e.menu_reveal_path?.length) {
          pathByTagId.set(e.tag_id, normalizeMenuPath(e.menu_reveal_path));
        }
      }
      tagStats = {
        raw_matched: Math.max(tagStats.raw_matched, entries.length),
        tagged: merged.length,
        dropped_cap: tagStats.dropped_cap,
      };
    };

    const exploreState = {
      statesExplored: 0,
      openedKeys: [] as string[],
      skippedTriggers: 0,
      pathByTagId,
      startedAt,
    };

    const dfsEntries = await exploreMenuTree(
      page,
      { viewport, siteAdapter: adapter, onSnapshot, pageUrl },
      [],
      new Set(),
      exploreState
    );

    merged = mergeTagEntries(merged, dfsEntries);
    skippedTriggers = exploreState.skippedTriggers;

    const totalElapsed = Date.now() - startedAt;
    console.log(
      `[menu-explorer] done states=${exploreState.statesExplored} ` +
        `opened=${exploreState.openedKeys.length} skipped=${skippedTriggers} ` +
        `entries=${merged.length} paths=${pathByTagId.size} total_elapsed=${totalElapsed}ms`
    );

    // Ground-truth platform correction BEFORE trimming — must run on the full
    // merged set, not the already-filtered one, or wrongly-dropped elements
    // never get a chance to be re-classified. Prefer CDP page (no interact RTT).
    merged = await crossViewportPlatformRecheckOnPage(page, viewport, merged);
    merged = filterEntriesByViewport(merged, viewport);

    return {
      entries: merged,
      opened_paths: openedPaths,
      states_explored: exploreState.statesExplored,
      expand_opened: exploreState.openedKeys,
      skipped: false,
      skipped_triggers: skippedTriggers,
      tag_stats: {
        raw_matched: tagStats.raw_matched,
        tagged: merged.length,
        dropped_cap: tagStats.dropped_cap,
      },
      path_by_tag_id: pathMapToRecord(pathByTagId),
      total_elapsed_ms: totalElapsed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[menu-explorer] CDP explore failed, returning partial:", msg.slice(0, 120));

    if (merged.length > 0) {
      const rechecked = await crossViewportPlatformRecheck(session, viewport, merged).catch(
        () => merged
      );
      return {
        entries: filterEntriesByViewport(rechecked, viewport),
        opened_paths: openedPaths,
        states_explored: 0,
        expand_opened: [],
        skipped: false,
        skipped_triggers: skippedTriggers,
        tag_stats: { raw_matched: merged.length, tagged: merged.length, dropped_cap: 0 },
        path_by_tag_id: pathMapToRecord(pathByTagId),
        total_elapsed_ms: Date.now() - startedAt,
      };
    }

    try {
      return await fallbackExplore(session.scrapeId, pageUrl, viewport, startedAt);
    } catch {
      return emptyPartial(startedAt);
    }
  }
}
