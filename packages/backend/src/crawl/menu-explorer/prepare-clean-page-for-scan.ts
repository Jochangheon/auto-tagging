import type { Page } from "playwright";
import type { ViewportMode } from "@autotag/shared";
import { closeOpenMenus } from "./open-trigger.js";
import { dismissOverlaysBeforeReveal, removeBlockingModals } from "./dismiss-overlays.js";
import type { SiteAdapter } from "./types.js";

/**
 * Close menus/popups and scroll to top before the first baseline DOM scan.
 * Keeps footer / page-body links visible (MO drawer must stay closed here).
 */
export async function prepareCleanPageForScan(
  page: Page,
  opts: {
    viewport?: ViewportMode;
    siteAdapter?: SiteAdapter | null;
    pageUrl?: string;
  } = {}
): Promise<void> {
  const viewport = opts.viewport ?? "pc";

  await page.keyboard.press("Escape").catch(() => {});
  await closeOpenMenus(page);
  await page.waitForTimeout(180);

  if (viewport === "mo") {
    await page.keyboard.press("Escape").catch(() => {});
    await page.mouse.click(12, 12).catch(() => {});
    await page.waitForTimeout(180);
  }

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(120);

  const hints = opts.siteAdapter?.overlayDismissHints;
  if (hints) {
    await dismissOverlaysBeforeReveal(page, hints, opts.pageUrl).catch(() => {});
  }
  await removeBlockingModals(page).catch(() => {});

  // Dismiss/probe can leave scrollY > 0 — GNB then sits above the viewport (y < 0)
  // and looks "missing" even though it was never clicked away.
  await page.evaluate(() => {
    try {
      document.documentElement.style.scrollBehavior = "auto";
      document.body.style.scrollBehavior = "auto";
    } catch {}
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }).catch(() => {});
  await page.waitForTimeout(80);
}
