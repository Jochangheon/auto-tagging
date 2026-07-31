import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { MenuRevealPathStep, ViewportMode } from "@autotag/shared";
import { disconnectCdp, ensureCdpConnected, applyCdpLiveViewViewport, hasCdpConnection } from "./cdp-session.js";
import { closeOpenMenus } from "./menu-explorer/open-trigger.js";
import {
  captureAbsPath,
  captureDir,
  preparePageForCapture,
  scrollToLoadLazyContent,
  type CaptureBbox,
} from "./page-capture.js";
import { tagLiveDomOnPage } from "./tag-live-dom.js";
import { refreshLiveViewSession, type FirecrawlSession } from "./firecrawl-interact.js";
import { isJobCancelled } from "./pipeline-cancel.js";

export interface ElementCaptureTarget {
  tag_id: number;
  menu_reveal_path?: MenuRevealPathStep[];
  /** Document coordinates from positions.json — primary capture source. */
  bbox?: CaptureBbox | null;
}

export interface ElementCaptureResult {
  tag_id: number;
  url: string;
  width: number;
  height: number;
  bbox: CaptureBbox | null;
  ok: boolean;
  reason?: string;
  via?: "live_bbox" | "live_dom" | "page_crop";
}

export function elementCaptureRelPath(tagId: number): string {
  return `tags/${tagId}.png`;
}

export function elementCaptureAbsPath(jobId: string, tagId: number): string {
  return path.join(captureDir(), jobId, elementCaptureRelPath(tagId));
}

export function elementCaptureApiUrl(jobId: string, tagId: number): string {
  return `/api/dev/captures/${jobId}/tags/${tagId}.png`;
}

const CLEAR_HIGHLIGHT_EVAL = `() => {
  document.querySelectorAll("[data-autotag-capture-highlight]").forEach((n) => n.remove());
}`;

/** Paint highlight + clip from stored document bbox (no DOM query for data-tag-id). */
const PAINT_HIGHLIGHT_AT_BBOX_EVAL = `
(bbox) => {
  document.querySelectorAll("[data-autotag-capture-highlight]").forEach((n) => n.remove());
  if (!bbox || bbox.w <= 0 || bbox.h <= 0) return null;
  window.scrollTo(0, Math.max(0, bbox.y - Math.floor(window.innerHeight * 0.35)));
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const vx = bbox.x - scrollX;
  const vy = bbox.y - scrollY;
  const box = document.createElement("div");
  box.setAttribute("data-autotag-capture-highlight", "1");
  box.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483646;" +
    "left:" + vx + "px;top:" + vy + "px;" +
    "width:" + bbox.w + "px;height:" + bbox.h + "px;" +
    "border:3px solid #f59e0b;background:rgba(245,158,11,0.22);box-sizing:border-box;border-radius:2px;";
  document.body.appendChild(box);
  const pad = 32;
  const clipX = Math.max(0, Math.floor(vx - pad));
  const clipY = Math.max(0, Math.floor(vy - pad));
  const clip = {
    x: clipX,
    y: clipY,
    width: Math.min(window.innerWidth - clipX, Math.ceil(bbox.w + pad * 2)),
    height: Math.min(window.innerHeight - clipY, Math.ceil(bbox.h + pad * 2)),
  };
  clip.width = Math.max(2, clip.width);
  clip.height = Math.max(2, clip.height);
  return { clip, bbox };
}
`;

const PAINT_HIGHLIGHT_EVAL = `
(tagId) => {
  document.querySelectorAll("[data-autotag-capture-highlight]").forEach((n) => n.remove());
  const el = document.querySelector('[data-tag-id="' + tagId + '"]');
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  if (r.width <= 0 && r.height <= 0) return null;
  const box = document.createElement("div");
  box.setAttribute("data-autotag-capture-highlight", "1");
  box.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483646;" +
    "left:" + r.x + "px;top:" + r.y + "px;" +
    "width:" + r.width + "px;height:" + r.height + "px;" +
    "border:3px solid #f59e0b;background:rgba(245,158,11,0.22);box-sizing:border-box;border-radius:2px;";
  document.body.appendChild(box);
  const pad = 32;
  const clip = {
    x: Math.max(0, Math.floor(r.x - pad)),
    y: Math.max(0, Math.floor(r.y - pad)),
    width: Math.min(window.innerWidth - Math.max(0, Math.floor(r.x - pad)), Math.ceil(r.width + pad * 2)),
    height: Math.min(window.innerHeight - Math.max(0, Math.floor(r.y - pad)), Math.ceil(r.height + pad * 2)),
  };
  clip.width = Math.max(2, clip.width);
  clip.height = Math.max(2, clip.height);
  return {
    clip,
    bbox: {
      x: Math.round(r.x + window.scrollX),
      y: Math.round(r.y + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    },
  };
}
`;

function bboxArea(bbox: CaptureBbox | null | undefined): number {
  if (!bbox) return 0;
  return Math.max(0, bbox.w) * Math.max(0, bbox.h);
}

async function persistElementPng(jobId: string, tagId: number, buffer: Buffer): Promise<void> {
  const abs = elementCaptureAbsPath(jobId, tagId);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buffer);
}

async function cropFromPagePng(
  jobId: string,
  viewport: ViewportMode,
  bbox: CaptureBbox,
  pageWidth: number,
  pageHeight: number
): Promise<{ buffer: Buffer; width: number; height: number } | null> {
  const pagePath = captureAbsPath(jobId, viewport);
  const pad = 32;

  try {
    const meta = await sharp(pagePath).metadata();
    const imgW = meta.width ?? pageWidth;
    const imgH = meta.height ?? pageHeight;
    if (imgW <= 0 || imgH <= 0) return null;

    // Always crop in actual PNG pixel space (1 CSS px ≈ 1 PNG px with scale:"css").
    // Ignore stale pageWidth/pageHeight meta that used to mis-scale below-fold boxes.
    void pageWidth;
    void pageHeight;
    const left = Math.max(0, Math.floor(bbox.x - pad));
    const top = Math.max(0, Math.floor(bbox.y - pad));
    // Entirely below/aside the captured PNG → cannot crop (short page shot).
    if (left >= imgW - 1 || top >= imgH - 1) return null;
    const width = Math.min(
      Math.max(2, Math.ceil(bbox.w + pad * 2)),
      Math.max(2, imgW - left)
    );
    const height = Math.min(
      Math.max(2, Math.ceil(bbox.h + pad * 2)),
      Math.max(2, imgH - top)
    );
    if (width <= 0 || height <= 0) return null;
    const extract = {
      left: Math.min(imgW - 2, left),
      top: Math.min(imgH - 2, top),
      width: Math.min(imgW, width),
      height: Math.min(imgH, height),
    };
    extract.width = Math.max(2, Math.min(extract.width, imgW - extract.left));
    extract.height = Math.max(2, Math.min(extract.height, imgH - extract.top));

    const innerW = Math.max(2, Math.floor(bbox.w));
    const innerH = Math.max(2, Math.floor(bbox.h));
    const border = 3;
    const overlaySvg = Buffer.from(
      `<svg width="${extract.width}" height="${extract.height}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect x="${Math.max(0, Math.floor(bbox.x - left))}" y="${Math.max(0, Math.floor(bbox.y - top))}" ` +
        `width="${innerW}" height="${innerH}" fill="rgba(245,158,11,0.22)" stroke="#f59e0b" stroke-width="${border}"/>` +
        `</svg>`
    );

    const buffer = await sharp(pagePath)
      .extract(extract)
      .composite([{ input: overlaySvg, top: 0, left: 0 }])
      .png()
      .toBuffer();

    return { buffer, width: extract.width, height: extract.height };
  } catch {
    return null;
  }
}

async function screenshotClip(
  page: import("playwright").Page,
  painted: { clip: { x: number; y: number; width: number; height: number }; bbox: CaptureBbox }
): Promise<Buffer> {
  try {
    return await page.screenshot({
      type: "png",
      clip: painted.clip,
      scale: "css",
    });
  } catch {
    return await page.screenshot({ type: "png", clip: painted.clip });
  }
}

async function captureOneElementLive(
  page: import("playwright").Page,
  jobId: string,
  target: ElementCaptureTarget
): Promise<ElementCaptureResult> {
  const fail = (reason: string): ElementCaptureResult => ({
    tag_id: target.tag_id,
    url: elementCaptureApiUrl(jobId, target.tag_id),
    width: 0,
    height: 0,
    bbox: target.bbox ?? null,
    ok: false,
    reason,
  });

  await page.evaluate(`(${CLEAR_HIGHLIGHT_EVAL})()`).catch(() => {});
  await closeOpenMenus(page);
  // Visible-only: never open menus to reach hidden items.
  await page.waitForTimeout(50);

  type PaintedClip = {
    clip: { x: number; y: number; width: number; height: number };
    bbox: CaptureBbox;
  };

  let painted: PaintedClip | null = null;
  let via: ElementCaptureResult["via"] = "live_bbox";

  if (bboxArea(target.bbox) > 0) {
    painted = (await page.evaluate(`(${PAINT_HIGHLIGHT_AT_BBOX_EVAL})`, target.bbox)) as PaintedClip | null;
  }

  if (!painted?.clip) {
    via = "live_dom";
    painted = (await page.evaluate(`(${PAINT_HIGHLIGHT_EVAL})`, target.tag_id)) as PaintedClip | null;
  }

  if (!painted?.clip) {
    await page.evaluate(`(${CLEAR_HIGHLIGHT_EVAL})()`).catch(() => {});
    return fail("highlight_failed");
  }

  let buffer: Buffer;
  try {
    buffer = await screenshotClip(page, painted);
  } catch {
    await page.evaluate(`(${CLEAR_HIGHLIGHT_EVAL})()`).catch(() => {});
    return fail("screenshot_failed");
  }

  await page.evaluate(`(${CLEAR_HIGHLIGHT_EVAL})()`).catch(() => {});
  await persistElementPng(jobId, target.tag_id, buffer);

  return {
    tag_id: target.tag_id,
    url: elementCaptureApiUrl(jobId, target.tag_id),
    width: painted.clip.width,
    height: painted.clip.height,
    bbox: painted.bbox ?? target.bbox ?? null,
    ok: true,
    via,
  };
}

async function captureOneElementCrop(
  jobId: string,
  viewport: ViewportMode,
  target: ElementCaptureTarget,
  pageWidth: number,
  pageHeight: number
): Promise<ElementCaptureResult> {
  const fail = (reason: string): ElementCaptureResult => ({
    tag_id: target.tag_id,
    url: elementCaptureApiUrl(jobId, target.tag_id),
    width: 0,
    height: 0,
    bbox: target.bbox ?? null,
    ok: false,
    reason,
  });

  if (bboxArea(target.bbox) <= 0) return fail("no_bbox_in_positions");

  const cropped = await cropFromPagePng(jobId, viewport, target.bbox!, pageWidth, pageHeight);
  if (!cropped) return fail("page_crop_failed");

  await persistElementPng(jobId, target.tag_id, cropped.buffer);
  return {
    tag_id: target.tag_id,
    url: elementCaptureApiUrl(jobId, target.tag_id),
    width: cropped.width,
    height: cropped.height,
    bbox: target.bbox ?? null,
    ok: true,
    via: "page_crop",
  };
}

/**
 * Session-less element capture: crop every target from the full-page PNG.
 * Used by the capture worker queue after Firecrawl has already been released.
 */
export async function captureElementThumbnailsOffline(
  jobId: string,
  viewport: ViewportMode,
  targets: ElementCaptureTarget[],
  pageSize: { width: number; height: number },
  onProgress?: (current: number, total: number) => void,
  onElementResult?: (tagId: number, result: ElementCaptureResult) => void
): Promise<Map<number, ElementCaptureResult>> {
  const results = new Map<number, ElementCaptureResult>();
  const actionable = targets.filter((t) => t.tag_id > 0);
  if (!actionable.length) return results;

  const pageWidth = pageSize.width;
  const pageHeight = pageSize.height;
  const tag = `job=${jobId.slice(0, 8)} viewport=${viewport}`;
  let okCount = 0;
  const total = actionable.length;

  for (let i = 0; i < actionable.length; i++) {
    if (isJobCancelled(jobId)) break;
    const target = actionable[i]!;
    const result = await captureOneElementCrop(jobId, viewport, target, pageWidth, pageHeight);
    results.set(target.tag_id, result);
    if (result.ok) okCount += 1;
    onProgress?.(i + 1, total);
    onElementResult?.(target.tag_id, result);
  }

  console.log(
    `[element-capture] offline done ${tag} ok=${okCount}/${actionable.length} via=page_crop`
  );
  return results;
}

/** Per-element capture: positions.json bbox → live clip, else crop from page_view PNG. */
export async function captureElementThumbnails(
  session: Pick<FirecrawlSession, "scrapeId" | "cdpUrl">,
  jobId: string,
  viewport: ViewportMode,
  pageUrl: string,
  targets: ElementCaptureTarget[],
  onProgress?: (current: number, total: number) => void,
  onElementResult?: (tagId: number, result: ElementCaptureResult) => void,
  pageSize?: { width: number; height: number }
): Promise<Map<number, ElementCaptureResult>> {
  const results = new Map<number, ElementCaptureResult>();
  const actionable = targets.filter((t) => t.tag_id > 0);
  if (!actionable.length) return results;

  const pageWidth = pageSize?.width ?? 0;
  const pageHeight = pageSize?.height ?? 0;
  const tag = `job=${jobId.slice(0, 8)} viewport=${viewport}`;
  let okCount = 0;

  const total = actionable.length;
  const canCrop = pageWidth > 0 && pageHeight > 0;

  // An element only needs a *live* browser capture when it must be revealed via
  // a menu (not present in the base full-page screenshot) or has no usable bbox.
  // Everything else is cropped straight from the page PNG — no browser trip.
  const needsLive = (t: ElementCaptureTarget): boolean => {
    if (!canCrop) return true;
    if (bboxArea(t.bbox) <= 0) return true;
    return false;
  };

  const cropOnly = async (): Promise<void> => {
    for (let i = 0; i < actionable.length; i++) {
      if (isJobCancelled(jobId)) break;
      const target = actionable[i]!;
      const result = await captureOneElementCrop(jobId, viewport, target, pageWidth, pageHeight);
      results.set(target.tag_id, result);
      if (result.ok) okCount += 1;
      onProgress?.(i + 1, total);
      onElementResult?.(target.tag_id, result);
    }
  };

  // Fast path: every element is croppable → skip CDP entirely. This removes the
  // per-element browser round-trips that made Phase 2 take minutes.
  if (canCrop && !actionable.some(needsLive)) {
    await cropOnly();
    console.log(`[element-capture] done ${tag} ok=${okCount}/${actionable.length} via=page_crop(all)`);
    return results;
  }

  let working = session;
  if (!working.cdpUrl && working.scrapeId) {
    const refreshed = await refreshLiveViewSession(working as FirecrawlSession);
    if (refreshed.ok && refreshed.session.cdpUrl) {
      working = refreshed.session;
    }
  }

  if (!working.cdpUrl) {
    console.warn(`[element-capture] no cdpUrl ${tag} — cropping all from page PNG`);
    await cropOnly();
    console.log(`[element-capture] done ${tag} ok=${okCount}/${actionable.length} via=page_crop`);
    return results;
  }

  const reusedCdp = hasCdpConnection(working.cdpUrl);
  const page = await ensureCdpConnected(working.cdpUrl, pageUrl);

  try {
    await applyCdpLiveViewViewport(viewport, { page }).catch(() => {});
    // Page capture (Phase 1) already dismissed modals + lazy-scrolled when
    // keepAlive left this CDP session open — skip the expensive re-prep.
    if (!reusedCdp) {
      await preparePageForCapture(page, pageUrl, viewport, {
        skipNetworkIdle: true,
        maxModalAttempts: 2,
      });
      await scrollToLoadLazyContent(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await tagLiveDomOnPage(page, viewport);
    } else {
      await page.keyboard.press("Escape").catch(() => {});
      await closeOpenMenus(page);
      await page.evaluate(() => window.scrollTo(0, 0));
    }

    for (let i = 0; i < actionable.length; i++) {
      if (isJobCancelled(jobId)) break;
      const target = actionable[i]!;
      let result: ElementCaptureResult;
      if (!needsLive(target)) {
        // Crop first (fast); only pay for a live capture if the crop fails.
        result = await captureOneElementCrop(jobId, viewport, target, pageWidth, pageHeight);
        if (!result.ok) result = await captureOneElementLive(page, jobId, target);
      } else {
        result = await captureOneElementLive(page, jobId, target);
        if (!result.ok && canCrop) {
          result = await captureOneElementCrop(jobId, viewport, target, pageWidth, pageHeight);
        }
      }
      results.set(target.tag_id, result);
      if (result.ok) okCount += 1;
      onProgress?.(i + 1, total);
      onElementResult?.(target.tag_id, result);
    }
  } finally {
    await page.evaluate(`(${CLEAR_HIGHLIGHT_EVAL})()`).catch(() => {});
    await disconnectCdp(working.cdpUrl);
  }

  const viaStats = [...results.values()].reduce(
    (acc, r) => {
      if (!r.ok) acc.failed += 1;
      else if (r.via === "page_crop") acc.crop += 1;
      else acc.live += 1;
      return acc;
    },
    { live: 0, crop: 0, failed: 0 }
  );
  console.log(
    `[element-capture] done ${tag} ok=${okCount}/${actionable.length} live=${viaStats.live} crop=${viaStats.crop} failed=${viaStats.failed}`
  );
  return results;
}
