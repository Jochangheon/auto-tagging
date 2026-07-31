/**
 * Canonical element geometry + DOM locator — shared across positions.json,
 * candidates, transmission JSON, taxonomy members, and capture/review.
 */
import type { MenuRevealPathStep } from "./crawl-job.js";
import type { RecommendedTagCandidate } from "./crawl-job.js";
import type { HiddenReason, Platform, ViewportMode } from "./viewport.js";

export interface ElementBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ElementLocation {
  tag_id: number;
  /** Primary CSS selector to re-find the element in DOM */
  selector_hint: string;
  selectors_fallback?: string[];
  /** Document-space bbox on full-page capture (positions.json / overlay) */
  bbox: ElementBbox | null;
  platform?: Platform;
  viewport?: ViewportMode;
  /** Reference size of full-page capture for review scaling */
  page_width?: number;
  page_height?: number;
  /** Full-page screenshot URL (page_view) */
  capture_url?: string | null;
  /** Per-element screenshot URL (Phase 2) */
  element_capture_url?: string | null;
  menu_reveal_path?: MenuRevealPathStep[];
  hidden_reason?: HiddenReason;
  text?: string;
}

export interface ElementLocationPageMeta {
  viewport?: ViewportMode;
  page_width?: number;
  page_height?: number;
  capture_url?: string | null;
}

export function hasElementBbox(bbox: ElementBbox | null | undefined): boolean {
  if (!bbox) return false;
  return bbox.w > 0 && bbox.h > 0;
}

/**
 * Tag-time heuristics (offscreen, collapsed_parent) can disagree with a confirmed
 * document bbox on the full-page capture. Bbox wins — the element is on the page.
 */
export function reconcileHiddenReasonWithBbox(
  reason: HiddenReason | undefined,
  bbox: ElementBbox | null | undefined
): HiddenReason {
  if (hasElementBbox(bbox)) {
    if (reason === "offscreen" || reason === "collapsed_parent") return "visible";
    return reason ?? "visible";
  }
  if (!reason || reason === "visible") return "zero_size";
  return reason;
}

/** Build canonical location object from a workspace candidate (+ optional page capture meta). */
export function buildElementLocation(
  c: RecommendedTagCandidate,
  pageMeta?: ElementLocationPageMeta
): ElementLocation {
  const tagId = c.tag_id;
  const loc: ElementLocation = {
    tag_id: tagId,
    selector_hint: c.selector_hint?.trim() || `[data-tag-id="${tagId}"]`,
    bbox: c.overlay_bbox ?? null,
    platform: c.platform,
    element_capture_url: c.element_capture_url ?? null,
    menu_reveal_path: c.menu_reveal_path,
    hidden_reason: reconcileHiddenReasonWithBbox(c.hidden_reason, c.overlay_bbox),
    text: (c.text || c.label || "").slice(0, 120),
  };
  if (c.selectors_fallback?.length) {
    loc.selectors_fallback = [...c.selectors_fallback];
  }
  if (pageMeta?.viewport) loc.viewport = pageMeta.viewport;
  if (pageMeta?.page_width && pageMeta.page_width > 0) loc.page_width = pageMeta.page_width;
  if (pageMeta?.page_height && pageMeta.page_height > 0) loc.page_height = pageMeta.page_height;
  if (pageMeta?.capture_url) loc.capture_url = pageMeta.capture_url;
  return loc;
}

/** Merge a positions.json row onto a partial location (selector/bbox from disk win when set). */
export function mergeElementLocation(
  base: ElementLocation,
  row?: Partial<ElementLocation> | null
): ElementLocation {
  if (!row) return base;
  return {
    ...base,
    ...row,
    tag_id: row.tag_id ?? base.tag_id,
    selector_hint: row.selector_hint?.trim() || base.selector_hint,
    selectors_fallback: row.selectors_fallback?.length
      ? row.selectors_fallback
      : base.selectors_fallback,
    bbox: row.bbox ?? base.bbox,
    platform: row.platform ?? base.platform,
    viewport: row.viewport ?? base.viewport,
    page_width: row.page_width ?? base.page_width,
    page_height: row.page_height ?? base.page_height,
    capture_url: row.capture_url ?? base.capture_url,
    element_capture_url: row.element_capture_url ?? base.element_capture_url,
    menu_reveal_path: row.menu_reveal_path ?? base.menu_reveal_path,
    hidden_reason: reconcileHiddenReasonWithBbox(
      row.hidden_reason ?? base.hidden_reason,
      row.bbox ?? base.bbox
    ),
    text: row.text ?? base.text,
  };
}
