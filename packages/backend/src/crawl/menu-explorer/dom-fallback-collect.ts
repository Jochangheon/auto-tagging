import type { Page } from "playwright";
import type { PanelCollectHints } from "./site-adapters/panel-collect-hints.js";

export interface PanelCollectResult {
  containerFound: boolean;
  /** Set when panel not found and header/nav hidden-link scan runs. */
  fallback?: "header_scan";
  anchors: number;
  tagged: number;
  skippedDuplicate: number;
  mapped: Record<string, number>;
  unmapped: number;
  parents: string[];
}

const UNMAPPED_PARENT = "unmapped";

function buildPanelCollectEval(hints: PanelCollectHints): string {
  return `
function __collectHeaderPanelAnchors() {
  const hints = ${JSON.stringify(hints)};
  const UNMAPPED = ${JSON.stringify(UNMAPPED_PARENT)};
  const MAX = 500;
  const panelSelectors = hints.panelContainerSelectors || [];
  const classPatternStrs = hints.panelClassPatterns || [];
  const classPatterns = classPatternStrs.map(function(p) { return new RegExp(p); });
  const menuBlockSelectors = hints.menuBlockSelectors || [];
  const requireAbsolute = hints.requireAbsolute !== false;
  const headerProximityPx = hints.headerProximityPx != null ? hints.headerProximityPx : 400;
  const minMenuBlocks = hints.minMenuBlocks != null ? hints.minMenuBlocks : 2;

  function maxTagId() {
    let max = 0;
    for (const el of document.querySelectorAll("[data-tag-id]")) {
      const id = parseInt(el.getAttribute("data-tag-id") || "", 10);
      if (Number.isFinite(id) && id > max) max = id;
    }
    return max;
  }

  function normalizeHref(href) {
    if (!href) return "";
    try {
      const u = new URL(href, location.href);
      return u.pathname + u.search + u.hash;
    } catch {
      return href.trim();
    }
  }

  function isDeadHref(href) {
    if (!href) return true;
    const h = href.trim().toLowerCase();
    return h === "#" || h.startsWith("javascript:void");
  }

  function headerRoots() {
    const roots = [];
    const header = document.querySelector("header");
    if (header) roots.push(header);
    const banner = document.querySelector("[role='banner']");
    if (banner && banner !== header) roots.push(banner);
    return roots;
  }

  function isAbsoluteEl(el) {
    const cls = String(el.className || "");
    if (/\\babsolute\\b/.test(cls)) return true;
    return window.getComputedStyle(el).position === "absolute";
  }

  function extractHeadingText(el) {
    if (!el || !(el instanceof HTMLElement)) return "";
    const tag = el.tagName;
    const role = el.getAttribute("role");
    if (/^H[1-6]$/.test(tag) || role === "heading") {
      const t = (el.textContent || "").trim();
      if (t.length >= 2 && t.length <= 80) return t.slice(0, 80);
    }
    if (tag === "P" || tag === "SPAN") {
      const t = (el.textContent || "").trim();
      if (t.length >= 2 && t.length <= 80 && !el.querySelector("a[href]")) return t.slice(0, 80);
    }
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim().length >= 2) return aria.trim().slice(0, 80);
    return "";
  }

  function findHeadingLabel(scope) {
    const nodes = scope.querySelectorAll(
      "p, span, h1, h2, h3, h4, h5, h6, [aria-label], [role='heading']"
    );
    for (const node of nodes) {
      if (node.closest("a[href]") && node.closest("a[href]") !== scope) continue;
      const t = extractHeadingText(node);
      if (t) return t;
    }
    return "";
  }

  function countMenuBlocks(container) {
    let blocks = 0;
    for (const child of container.children) {
      if (!(child instanceof HTMLElement)) continue;
      const hasAnchor = child.querySelector("a[href]");
      const hasHeading = findHeadingLabel(child);
      if (hasAnchor || hasHeading) blocks++;
    }
    return blocks;
  }

  function scorePanelContainer(el) {
    const blocks = countMenuBlocks(el);
    const anchors = el.querySelectorAll("a[href]").length;
    return { score: blocks * 10 + anchors, blocks };
  }

  function findPanelByAdapterHints() {
    for (const sel of panelSelectors) {
      const el = document.querySelector(sel);
      if (el instanceof HTMLElement && el.querySelectorAll("a[href]").length > 0) return el;
    }

    for (const root of headerRoots()) {
      for (const el of root.querySelectorAll("div, section, nav")) {
        if (!(el instanceof HTMLElement)) continue;
        if (requireAbsolute && !isAbsoluteEl(el)) continue;
        const cls = String(el.className || "");
        if (!classPatterns.some(function(re) { return re.test(cls); })) continue;
        if (el.querySelectorAll("a[href]").length > 0) return el;
      }
    }
    return null;
  }

  function findPanelByGenericHeuristic() {
    const header = document.querySelector("header") || document.querySelector("[role='banner']");
    const headerRect = header ? header.getBoundingClientRect() : null;
    let best = null;
    let bestScore = 0;

    for (const el of document.querySelectorAll("div, section")) {
      if (!(el instanceof HTMLElement)) continue;
      if (!isAbsoluteEl(el)) continue;
      if (headerRect) {
        const r = el.getBoundingClientRect();
        if (r.top > headerRect.bottom + headerProximityPx) continue;
      }
      const { score, blocks } = scorePanelContainer(el);
      if (blocks < minMenuBlocks) continue;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function findParentMenu(anchor, container) {
    if (menuBlockSelectors.length) {
      let cur = anchor.parentElement;
      while (cur && cur !== container) {
        for (const sel of menuBlockSelectors) {
          if (cur.matches && cur.matches(sel)) {
            const label = findHeadingLabel(cur);
            if (label) return label;
          }
        }
        cur = cur.parentElement;
      }
    }

    let cur = anchor;
    while (cur && cur !== container) {
      let sib = cur.previousElementSibling;
      while (sib) {
        const t = extractHeadingText(sib) || findHeadingLabel(sib);
        if (t) return t;
        sib = sib.previousElementSibling;
      }
      cur = cur.parentElement;
    }

    cur = anchor.parentElement;
    while (cur && cur !== container) {
      const label = findHeadingLabel(cur);
      if (label) return label;
      cur = cur.parentElement;
    }
    return "";
  }

  function setPanelMeta(anchor, parentMenu, linkText) {
    const pm = parentMenu || UNMAPPED;
    anchor.setAttribute("data-parent-menu", pm);
    const domPath = ["header", "nav", pm, linkText].filter(Boolean).join(">");
    anchor.setAttribute("data-panel-dom-path", domPath);
  }

  function isHiddenLink(el) {
    if (!(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    const opacity = parseFloat(style.opacity || "1");
    if (opacity < 0.05) return true;
    if (style.visibility === "hidden") return true;
    if (style.pointerEvents === "none") return true;
    if (style.maxHeight === "0px" || style.maxHeight === "0") return true;
    if (style.display === "none") return true;
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      if (cur.getAttribute("aria-expanded") === "false") return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function processAnchor(a, container, seenHref, state) {
    if (!(a instanceof HTMLAnchorElement)) return;
    const href = a.getAttribute("href") || "";
    if (isDeadHref(href)) return;

    state.anchors++;
    const linkText = (a.textContent || "").trim().slice(0, 80);
    const rawParent = container ? findParentMenu(a, container) : "";
    const parentMenu = rawParent || UNMAPPED;
    if (parentMenu === UNMAPPED) state.unmapped++;
    else {
      state.parentSet.add(parentMenu);
      state.mapped[parentMenu] = (state.mapped[parentMenu] || 0) + 1;
    }

    const norm = normalizeHref(href);
    const existingId = a.getAttribute("data-tag-id");

    if (existingId) {
      setPanelMeta(a, parentMenu, linkText);
      if (seenHref.has(norm)) state.skippedDuplicate++;
      else seenHref.add(norm);
      return;
    }

    if (seenHref.has(norm)) {
      state.skippedDuplicate++;
      setPanelMeta(a, parentMenu, linkText);
      return;
    }

    if (state.nextId > MAX) return;

    setPanelMeta(a, parentMenu, linkText);
    a.setAttribute("data-tag-id", String(state.nextId++));
    seenHref.add(norm);
    state.tagged++;
  }

  const seenHref = new Set();
  for (const a of document.querySelectorAll("a[href][data-tag-id]")) {
    const href = a.getAttribute("href") || "";
    if (!isDeadHref(href)) seenHref.add(normalizeHref(href));
  }

  const state = {
    nextId: maxTagId() + 1,
    anchors: 0,
    tagged: 0,
    skippedDuplicate: 0,
    unmapped: 0,
    mapped: {},
    parentSet: new Set(),
  };

  let panel = findPanelByAdapterHints();
  if (!panel) panel = findPanelByGenericHeuristic();

  if (panel) {
    panel.setAttribute("data-header-panel", "true");
    for (const a of panel.querySelectorAll("a[href]")) {
      processAnchor(a, panel, seenHref, state);
    }
    return {
      containerFound: true,
      anchors: state.anchors,
      tagged: state.tagged,
      skippedDuplicate: state.skippedDuplicate,
      mapped: state.mapped,
      unmapped: state.unmapped,
      parents: Array.from(state.parentSet),
    };
  }

  const scanRoots = document.querySelectorAll("header, nav, [role='navigation']");
  const scannedAnchors = new Set();
  for (const root of scanRoots) {
    for (const a of root.querySelectorAll("a[href]")) {
      if (scannedAnchors.has(a)) continue;
      scannedAnchors.add(a);
      if (!isHiddenLink(a)) continue;
      processAnchor(a, null, seenHref, state);
    }
  }

  return {
    containerFound: false,
    fallback: "header_scan",
    anchors: state.anchors,
    tagged: state.tagged,
    skippedDuplicate: state.skippedDuplicate,
    mapped: state.mapped,
    unmapped: state.unmapped,
    parents: Array.from(state.parentSet),
  };
}
`.trim();
}

export function formatPanelCollectLog(result: PanelCollectResult): string {
  const mappedStr = Object.entries(result.mapped)
    .map(([k, v]) => `${k.replace(/\s+/g, "")}:${v}`)
    .join(",");
  const parentsStr = result.parents.map((p) => p.replace(/\s+/g, "")).join(",");

  if (result.fallback === "header_scan") {
    return (
      `[panel-collect] container=not_found fallback=header_scan ` +
      `anchors=${result.anchors} unmapped=${result.unmapped} tagged=${result.tagged}`
    );
  }

  return (
    `[panel-collect] container=${result.containerFound ? "found" : "missing"} ` +
    `anchors=${result.anchors} parents=[${parentsStr}] ` +
    `mapped={${mappedStr}} unmapped=${result.unmapped}`
  );
}

/**
 * Collect GNB panel or header hidden links regardless of opacity.
 * Priority: adapter hints → generic heuristic → header_scan fallback.
 */
export async function collectHeaderPanelAnchors(
  page: Page,
  hints: PanelCollectHints = {}
): Promise<PanelCollectResult> {
  const evalBody = buildPanelCollectEval(hints);
  const result = (await page.evaluate(`(${evalBody})()`)) as PanelCollectResult;
  console.log(formatPanelCollectLog(result));
  return result;
}

/** Tag hidden nav/menu links already in DOM (display:none etc.) when reveal fails. */
export async function collectHiddenDomMenuItems(page: Page): Promise<number> {
  return page.evaluate(() => {
    let max = 0;
    for (const el of Array.from(document.querySelectorAll("[data-tag-id]"))) {
      const id = parseInt(el.getAttribute("data-tag-id") || "", 10);
      if (Number.isFinite(id) && id > max) max = id;
    }
    let nextId = max + 1;
    let added = 0;

    const roots = Array.from(
      document.querySelectorAll(
        "header, nav, [role='navigation'], [role='menu'], footer nav"
      )
    );

    for (const root of roots) {
      for (const el of Array.from(
        root.querySelectorAll("a, button, [role='menuitem'], [role='link']")
      )) {
        if (nextId > 500) break;
        if (!(el instanceof HTMLElement)) continue;
        if (el.getAttribute("data-tag-id")) continue;
        if (el.closest("[data-header-panel]")) continue;

        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const hidden =
          style.display === "none" ||
          style.visibility === "hidden" ||
          parseFloat(style.opacity || "1") < 0.05 ||
          rect.width <= 0 ||
          rect.height <= 0;

        if (!hidden) continue;

        const directP = el.querySelector(":scope > p");
        const text = (
          (directP?.textContent || "").trim() ||
          (el.textContent || "").trim() ||
          el.getAttribute("aria-label") ||
          ""
        ).slice(0, 80);
        if (!text || text.length < 2) continue;

        el.setAttribute("data-tag-id", String(nextId++));
        added++;
      }
    }

    return added;
  });
}
