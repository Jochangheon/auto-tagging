import type { Page } from "playwright";
import type { Platform, ViewportMode } from "@autotag/shared";
import { resolveCdpDeviceMetrics } from "@autotag/shared";
import { interactCode, type FirecrawlSession } from "./firecrawl-interact.js";
import type { LiveTagEntry } from "./tag-live-dom.js";

/**
 * Browser-side eval: re-measure visibility of every already-tagged element
 * ([data-tag-id]) at whatever viewport the page is CURRENTLY resized to.
 * Mirrors classifyVisibility()'s hidden_reason logic (minus offscreen, which
 * isn't a platform signal) so results are directly comparable.
 */
const RECHECK_VISIBILITY_EVAL = `() => {
  const map = {};
  document.querySelectorAll('[data-tag-id]').forEach((el) => {
    const id = el.getAttribute('data-tag-id');
    const cs = getComputedStyle(el);
    let hidden = cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0;
    if (!hidden) {
      let cur = el.parentElement;
      while (cur && cur !== document.body) {
        const ps = getComputedStyle(cur);
        if (
          ps.display === 'none' ||
          cur.hasAttribute('hidden') ||
          ps.visibility === 'hidden'
        ) {
          hidden = true;
          break;
        }
        cur = cur.parentElement;
      }
    }
    if (!hidden) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) hidden = true;
    }
    map[id] = !hidden;
  });
  return map;
}`;

const WEAK_REASON_PATTERNS = [/^ambiguous/, /^zero_size@/, /^collapsed:$/];

function isWeakReason(reason: string | undefined): boolean {
  if (!reason) return true;
  return WEAK_REASON_PATTERNS.some((re) => re.test(reason)) || reason === "collapsed:";
}

function applyOppMap(
  entries: LiveTagEntry[],
  oppMap: Record<string, boolean> | null | undefined,
  currentViewport: ViewportMode
): LiveTagEntry[] {
  if (!oppMap || typeof oppMap !== "object") return entries;

  const isMo = currentViewport === "mo";
  let relabeled = 0;
  let recoveredOppositeOnly = 0;
  let checked = 0;

  const result = entries.map((e) => {
    const key = String(e.tag_id);
    if (!(key in oppMap)) return e;
    checked++;

    const curVisible = e.visibility?.is_visible === true;
    const oppVisible = oppMap[key] === true;

    let platform: Platform;
    let reason: string;
    if (curVisible && oppVisible) {
      platform = "All";
      reason = "visible_both_viewports";
    } else if (curVisible && !oppVisible) {
      platform = isMo ? "MO" : "PC";
      reason = "visible_current_only";
    } else if (!curVisible && oppVisible) {
      platform = isMo ? "PC" : "MO";
      reason = "visible_opposite_only";
      recoveredOppositeOnly++;
    } else if (isWeakReason(e.platform_reason)) {
      platform = "All";
      reason = "hidden_both_no_signal";
    } else {
      return e;
    }

    if (platform !== e.platform) relabeled++;
    return { ...e, platform, platform_reason: reason };
  });

  console.log(
    `[platform] cross-viewport recheck viewport=${currentViewport} checked=${checked}/${entries.length} ` +
      `relabeled=${relabeled} recovered_opposite_only=${recoveredOppositeOnly}`
  );

  return result;
}

/**
 * CDP-local recheck — no Firecrawl interact round-trip.
 * Prefer this when menu explore already holds a live Playwright page.
 */
export async function crossViewportPlatformRecheckOnPage(
  page: Page,
  currentViewport: ViewportMode,
  entries: LiveTagEntry[]
): Promise<LiveTagEntry[]> {
  if (!entries.length) return entries;

  const opposite: ViewportMode = currentViewport === "mo" ? "pc" : "mo";
  const curDevice = resolveCdpDeviceMetrics(currentViewport);
  const oppDevice = resolveCdpDeviceMetrics(opposite);

  try {
    await page.setViewportSize({ width: oppDevice.width, height: oppDevice.height });
    await page.waitForTimeout(120);
    const oppMap = (await page.evaluate(RECHECK_VISIBILITY_EVAL)) as Record<string, boolean>;
    await page.setViewportSize({ width: curDevice.width, height: curDevice.height });
    await page.waitForTimeout(80);
    return applyOppMap(entries, oppMap, currentViewport);
  } catch (err) {
    console.warn(
      "[platform] cross-viewport recheck (cdp) error:",
      err instanceof Error ? err.message : err
    );
    return entries;
  }
}

/**
 * Ground-truth platform correction via Firecrawl interact (fallback when no CDP page).
 */
export async function crossViewportPlatformRecheck(
  session: FirecrawlSession,
  currentViewport: ViewportMode,
  entries: LiveTagEntry[]
): Promise<LiveTagEntry[]> {
  if (!entries.length) return entries;

  const opposite: ViewportMode = currentViewport === "mo" ? "pc" : "mo";
  const curDevice = resolveCdpDeviceMetrics(currentViewport);
  const oppDevice = resolveCdpDeviceMetrics(opposite);

  const code = `
await (async () => {
  await page.setViewportSize({ width: ${oppDevice.width}, height: ${oppDevice.height} });
  await page.waitForTimeout(120);
  const __oppMap = await page.evaluate(${RECHECK_VISIBILITY_EVAL});
  await page.setViewportSize({ width: ${curDevice.width}, height: ${curDevice.height} });
  await page.waitForTimeout(80);
  return JSON.stringify(__oppMap);
})();
`.trim();

  let oppMap: Record<string, boolean>;
  try {
    const resp = await interactCode(session.scrapeId, code, 30);
    if (resp.success !== true || !resp.result) {
      console.warn(`[platform] cross-viewport recheck failed: ${resp.error ?? "no result"}`);
      return entries;
    }
    oppMap = JSON.parse(resp.result) as Record<string, boolean>;
  } catch (err) {
    console.warn(
      "[platform] cross-viewport recheck error:",
      err instanceof Error ? err.message : err
    );
    return entries;
  }

  return applyOppMap(entries, oppMap, currentViewport);
}
