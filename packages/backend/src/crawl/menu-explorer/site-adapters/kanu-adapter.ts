import type { Page } from "playwright";
import type { ViewportMode } from "@autotag/shared";
import type { SiteAdapter } from "../types.js";
import type { OverlayDismissHints } from "./overlay-dismiss-hints.js";
import { dismissOverlaysBeforeReveal } from "../dismiss-overlays.js";

/** Kept for callers that still import the label list (not used for open/expand). */
export const KANU_GNB_MENUS = ["카누 소개", "스토어", "라운지", "고객 지원", "기업 고객"];

export const KANU_OVERLAY_DISMISS_HINTS: OverlayDismissHints = {
  closeButtonSelectors: [
    'button:has-text("닫기")',
    'button:has-text("오늘 하루 보지 않기")',
    'button:has-text("다음에")',
    '[aria-label="Close"]',
    '[aria-label="닫기"]',
    'button[class*="close"]',
  ],
  // Bottom promo bars + true full-screen dimmers only.
  // NEVER match z-[50]/z-50 — that is the always-visible PC GNB (.headerContainer).
  suppressOverlaySelectors: [
    "div.fixed.bottom-0.left-0.right-0",
    "div.fixed.inset-0",
  ],
  domRemoveSelectors: [
    "div.fixed.bottom-0.left-0.right-0",
    "div.fixed.inset-0",
  ],
  // Avoid broad div:has-text(...) — Playwright matches ancestors and can delete the whole page.
  playwrightRemoveSelectors: [
    '[role="dialog"]',
  ],
  // Probe below the 144px header so GNB text is not mistaken for a blocker.
  verifyProbePoint: { x: 960, y: 200 },
  maxDismissAttempts: 4,
};

function isKanuHost(url: string): boolean {
  try {
    return new URL(url).hostname.replace(/^www\./, "") === "kanu.co.kr";
  } catch {
    return url.includes("kanu.co.kr");
  }
}

/** Visible-only: dismiss overlays, never open hamburger / GNB panels. */
export function createKanuAdapter(viewport: ViewportMode): SiteAdapter {
  return {
    matches: (url) => isKanuHost(url),

    menuPanelPattern: "auto",
    // Passive header/panel DOM collect only — never open hamburger / GNB by click.
    flatPanelCollect: true,
    panelCollectHints: {
      panelClassPatterns: ["absolute", "dropdown", "submenu", "mega", "gnb"],
      requireAbsolute: false,
      headerProximityPx: 500,
      minMenuBlocks: 1,
    },
    overlayDismissHints: viewport === "pc" ? KANU_OVERLAY_DISMISS_HINTS : undefined,
    maxDepth: 1,
    maxStatesPerPage: 1,

    async preparePage(page: Page) {
      // Popups only — do not open the mobile menu.
      if (viewport === "pc") {
        await dismissOverlaysBeforeReveal(page, KANU_OVERLAY_DISMISS_HINTS);
      } else {
        await page.keyboard.press("Escape").catch(() => {});
      }
    },
  };
}
