import type { Page } from "playwright";
import type { SiteAdapter } from "./types.js";
import { collectHeaderPanelAnchors } from "./dom-fallback-collect.js";
import { logSharedPanelTagged } from "./menu-explorer-log.js";

/** Tag dropdown / submenu items not matched by INTERACTIVE_SELECTOR alone. */
const GENERIC_DROPDOWN_TAG_EVAL = `
function visible(el) {
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return (
    parseFloat(style.opacity || "1") > 0.05 &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    rect.width > 0 &&
    rect.height > 0
  );
}
let max = 0;
for (const el of document.querySelectorAll("[data-tag-id]")) {
  const id = parseInt(el.getAttribute("data-tag-id") || "", 10);
  if (Number.isFinite(id) && id > max) max = id;
}
let nextId = max + 1;
const panelSelectors = [
  "nav",
  "[role='menu']",
  "[role='navigation']",
  "[role='dialog']",
  "header ul",
  "footer nav",
  "[class*='dropdown']",
  "[class*='submenu']",
  "[class*='menu-list']",
  "[class*='gnb']",
];
const panels = [];
for (const sel of panelSelectors) {
  for (const el of document.querySelectorAll(sel)) {
    if (visible(el)) panels.push(el);
  }
}
for (const panel of panels) {
  for (const el of panel.querySelectorAll("a, button, [role='menuitem'], p, span")) {
    if (nextId > 500) break;
    if (el.getAttribute("data-tag-id")) continue;
    if (!visible(el)) continue;
    const t = (el.textContent || "").trim();
    if (!t || t.length > 80) continue;
    el.setAttribute("data-tag-id", String(nextId++));
  }
}
`.trim();

/**
 * Pre-tag panel / hidden-menu items before tagLiveDomOnPage.
 * Does NOT run the full INTERACTIVE_SELECTOR assign — that is tagLiveDom's job.
 */
export async function assignExtraTagsOnPage(
  page: Page,
  adapter?: SiteAdapter,
  ctx?: { triggerLabel?: string }
): Promise<void> {
  if (adapter?.tagPanelContent) {
    const result = await adapter.tagPanelContent(page, ctx);
    if (result && ctx?.triggerLabel) {
      logSharedPanelTagged(ctx.triggerLabel, result.tagged, result.linkLabels);
    }
    return;
  }

  await collectHeaderPanelAnchors(page, adapter?.panelCollectHints ?? {});
  await page.evaluate(`(() => { ${GENERIC_DROPDOWN_TAG_EVAL}; })()`);
}
