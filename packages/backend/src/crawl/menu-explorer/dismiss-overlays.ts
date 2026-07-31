import type { Page } from "playwright";
import type { OverlayDismissHints } from "./site-adapters/overlay-dismiss-hints.js";

const SUPPRESS_STYLE_ID = "data-autotag-overlay-suppress";
const DEFAULT_MAX_ATTEMPTS = 8;

const GENERIC_CLOSE_SELECTORS = [
  'button:has-text("닫기")',
  'button:has-text("확인")',
  'button:has-text("동의")',
  '[aria-label*="닫기" i]',
  '[aria-label*="close" i]',
];

export interface DismissOverlaysResult {
  clicked: string[];
  suppressApplied: number;
  removed: number;
  attempts: number;
  verifyHit: { tag: string; text: string } | null;
  blockingGnb: boolean;
}

function formatHit(hit: { tag: string; text: string } | null): string {
  if (!hit) return "null";
  return `${hit.tag}:"${hit.text.slice(0, 40)}"`;
}

async function probePoint(
  page: Page,
  x: number,
  y: number
): Promise<{ tag: string; text: string } | null> {
  return page.evaluate(
    `((px, py) => {
      var el = document.elementFromPoint(px, py);
      if (!el) return null;
      return { tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 60) };
    })(${Math.round(x)}, ${Math.round(y)})`
  ) as Promise<{ tag: string; text: string } | null>;
}

function looksLikeOverlayBlocker(hit: { tag: string; text: string } | null): boolean {
  // null = empty space at probe point → nothing is covering it (NOT blocked).
  if (!hit) return false;
  const t = hit.text.toLowerCase();
  if (hit.tag === "a" && t.length < 30) return false;
  if (hit.tag === "button") {
    if (t.includes("닫기") || t.includes("그만보기") || t.includes("close")) return true;
    if (t.includes("로그인") || t.includes("회원가입")) return false;
    return false;
  }
  if (t.includes("닫기") || t.includes("그만보기") || t.includes("close")) return true;
  if (/쿠폰|멤버십|회원가입 후|지금 회원가입|오늘 하루|혜택을 만나|popup|이벤트 팝업/i.test(hit.text)) {
    return true;
  }
  // Do NOT treat normal hero/marketing copy as an overlay — that burned ~8
  // idle dismiss rounds on sites whose GNB probe lands on a long headline.
  return false;
}

/** Clamp a probe point into the current viewport (PC coords break on MO width). */
async function resolveProbePoint(
  page: Page,
  probe: { x: number; y: number }
): Promise<{ x: number; y: number }> {
  const vw = (await page
    .evaluate(() => window.innerWidth)
    .catch(() => 0)) as number;
  if (!vw || probe.x < vw) return probe;
  return { x: Math.max(10, Math.floor(vw / 2)), y: probe.y };
}

/** Always-visible site chrome — never hide/remove while dismissing popups. */
const PROTECTED_CHROME_EVAL = `
function __autotagIsProtectedChrome(el) {
  if (!el || !el.closest) return false;
  if (el.closest("header, nav, [role='banner'], [role='navigation'], .headerContainer")) return true;
  var cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
  if (cls.indexOf("headercontainer") >= 0 || cls.indexOf("header-container") >= 0) return true;
  return false;
}
`;

async function applySuppressStyles(page: Page, selectors: string[]): Promise<void> {
  if (selectors.length === 0) return;
  const selectorsJson = JSON.stringify(selectors);
  await page.evaluate(
    `((id, selectors) => {
      ${PROTECTED_CHROME_EVAL}
      // Clear a previous broken "force-restore header *" rule if still present —
      // that overrode responsive CSS and showed MO GNB on PC (KANU layout break).
      var style = document.getElementById(id);
      if (!style) {
        style = document.createElement("style");
        style.id = id;
        document.head.appendChild(style);
      }

      // Mark only real overlay nodes. Never blanket-hide selector matches that
      // sit inside site chrome, and NEVER force-show header/nav (site media
      // queries must keep PC vs MO chrome separate).
      document.querySelectorAll("[data-autotag-overlay-hidden]").forEach(function(el) {
        el.removeAttribute("data-autotag-overlay-hidden");
      });
      for (var i = 0; i < selectors.length; i++) {
        var nodes;
        try { nodes = document.querySelectorAll(selectors[i]); } catch (e) { continue; }
        for (var j = 0; j < nodes.length; j++) {
          var el = nodes[j];
          if (__autotagIsProtectedChrome(el)) continue;
          el.setAttribute("data-autotag-overlay-hidden", "1");
        }
      }
      style.textContent =
        "[data-autotag-overlay-hidden='1'] {" +
        " display: none !important; pointer-events: none !important;" +
        " visibility: hidden !important; opacity: 0 !important; }";
    })(${JSON.stringify(SUPPRESS_STYLE_ID)}, ${selectorsJson})`
  );
}

async function removeDomNodes(page: Page, selectors: string[]): Promise<number> {
  if (selectors.length === 0) return 0;
  return page.evaluate(
    `((selectors) => {
      ${PROTECTED_CHROME_EVAL}
      var removed = 0;
      for (var i = 0; i < selectors.length; i++) {
        var nodes = document.querySelectorAll(selectors[i]);
        for (var j = 0; j < nodes.length; j++) {
          var el = nodes[j];
          if (__autotagIsProtectedChrome(el)) continue;
          el.remove();
          removed++;
        }
      }
      return removed;
    })(${JSON.stringify(selectors)})`
  ) as Promise<number>;
}

async function removePlaywrightNodes(page: Page, selectors: string[]): Promise<number> {
  let removed = 0;
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      const count = await loc.count();
      for (let i = 0; i < count; i++) {
        const ok = await loc
          .nth(i)
          .evaluate((el) => {
            if (
              el.closest &&
              el.closest("header, nav, [role='banner'], [role='navigation'], .headerContainer, [class*='headerContainer']")
            ) {
              return false;
            }
            el.remove();
            return true;
          })
          .catch(() => false);
        if (ok) removed++;
      }
    } catch {
      /* invalid locator */
    }
  }
  return removed;
}

/** Generic: remove overlay-like ancestors covering the probe point. */
async function neutralizeProbeBlocker(page: Page, x: number, y: number): Promise<number> {
  return page.evaluate(
    `((px, py) => {
      ${PROTECTED_CHROME_EVAL}
      var removed = 0;
      function clearAtPoint() {
        var el = document.elementFromPoint(px, py);
        if (!el) return;
        if (__autotagIsProtectedChrome(el)) return;
        var tag = el.tagName.toLowerCase();
        var text = (el.textContent || "").trim();
        if (tag === "button" && text.length < 40 && text.indexOf("닫기") < 0 && text.indexOf("그만보기") < 0) {
          return;
        }
        var cur = el;
        while (cur && cur !== document.body && cur !== document.documentElement) {
          if (__autotagIsProtectedChrome(cur)) return;
          var ct = (cur.textContent || "");
          var st = window.getComputedStyle(cur);
          var pos = st.position;
          if (
            (ct.indexOf("그만보기") >= 0 || (ct.indexOf("닫기") >= 0 && ct.length < 300)) &&
            (pos === "fixed" || pos === "absolute" || pos === "sticky" || cur.tagName === "DIALOG")
          ) {
            cur.remove();
            removed++;
            return;
          }
          cur = cur.parentElement;
        }
        if (tag !== "button" && text.length > 15) {
          var r = el.getBoundingClientRect();
          if (r.width > 100 && r.height > 30 && py < r.bottom && py > r.top - 20) {
            var parent = el.closest("div, section, aside, dialog");
            if (
              parent &&
              !__autotagIsProtectedChrome(parent) &&
              (parent.textContent || "").indexOf("그만보기") >= 0
            ) {
              parent.remove();
              removed++;
            }
          }
        }
      }
      clearAtPoint();
      clearAtPoint();
      return removed;
    })(${Math.round(x)}, ${Math.round(y)})`
  ) as Promise<number>;
}

/**
 * Ambiguous labels like "확인" (OK/Confirm) are NOT reliably "close overlay"
 * buttons — on promo/event popups they're often the CTA that navigates to
 * the campaign page (e.g. kanu.co.kr's mobile promo popup has only a single
 * "확인" button that opens /lounge/events, no separate X). Detect that a
 * click caused real navigation and undo it immediately, then never retry
 * that selector again this call.
 */
async function clickCloseButtons(
  page: Page,
  selectors: string[],
  clicked: string[],
  guardUrl?: string
): Promise<void> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (!(await loc.count())) continue;
      const beforeUrl = guardUrl ? page.url() : "";

      const visible = await loc.isVisible().catch(() => false);
      if (!visible) {
        await loc.click({ timeout: 1200, force: true }).catch(() => {});
      } else {
        await loc.click({ timeout: 2000 }).catch(() => {});
      }

      if (guardUrl && page.url() !== beforeUrl) {
        console.warn(
          `[overlay-dismiss] "${sel}" navigated ${beforeUrl} -> ${page.url()}, restoring ${guardUrl}`
        );
        await page.goto(guardUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(300);
        continue;
      }

      if (!clicked.includes(sel)) clicked.push(sel);
    } catch {
      /* best-effort */
    }
  }
}

export async function dismissOverlaysBeforeReveal(
  page: Page,
  hints?: OverlayDismissHints,
  guardUrl?: string
): Promise<DismissOverlaysResult> {
  const clicked: string[] = [];
  const closeSelectors = [...GENERIC_CLOSE_SELECTORS, ...(hints?.closeButtonSelectors ?? [])];
  const suppressSelectors = hints?.suppressOverlaySelectors ?? [];
  const domRemoveSelectors = hints?.domRemoveSelectors ?? [];
  const playwrightRemoveSelectors = hints?.playwrightRemoveSelectors ?? [];
  const probe = await resolveProbePoint(page, hints?.verifyProbePoint ?? { x: 960, y: 96 });
  const maxAttempts = hints?.maxDismissAttempts ?? DEFAULT_MAX_ATTEMPTS;

  await applySuppressStyles(page, suppressSelectors);

  let totalRemoved = 0;
  let verifyHit: { tag: string; text: string } | null = null;
  let blockingGnb = true;
  let attempt = 0;

  for (attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.keyboard.press("Escape").catch(() => {});
    await clickCloseButtons(page, closeSelectors, clicked, guardUrl);
    totalRemoved += await removeDomNodes(page, domRemoveSelectors);
    totalRemoved += await removePlaywrightNodes(page, playwrightRemoveSelectors);
    totalRemoved += await neutralizeProbeBlocker(page, probe.x, probe.y);
    await applySuppressStyles(page, suppressSelectors);
    await page.waitForTimeout(attempt === 1 ? 120 : 60);

    verifyHit = await probePoint(page, probe.x, probe.y);
    blockingGnb = looksLikeOverlayBlocker(verifyHit);

    console.log(
      `[overlay-dismiss] attempt=${attempt}/${maxAttempts} hit=${formatHit(verifyHit)} blocking_gnb=${blockingGnb}`
    );

    if (!blockingGnb) break;

    // Nothing left to click/remove but probe still "busy" → page content, stop.
    if (attempt >= 2 && clicked.length === 0 && totalRemoved === 0) {
      console.log(
        `[overlay-dismiss] early-stop — no closable overlay found (likely page content)`
      );
      blockingGnb = false;
      break;
    }
  }

  console.log(
    `[overlay-dismiss] done attempts=${attempt} clicked=[${clicked.join(",")}] ` +
      `suppress=${suppressSelectors.length} removed=${totalRemoved} ` +
      `verify=(${probe.x},${probe.y}) hit=${formatHit(verifyHit)} blocking_gnb=${blockingGnb}`
  );

  return {
    clicked,
    suppressApplied: suppressSelectors.length,
    removed: totalRemoved,
    attempts: attempt,
    verifyHit,
    blockingGnb,
  };
}

/** Browser-side modal cleanup — embedded in Firecrawl interact capture. */
export const BROWSER_DISMISS_MODALS_EVAL = `
// NOTE: "확인"/"OK" is deliberately excluded — on promo/event popups it's
// often the CTA that navigates to the campaign page, not a close button.
// This runs inside page.evaluate() where a resulting navigation can't be
// detected/undone, so we only auto-click unambiguous "close" labels here.
var AUTOTAG_CLOSE_RE = /^(닫기|close|×|✕|x|오늘\\s*하루\\s*그만보기|오늘\\s*하루\\s*보지\\s*않기|다시\\s*보지\\s*않기|그만보기)$/i;
var AUTOTAG_PROMO_RE = /쿠폰|멤버십|회원가입 후|지금 회원가입|그만보기|오늘 하루|혜택을 만나|popup|이벤트 팝업/i;

function autotagClickClose() {
  var clicked = [];
  var nodes = document.querySelectorAll("button, a, [role='button'], [class*='close'], [class*='Close'], [aria-label], span, div");
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var t = (el.textContent || "").trim();
    var aria = (el.getAttribute("aria-label") || "").trim();
    var matches = (t.length <= 20 && AUTOTAG_CLOSE_RE.test(t)) || /^(close|닫기|×|✕)$/i.test(aria);
    if (!matches) continue;
    var r = el.getBoundingClientRect();
    if (r.width > 0 && r.width < 320 && r.height > 0 && r.height < 140) {
      try { el.click(); clicked.push(t || aria); } catch (e) {}
    }
  }
  return clicked;
}

function autotagIsProtectedChrome(el) {
  if (!el || !el.closest) return false;
  if (el.closest("header, nav, [role='banner'], [role='navigation'], .headerContainer")) return true;
  var cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
  return cls.indexOf("headercontainer") >= 0 || cls.indexOf("header-container") >= 0;
}

function autotagRemoveOverlays() {
  var removed = [];
  var cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  var all = document.querySelectorAll("div, section, dialog, aside, [role='dialog']");
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (autotagIsProtectedChrome(el)) continue;
    var st = window.getComputedStyle(el);
    if (["fixed", "absolute", "sticky"].indexOf(st.position) < 0) continue;
    var r = el.getBoundingClientRect();
    var coversCenter = r.left <= cx && r.right >= cx && r.top <= cy && r.bottom >= cy;
    var big = r.width > window.innerWidth * 0.3 && r.height > window.innerHeight * 0.15;
    var z = parseInt(st.zIndex || "0", 10);
    var text = (el.textContent || "").slice(0, 300);
    var promo = AUTOTAG_PROMO_RE.test(text);
    var dialogish = el.tagName === "DIALOG" || el.getAttribute("role") === "dialog";
    if ((big || coversCenter) && (promo || dialogish || z >= 30)) {
      try { el.remove(); removed.push(text.slice(0, 30)); } catch (e) {}
    }
  }
  return removed;
}

function autotagCenterBlocked() {
  var cx = Math.floor(window.innerWidth / 2), cy = Math.floor(window.innerHeight / 2);
  var el = document.elementFromPoint(cx, cy);
  var steps = 0;
  while (el && steps++ < 10) {
    var st = window.getComputedStyle(el);
    var z = parseInt(st.zIndex || "0", 10);
    var dialogish = el.tagName === "DIALOG" || el.getAttribute("role") === "dialog";
    var text = (el.textContent || "").slice(0, 200);
    if ((["fixed", "absolute"].indexOf(st.position) >= 0 && z >= 30) || dialogish || AUTOTAG_PROMO_RE.test(text)) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

function autotagDismissModals() {
  var clicked = autotagClickClose();
  var removed = autotagRemoveOverlays();
  return { clicked: clicked, removed: removed, centerBlocked: autotagCenterBlocked() };
}
`;

/** Remove large promo modals (incl. center popups) that block header/content. */
export async function removeBlockingModals(page: Page): Promise<{ removed: number; centerBlocked: boolean }> {
  return page.evaluate(
    `(() => {
      ${BROWSER_DISMISS_MODALS_EVAL}
      let total = 0;
      let last = { clicked: [], removed: [], centerBlocked: false };
      for (let i = 0; i < 3; i++) {
        last = autotagDismissModals();
        total += (last.removed || []).length;
        if (!last.centerBlocked && !(last.removed || []).length && !(last.clicked || []).length) break;
      }
      return { removed: total, centerBlocked: !!last.centerBlocked };
    })()`
  ) as Promise<{ removed: number; centerBlocked: boolean }>;
}
