import type { Page } from "playwright";
import type { SiteAdapter, TriggerCandidate } from "./types.js";

const FIND_TRIGGERS_EVAL = `
function __findExpandTriggers(containerSelector) {
  const CLASS_RE = /dropdown|submenu|has-children|menu.*expand|accordion/i;
  const root = containerSelector
    ? document.querySelector(containerSelector) || document.body
    : document.body;

  function visible(el) {
    const s = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return (
      parseFloat(s.opacity || "1") > 0.05 &&
      s.visibility !== "hidden" &&
      s.display !== "none" &&
      r.width > 0 &&
      r.height > 0
    );
  }

  function stableKey(el) {
    const id = el.getAttribute("data-tag-id");
    if (id) return "tag:" + id;
    const text = (el.textContent || "").trim().slice(0, 48);
    const tag = el.tagName.toLowerCase();
    const cls = String(el.className || "").slice(0, 48);
    return "dom:" + tag + ":" + text + ":" + cls;
  }

  function selectorHint(el) {
    const id = el.getAttribute("data-tag-id");
    if (id) return '[data-tag-id="' + id + '"]';
    const text = (el.textContent || "").trim().slice(0, 40);
    if (text && el.tagName === "BUTTON") {
      return 'button:has-text("' + text.replace(/"/g, '\\\\"') + '")';
    }
    if (text && el.tagName === "A") {
      return 'a:has-text("' + text.replace(/"/g, '\\\\"') + '")';
    }
    return stableKey(el);
  }

  function hasHiddenChildMenu(el) {
    for (const child of el.querySelectorAll("ul, div, nav")) {
      const s = window.getComputedStyle(child);
      if (s.display === "none" || s.visibility === "hidden") return true;
      const r = child.getBoundingClientRect();
      if (r.height === 0 || s.maxHeight === "0px") return true;
    }
    return false;
  }

  function isDeadHref(href) {
    if (!href) return true;
    const h = href.trim().toLowerCase();
    return h === "#" || h.startsWith("javascript:void");
  }

  const seen = new Set();
  const out = [];
  const nodes = root.querySelectorAll(
    "button, a, [role='button'], [role='menuitem'], [aria-haspopup], [aria-expanded]"
  );

  for (const el of nodes) {
    if (!(el instanceof HTMLElement)) continue;
    if (!visible(el)) continue;

    const key = stableKey(el);
    if (seen.has(key)) continue;
    seen.add(key);

    const signals = [];
    let score = 0;

    if (el.hasAttribute("aria-haspopup")) {
      signals.push("aria-haspopup");
      score += 30;
    }
    const ariaExp = el.getAttribute("aria-expanded");
    if (ariaExp === "false") {
      signals.push("aria-expanded=false");
      score += 25;
    }
    const cls = String(el.className || "");
    if (CLASS_RE.test(cls)) {
      signals.push("class:" + cls.slice(0, 30));
      score += 20;
    }

    const style = window.getComputedStyle(el);
    const clickable =
      el.tagName === "BUTTON" ||
      el.getAttribute("role") === "button" ||
      style.cursor === "pointer";
    const href = el.getAttribute("href") || "";
    if (clickable && isDeadHref(href)) {
      signals.push("dead-href");
      score += 15;
    }
    if (hasHiddenChildMenu(el)) {
      signals.push("hidden-child-menu");
      score += 15;
    }

    if (score < 15) continue;

    // Nav-only: real href with no submenu signals — not an expand trigger.
    // Sub-links for shared-overlay panels (e.g. KANU GNB) are collected via
    // collectHeaderPanelAnchors() regardless of opacity.
    if (
      !isDeadHref(href) &&
      href.length > 1 &&
      !el.hasAttribute("aria-haspopup") &&
      ariaExp !== "false" &&
      !hasHiddenChildMenu(el)
    ) {
      continue;
    }

    const tagIdRaw = el.getAttribute("data-tag-id");
    const tag_id = tagIdRaw ? parseInt(tagIdRaw, 10) : null;

    out.push({
      key,
      label: (el.textContent || "").trim().slice(0, 80) || key,
      tag_id: Number.isFinite(tag_id) ? tag_id : null,
      selector_hint: selectorHint(el),
      method: "click",
      depth: 0,
      score,
      signals,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 80);
}
`;

/** Browser eval body — reusable from Firecrawl interact when CDP is unavailable. */
export const FIND_EXPAND_TRIGGERS_BROWSER_EVAL = FIND_TRIGGERS_EVAL;

export async function findExpandTriggers(
  page: Page,
  containerSelector?: string,
  siteAdapter?: SiteAdapter
): Promise<TriggerCandidate[]> {
  if (
    siteAdapter?.menuPanelPattern === "shared_overlay_panel" &&
    siteAdapter.findExpandTriggers
  ) {
    return siteAdapter.findExpandTriggers(page, containerSelector);
  }

  const heuristic = await page.evaluate(
    `(${FIND_TRIGGERS_EVAL})(${JSON.stringify(containerSelector ?? null)})`
  );

  let merged = heuristic as TriggerCandidate[];

  if (siteAdapter?.findExpandTriggers) {
    const extra = await siteAdapter.findExpandTriggers(page, containerSelector);
    const byKey = new Map<string, TriggerCandidate>();
    for (const t of [...merged, ...extra]) {
      const prev = byKey.get(t.key);
      if (!prev || t.score > prev.score) byKey.set(t.key, t);
    }
    merged = [...byKey.values()].sort((a, b) => b.score - a.score);
  }

  if (siteAdapter?.excludeTriggerKeys) {
    const keys = new Set(merged.map((t) => t.key));
    siteAdapter.excludeTriggerKeys(keys);
    merged = merged.filter((t) => keys.has(t.key));
  }

  return merged;
}
