import type { Page } from "playwright";
import type { LiveTagEntry } from "../tag-live-dom.js";
import { tagLiveDomOnPage } from "../tag-live-dom.js";
import { assignExtraTagsOnPage } from "./assign-extra-tags.js";
import { collectHiddenDomMenuItems } from "./dom-fallback-collect.js";
import { prepareCleanPageForScan } from "./prepare-clean-page-for-scan.js";
import type { ExploreMenuTreeOptions, MenuExploreState, MenuPathStep } from "./types.js";

/**
 * Tag what is on screen + GNB/header links already in the DOM (even if CSS-hidden).
 * Does NOT open hamburger menus, dropdowns, or drawers.
 */
export async function exploreMenuTree(
  page: Page,
  opts: ExploreMenuTreeOptions,
  _path: MenuPathStep[] = [],
  _visited: Set<string> = new Set(),
  state?: MenuExploreState
): Promise<LiveTagEntry[]> {
  const exploreState: MenuExploreState = state ?? {
    statesExplored: 0,
    openedKeys: [],
    skippedTriggers: 0,
    pathByTagId: new Map(),
    startedAt: Date.now(),
  };

  try {
    await prepareCleanPageForScan(page, {
      viewport: opts.viewport,
      siteAdapter: opts.siteAdapter,
      pageUrl: opts.pageUrl,
    });

    // Passive DOM collect — no clicks. Restores PC GNB dropdown/panel links that
    // live in the HTML but are opacity:0 / display:none until hover.
    await assignExtraTagsOnPage(page, opts.siteAdapter);
    const hiddenAdded = await collectHiddenDomMenuItems(page);
    if (hiddenAdded > 0) {
      console.log(`[menu-explorer] hidden_header_links tagged=${hiddenAdded}`);
    }

    const snap = await tagLiveDomOnPage(page, opts.viewport ?? "pc");
    exploreState.statesExplored = 1;
    await opts.onSnapshot?.(snap.entries, []);
    console.log(
      `[menu-explorer] visible+gnb_dom entries=${snap.entries.length} viewport=${opts.viewport ?? "pc"} hidden_extra=${hiddenAdded}`
    );
    return snap.entries;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[menu-explorer] visible_scan_failed reason=${msg.slice(0, 80)}`);
    return [];
  }
}

export type { MenuExploreState };
