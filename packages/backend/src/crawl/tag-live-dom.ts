import type { ViewportMode } from "@autotag/shared";
import { INTERACTIVE_SELECTOR, BROWSER_LABEL_FN, BROWSER_DOM_PATH_FN } from "@autotag/shared";
import type { DomPathContext, Platform } from "@autotag/shared";
import { interactCode } from "./firecrawl-interact.js";
import { BROWSER_CLASSIFY_PLATFORM_FN, logPlatformDiagnostics } from "./platform-classifier.js";

export interface OverlayBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type HiddenReason =
  | "display_none"
  | "visibility_hidden"
  | "opacity_zero"
  | "zero_size"
  | "offscreen"
  | "collapsed_parent"
  | "visible";

export interface LiveTagVisibilityDiag {
  display: string;
  visibility: string;
  opacity: number;
  zero_size: boolean;
  offscreen: boolean;
  collapsed_parent: { tag: string; className: string } | null;
  hidden_reason: HiddenReason;
  is_visible: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface LiveTagEntry {
  tag_id: number;
  tag: string;
  text: string;
  identification_hints: string;
  bbox: OverlayBbox | null;
  dom_path?: DomPathContext;
  visibility?: LiveTagVisibilityDiag;
  platform?: Platform;
  platform_reason?: string;
  /** Menu path to replay for reveal (from recursive explorer). */
  menu_reveal_path?: MenuRevealPathStep[];
}

export interface MenuRevealPathStep {
  key: string;
  label: string;
  method: "hover" | "click";
  selector_hint: string;
}

export interface TagLiveDomStats {
  raw_matched: number;
  tagged: number;
  dropped_cap: number;
  cursor_pointer_added?: number;
  cursor_pointer_labels?: string[];
  removed_wrappers?: number;
  candidates_before_dedup?: number;
}

export interface TagLiveDomResult {
  entries: LiveTagEntry[];
  stats: TagLiveDomStats;
}

const MAX_ELEMENTS = 800;

/** Browser-side eval for interact/CDP — viewport-aware platform classification. */
export function buildTagLiveDomBrowserEval(viewport: ViewportMode = "pc"): string {
  return `
${BROWSER_LABEL_FN}
${BROWSER_DOM_PATH_FN}
${BROWSER_CLASSIFY_PLATFORM_FN}
const viewportMode = ${JSON.stringify(viewport)};
const sel = ${JSON.stringify(INTERACTIVE_SELECTOR)};
const MAX_ELEMENTS = ${MAX_ELEMENTS};

function isTinyDecorative(el) {
  const r = el.getBoundingClientRect();
  if (r.width >= 16 || r.height >= 16) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "button" || tag === "input" || tag === "select" || tag === "textarea") return false;
  if (tag === "a") {
    const href = el.getAttribute("href") || "";
    if (href && href !== "#" && !href.toLowerCase().startsWith("javascript:")) return false;
  }
  return true;
}

function bboxFor(el) {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 && r.height <= 0) return null;
  return {
    x: Math.round(r.x + window.scrollX),
    y: Math.round(r.y + window.scrollY),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

function classifyVisibility(el) {
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const display = style.display;
  const visibility = style.visibility;
  const opacity = parseFloat(style.opacity || "1");
  const zero_size = rect.width <= 0 && rect.height <= 0;
  const in_viewport =
    !zero_size &&
    rect.bottom >= 0 &&
    rect.top <= window.innerHeight &&
    rect.right >= 0 &&
    rect.left <= window.innerWidth;

  let collapsed_parent = null;
  let hidden_reason = "visible";

  if (display === "none") hidden_reason = "display_none";
  else if (visibility === "hidden") hidden_reason = "visibility_hidden";
  else if (opacity === 0) hidden_reason = "opacity_zero";
  else if (zero_size) hidden_reason = "zero_size";
  else {
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      const ps = window.getComputedStyle(cur);
      if (
        ps.display === "none" ||
        cur.hasAttribute("hidden") ||
        ps.visibility === "hidden"
      ) {
        collapsed_parent = {
          tag: cur.tagName.toLowerCase(),
          className: String(cur.className || "").slice(0, 60),
        };
        hidden_reason = "collapsed_parent";
        break;
      }
      cur = cur.parentElement;
    }
  }

  // Ancestor flagged hidden but element still paints → false positive (aria-hidden etc.)
  if (hidden_reason === "collapsed_parent" && !zero_size) {
    hidden_reason = "visible";
    collapsed_parent = null;
  }

  return {
    display,
    visibility,
    opacity,
    zero_size,
    offscreen: !in_viewport,
    in_viewport,
    collapsed_parent,
    hidden_reason,
    is_visible: hidden_reason === "visible",
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

function applyPanelParentContext(el, domPath) {
  const parentMenu = (el.getAttribute("data-parent-menu") || "").trim();
  const panelPath = (el.getAttribute("data-panel-dom-path") || "").trim();
  if (!parentMenu && !panelPath) return domPath;

  const linkLabel = (el.textContent || "").trim().slice(0, 40);
  const dom_path =
    panelPath || ["header", "nav", parentMenu, linkLabel].filter(Boolean).join(">");
  const parent_labels = [...(domPath.parent_labels || [])];
  if (parentMenu && parent_labels.indexOf(parentMenu) < 0) {
    parent_labels.unshift(parentMenu);
  }
  return {
    dom_path,
    parent_labels: parent_labels.slice(0, 6),
    section_heading: parentMenu || domPath.section_heading,
  };
}

function enrichIdentificationHints(el, hints) {
  const parts = [];
  if (hints) parts.push(hints);
  const parentMenu = (el.getAttribute("data-parent-menu") || "").trim();
  if (parentMenu) parts.push("parent_menu=" + parentMenu);

  let href = "";
  if (el.tagName && el.tagName.toLowerCase() === "a") {
    href = (el.getAttribute("href") || "").trim();
  }
  if (!href) {
    const parentA = el.closest && el.closest("a[href]");
    if (parentA) href = (parentA.getAttribute("href") || "").trim();
  }
  if (!href) {
    const innerA = el.querySelector && el.querySelector("a[href]");
    if (innerA) href = (innerA.getAttribute("href") || "").trim();
  }
  if (href && href !== "#" && !/^javascript:/i.test(href)) {
    parts.push("href=" + href);
  }
  return parts.join(" ");
}

function sortKey(entry) {
  if (!entry.bbox) return [999999, 999999, entry.tag_id];
  return [entry.bbox.y, entry.bbox.x, entry.tag_id];
}

function maxTagId() {
  let max = 0;
  for (const el of document.querySelectorAll("[data-tag-id]")) {
    const id = parseInt(el.getAttribute("data-tag-id") || "", 10);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max;
}

let nextId = maxTagId() + 1;
const allMatched = document.querySelectorAll(sel);
const pointerCandidates = collectPointerLikeElements(sel);
const raw_matched = allMatched.length + pointerCandidates.length;
const entries = [];
let dropped_cap = 0;
let cursor_pointer_added = 0;
const cursor_pointer_labels = [];

function collectPriority(el) {
  const vis = classifyVisibility(el);
  let score = vis.is_visible ? 0 : 1000;
  const tag = el.tagName.toLowerCase();
  if (tag === "a" || tag === "button") score -= 40;
  const cls = String(el.className || "");
  if (/\\bbtn\\b|button|link-button/i.test(cls)) score -= 45;
  if (el.closest(".swiper-slide-active, [class*='slide-active'], [class*='deal-carousel']")) score -= 40;
  if (el.closest("header, nav, footer, main, [role='navigation'], [role='banner'], [class*='carousel']")) {
    score -= 30;
  }
  const rect = el.getBoundingClientRect();
  score += Math.max(0, rect.y);
  return score;
}

function isCollectibleHidden(visibility) {
  const hr = visibility.hidden_reason;
  return hr === "display_none" || hr === "visibility_hidden" || hr === "opacity_zero" || hr === "zero_size";
}

function finalizeVisibility(visibility, bbox) {
  if (!bbox || bbox.w <= 0 || bbox.h <= 0) return visibility;
  if (visibility.hidden_reason === "offscreen" || visibility.hidden_reason === "collapsed_parent") {
    return { ...visibility, hidden_reason: "visible", is_visible: true, collapsed_parent: null };
  }
  return visibility;
}

function pushTaggedEntry(el, tagId) {
  const tag = el.tagName.toLowerCase();
  const labeled = resolveElementLabel(el);
  const domPath = applyPanelParentContext(el, extractDomPathContext(el));
  const hints = enrichIdentificationHints(el, labeled.identification_hints);
  const bbox = bboxFor(el);
  let visibility = finalizeVisibility(classifyVisibility(el), bbox);
  const { platform, reason: platform_reason } = classifyPlatform(el, visibility, viewportMode);
  entries.push({
    tag_id: tagId,
    tag,
    text: labeled.text,
    identification_hints: hints,
    bbox,
    dom_path: domPath,
    visibility,
    platform,
    platform_reason,
  });
}

// Phase 1 — elements already tagged by panel/hidden collectors (no cap gate).
// Keep CSS-hidden items: GNB dropdown / panel links are often display:none or
// opacity:0 until hover. assignExtraTags / collectHiddenDomMenuItems stamped them.
const preTagged = document.querySelectorAll("[data-tag-id]");
for (const el of preTagged) {
  if (shouldExcludeInteractiveWrapper(el)) continue;
  const existing = el.getAttribute("data-tag-id");
  if (!existing) continue;
  const id = parseInt(existing, 10);
  if (!Number.isFinite(id) || id <= 0) continue;
  pushTaggedEntry(el, id);
}

// Phase 2 — assign new tags to unmatched interactives (visible CTAs first).
const freshMatched = [];
for (const el of allMatched) {
  if (shouldExcludeInteractiveWrapper(el)) continue;
  if (el.getAttribute("data-tag-id")) continue;
  if (isTinyDecorative(el)) continue;
  const visibility = classifyVisibility(el);
  if (isCollectibleHidden(visibility)) continue;
  freshMatched.push(el);
}
freshMatched.sort((a, b) => collectPriority(a) - collectPriority(b));

for (const el of freshMatched) {
  if (entries.length >= MAX_ELEMENTS) {
    dropped_cap++;
    continue;
  }
  const tagId = nextId++;
  el.setAttribute("data-tag-id", String(tagId));
  pushTaggedEntry(el, tagId);
}

// Phase 3 — role/onclick blocks not covered by INTERACTIVE_SELECTOR.
const freshPointer = pointerCandidates.filter((el) => !el.getAttribute("data-tag-id"));
freshPointer.sort((a, b) => collectPriority(a) - collectPriority(b));

for (const el of freshPointer) {
  if (entries.length >= MAX_ELEMENTS) {
    dropped_cap++;
    continue;
  }
  const visibility = classifyVisibility(el);
  if (isCollectibleHidden(visibility)) continue;
  if (isTinyDecorative(el)) continue;
  const tagId = nextId++;
  el.setAttribute("data-tag-id", String(tagId));
  cursor_pointer_added++;
  const labeled = resolveElementLabel(el);
  cursor_pointer_labels.push(labeled.text.slice(0, 30));
  pushTaggedEntry(el, tagId);
}

entries.sort((a, b) => {
  const [ay, ax, aid] = sortKey(a);
  const [by, bx, bid] = sortKey(b);
  return ay - by || ax - bx || aid - bid;
});

const beforeDedup = entries.length;
const { entries: dedupedEntries, removed_wrappers } = dedupeCollectedEntries(entries);

return {
  entries: dedupedEntries,
  stats: { raw_matched, tagged: dedupedEntries.length, dropped_cap, cursor_pointer_added, cursor_pointer_labels, removed_wrappers, candidates_before_dedup: beforeDedup },
};
`.trim();
}

/** @deprecated use buildTagLiveDomBrowserEval(viewport) */
export const TAG_LIVE_DOM_BROWSER_EVAL = buildTagLiveDomBrowserEval("pc");

/** Log hidden diagnostics + invariant after live DOM collection. */
export function logTagLiveDomDiagnostics(result: TagLiveDomResult, label = "tag-live-dom"): void {
  const { entries, stats } = result;
  const byReason: Record<string, number> = {};
  let visible = 0;

  for (const e of entries) {
    const reason = e.visibility?.hidden_reason ?? (e.bbox ? "visible" : "zero_size");
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    if (reason === "visible") visible++;
  }

  const hidden = entries.length - visible;
  console.log(
    `[hidden 진단] ${label} total=${entries.length} visible=${visible} hidden=${hidden} ` +
      `collapsed_parent=${byReason.collapsed_parent ?? 0} display_none=${byReason.display_none ?? 0} ` +
      `visibility_hidden=${byReason.visibility_hidden ?? 0} opacity_zero=${byReason.opacity_zero ?? 0} ` +
      `zero_size=${byReason.zero_size ?? 0} offscreen=${byReason.offscreen ?? 0}`
  );

  for (const e of entries) {
    const v = e.visibility;
    if (!v || v.hidden_reason === "visible") continue;
    const cp = v.collapsed_parent
      ? `${v.collapsed_parent.tag}.${v.collapsed_parent.className.slice(0, 30)}`
      : "-";
    const rect = v.rect;
    console.log(
      `[hidden diag] tag_id=${e.tag_id} text="${e.text.slice(0, 30)}" ` +
        `rect={x:${rect?.x},y:${rect?.y},w:${rect?.width},h:${rect?.height}} ` +
        `display=${v.display} visibility=${v.visibility} opacity=${v.opacity} ` +
        `zero_size=${v.zero_size} offscreen=${v.offscreen} collapsed_parent=${cp} ` +
        `hidden_reason=${v.hidden_reason}`
    );
  }

  const dropped = stats.raw_matched - stats.tagged;
  const droppedCap = stats.dropped_cap ?? 0;
  const cpAdded = stats.cursor_pointer_added ?? 0;
  if (cpAdded > 0) {
    const labels = (stats.cursor_pointer_labels ?? []).slice(0, 12).join(", ");
    console.log(`[cursor-pointer 수집] added=${cpAdded}${labels ? ` (${labels})` : ""}`);
  }
  const beforeDedup = stats.candidates_before_dedup ?? entries.length;
  const removedWrappers = stats.removed_wrappers ?? 0;
  if (removedWrappers > 0 || beforeDedup !== entries.length) {
    console.log(
      `[dedup] candidates_before=${beforeDedup} after=${entries.length} removed_wrappers=${removedWrappers} (a/button leaf 우선)`
    );
  }
  console.log(
    `[정합성] ${label} raw=${stats.raw_matched} injected=${stats.tagged} final=${stats.tagged} ` +
      `dropped=${dropped} dropped_cap=${droppedCap}`
  );

  if (visible + hidden !== entries.length) {
    console.error(
      `[정합성 ERROR] ${label} visible(${visible}) + hidden(${hidden}) !== total(${entries.length})`
    );
  }
  if (dropped !== 0) {
    console.error(`[정합성 ERROR] ${label} dropped=${dropped} (raw - tagged mismatch)`);
  }
  if (droppedCap !== 0) {
    console.error(`[정합성 ERROR] ${label} dropped_cap=${droppedCap} (maxElements cap hit)`);
  }
}

/** Prefer visible bbox when merging snapshots from hover passes. */
export function mergeTagEntries(
  base: LiveTagEntry[],
  incoming: LiveTagEntry[]
): LiveTagEntry[] {
  const map = new Map<number, LiveTagEntry>();
  for (const e of base) map.set(e.tag_id, e);
  for (const e of incoming) {
    const prev = map.get(e.tag_id);
    if (!prev) {
      map.set(e.tag_id, e);
      continue;
    }
    const prevVis = prev.visibility?.is_visible === true;
    const nextVis = e.visibility?.is_visible === true;
    if (nextVis && !prevVis) {
      map.set(e.tag_id, e);
      continue;
    }
    if (nextVis === prevVis) {
      const prevArea = (prev.bbox?.w ?? 0) * (prev.bbox?.h ?? 0);
      const nextArea = (e.bbox?.w ?? 0) * (e.bbox?.h ?? 0);
      if (nextArea > prevArea) map.set(e.tag_id, e);
    }
  }
  return [...map.values()].sort((a, b) => {
    const ay = a.bbox?.y ?? 999999;
    const by = b.bbox?.y ?? 999999;
    const ax = a.bbox?.x ?? 999999;
    const bx = b.bbox?.x ?? 999999;
    return ay - by || ax - bx || a.tag_id - b.tag_id;
  });
}

/** Inject data-tag-id on live DOM — every selector match becomes a candidate. */
export async function tagLiveDomOnPage(
  page: import("playwright").Page,
  viewport: ViewportMode = "pc"
): Promise<TagLiveDomResult> {
  const evalBody = buildTagLiveDomBrowserEval(viewport);
  const parsed = (await page.evaluate(`(() => { ${evalBody} })()`)) as TagLiveDomResult;
  const result: TagLiveDomResult = {
    entries: parsed.entries ?? [],
    stats: {
      raw_matched: parsed.stats?.raw_matched ?? 0,
      tagged: parsed.stats?.tagged ?? 0,
      dropped_cap: parsed.stats?.dropped_cap ?? 0,
    },
  };
  logTagLiveDomDiagnostics(result, "tag-live-dom-cdp");
  logPlatformDiagnostics(result.entries);
  return result;
}

/** Inject data-tag-id on live DOM — every selector match becomes a candidate. */
export async function tagLiveDom(
  scrapeId: string,
  viewport: ViewportMode = "pc"
): Promise<TagLiveDomResult> {
  const evalBody = buildTagLiveDomBrowserEval(viewport);
  const code = `
await (async () => {
  const __tagResult = await page.evaluate(() => {
    ${evalBody}
  });
  return JSON.stringify(__tagResult);
})();
`.trim();

  const resp = await interactCode(scrapeId, code, 60);
  if (resp.success !== true) {
    throw new Error(`tagLiveDom failed: ${resp.error ?? JSON.stringify(resp)}`);
  }

  try {
    const parsed = JSON.parse(resp.result ?? "{}") as TagLiveDomResult;
    const result: TagLiveDomResult = {
      entries: parsed.entries ?? [],
      stats: {
        raw_matched: parsed.stats?.raw_matched ?? 0,
        tagged: parsed.stats?.tagged ?? 0,
        dropped_cap: parsed.stats?.dropped_cap ?? 0,
      },
    };
    logTagLiveDomDiagnostics(result);
    logPlatformDiagnostics(result.entries);
    return result;
  } catch {
    throw new Error(`tagLiveDom invalid JSON: ${resp.result?.slice(0, 200)}`);
  }
}
