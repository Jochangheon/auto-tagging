import type { ViewportMode } from "@autotag/shared";
import { interactCode } from "./firecrawl-interact.js";
import { tagLiveDom, type LiveTagEntry, type TagLiveDomStats } from "./tag-live-dom.js";

export interface MoMenuExploreResult {
  entries: LiveTagEntry[];
  menus_opened: string[];
  skipped: boolean;
  tag_stats: TagLiveDomStats;
}

const CLEAN_PAGE_CODE = `
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
await page.keyboard.press('Escape');
await page.mouse.click(12, 12);
await page.waitForTimeout(150);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(120);
return JSON.stringify({ ok: true });
`.trim();

/**
 * Fallback when CDP is unavailable — visible page only (no menu open / expand).
 */
export async function exploreMoMenuAndTag(
  scrapeId: string,
  _pageUrl: string,
  viewport: ViewportMode = "mo"
): Promise<MoMenuExploreResult> {
  await interactCode(scrapeId, CLEAN_PAGE_CODE, 20).catch(() => {});
  const tagged = await tagLiveDom(scrapeId, viewport);
  console.log(`[explore-mo] visible_only entries=${tagged.entries.length}`);
  return {
    entries: tagged.entries,
    menus_opened: [],
    skipped: true,
    tag_stats: tagged.stats,
  };
}
