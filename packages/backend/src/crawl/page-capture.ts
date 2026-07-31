import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViewportMode } from "@autotag/shared";
import { resolveCdpDeviceMetrics, resolveMoStreamCrop } from "@autotag/shared";
import { connectOverCdp, disconnectCdp, ensureCdpConnected, applyCdpLiveViewViewport, hasCdpConnection } from "./cdp-session.js";
import {
  BROWSER_DISMISS_MODALS_EVAL,
  dismissOverlaysBeforeReveal,
  removeBlockingModals,
} from "./menu-explorer/dismiss-overlays.js";
import { closeOpenMenus } from "./menu-explorer/open-trigger.js";
import { pickSiteAdapter } from "./menu-explorer/site-adapters/index.js";
import {
  interactCode,
  refreshLiveViewSession,
  setViewport,
  setViewportAndReload,
  type FirecrawlSession,
} from "./firecrawl-interact.js";
import type { LiveTagEntry } from "./tag-live-dom.js";
import { tagLiveDomOnPage } from "./tag-live-dom.js";
import { assignExtraTagsOnPage } from "./menu-explorer/assign-extra-tags.js";
import { collectHiddenDomMenuItems } from "./menu-explorer/dom-fallback-collect.js";
import { updateJobProgress } from "./job-store.js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface CaptureBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CaptureBboxMap = Record<number, CaptureBbox>;

export function captureDir(): string {
  return path.join(backendRoot, "data", "captures");
}

export function captureRelativePath(jobId: string, viewport: ViewportMode): string {
  return `${jobId}/${viewport}.png`;
}

export function captureApiUrl(jobId: string, viewport: ViewportMode): string {
  return `/api/dev/captures/${jobId}/${viewport}.png`;
}

export function captureAbsPath(jobId: string, viewport: ViewportMode): string {
  return path.join(captureDir(), captureRelativePath(jobId, viewport));
}

export interface PageCaptureResult {
  url: string;
  width: number;
  height: number;
  bboxes: CaptureBboxMap;
  /** Full tag scan at capture time (clean page, scroll 0) — merges into explore entries. */
  tag_entries?: LiveTagEntry[];
  refreshed_entries?: LiveTagEntry[];
  png_bytes?: number;
  modal_cleared?: boolean;
  /** HTML captured during CDP session — avoids a separate interact round-trip. */
  html?: string;
}

/** Scroll through the page to trigger lazy-loaded images, then return to top. */
const SCROLL_LAZY_LOAD_EVAL = `
await (async () => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = Math.max(400, Math.floor(window.innerHeight * 0.95));
  const maxY = Math.max(
    document.body.scrollHeight || 0,
    document.documentElement.scrollHeight || 0,
    window.innerHeight
  );
  // Cap steps so tall pages (6k–15k px) don't burn 10–20s on lazy scroll alone.
  const maxSteps = 10;
  const totalSteps = Math.max(1, Math.ceil(maxY / step));
  const stride = totalSteps <= maxSteps ? step : Math.ceil(maxY / maxSteps);
  for (let y = 0; y <= maxY; y += stride) {
    window.scrollTo(0, y);
    await delay(50);
  }
  try {
    document.documentElement.style.scrollBehavior = "auto";
    document.body.style.scrollBehavior = "auto";
  } catch {}
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  await delay(120);
})();
`;

/** Document-level bbox at scrollY=0 — matches full-page screenshot. */
const CAPTURE_BBOX_EVAL = `
try {
  document.documentElement.style.scrollBehavior = "auto";
  document.body.style.scrollBehavior = "auto";
} catch {}
window.scrollTo({ top: 0, left: 0, behavior: "instant" });
document.documentElement.scrollTop = 0;
document.body.scrollTop = 0;
if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
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
const bboxes = {};
for (const el of document.querySelectorAll("[data-tag-id]")) {
  const id = parseInt(el.getAttribute("data-tag-id") || "", 10);
  if (!Number.isFinite(id)) continue;
  const box = bboxFor(el);
  if (box) bboxes[id] = box;
}
const docW = Math.max(
  document.documentElement.scrollWidth || 0,
  document.body.scrollWidth || 0,
  window.innerWidth
);
const docH = Math.max(
  document.documentElement.scrollHeight || 0,
  document.body.scrollHeight || 0,
  window.innerHeight
);
return {
  width: docW,
  height: docH,
  scrollY: window.scrollY,
  bboxes,
};
`;

function buildCaptureInteractCode(pageUrl: string, viewport: ViewportMode): string {
  const pageUrlJson = JSON.stringify(pageUrl);
  const device = resolveCdpDeviceMetrics(viewport);
  const isMo = viewport === "mo";
  const navGuard = pageUrl
    ? `
  try {
    const targetUrl = ${pageUrlJson};
    const target = new URL(targetUrl);
    const cur = new URL(page.url());
    const normPath = (p) => p.replace(/\\/+$/, "") || "/";
    const normHost = (h) => h.replace(/^www\\./i, "");
    if (normHost(cur.host) !== normHost(target.host) || normPath(cur.pathname) !== normPath(target.pathname)) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(600);
    }
  } catch {}
`
    : "";
  return `
await (async () => {
${navGuard}
  await page.evaluate(() => window.scrollTo(0, 0));
  try {
    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle", { timeout: 4000 });
  } catch {}
  try {
    await page.evaluate(async () => { await document.fonts?.ready; });
  } catch {}
  let modalCleared = true;
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.keyboard.press("Escape");
    const state = await page.evaluate(() => {
      ${BROWSER_DISMISS_MODALS_EVAL}
      let last = { clicked: [], removed: [], centerBlocked: false };
      for (let i = 0; i < 3; i++) last = autotagDismissModals();
      return last;
    });
    if (!state.centerBlocked) { modalCleared = true; break; }
    modalCleared = false;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(300);
  await page.evaluate(async () => { ${SCROLL_LAZY_LOAD_EVAL} });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });
  const bboxPayload = await page.evaluate(() => {
    ${CAPTURE_BBOX_EVAL}
  });
  const docSize = {
    width: bboxPayload.width || 0,
    height: bboxPayload.height || 0,
  };
  // Prefer one-shot tall viewport (avoids Chromium fullPage top-stitch crop).
  // MO must stay pinned at device width — widening to scrollWidth captures PC layout.
  const maxH = Math.min(Math.max(docSize.height, ${device.height}), 16384);
  const maxW = ${isMo ? device.width : `Math.min(Math.max(docSize.width, ${device.width}), 4096)`};
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: maxW,
      height: ${isMo ? device.height : "maxH"},
      deviceScaleFactor: 1,
      mobile: ${isMo ? "true" : "false"},
      screenWidth: maxW,
      screenHeight: ${isMo ? device.height : "maxH"},
    });
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    });
    await page.waitForTimeout(120);
  } catch {}
  let buf;
  try {
    buf = await page.screenshot({ fullPage: ${isMo ? "true" : "false"}, type: "png", scale: "css" });
  } catch {
    try {
      buf = await page.screenshot({ fullPage: true, type: "png", scale: "css" });
    } catch {
      buf = await page.screenshot({ fullPage: true, type: "png" });
    }
  }
  // If single-frame came back short, force fullPage so below-fold crops work.
  try {
    const sharpMod = await import("sharp");
    const sharp = sharpMod.default || sharpMod;
    const meta = await sharp(buf).metadata();
    const pngH = meta.height || 0;
    if (docSize.height > ${device.height} + 40 && pngH < docSize.height * 0.85) {
      buf = await page.screenshot({ fullPage: true, type: "png", scale: "css" });
    }
  } catch {}
  return JSON.stringify({
    width: maxW,
    height: docSize.height,
    bboxes: bboxPayload.bboxes || {},
    modalCleared,
    pngBase64: buf.toString("base64"),
  });
})();
`;
}

async function persistCapture(
  jobId: string,
  viewport: ViewportMode,
  buffer: Buffer,
  meta: {
    width: number;
    height: number;
    bboxes: CaptureBboxMap;
    tag_entries?: LiveTagEntry[];
    refreshed_entries?: LiveTagEntry[];
    modal_cleared?: boolean;
  }
): Promise<PageCaptureResult> {
  const absDir = path.join(captureDir(), jobId);
  await mkdir(absDir, { recursive: true });

  let outBuffer = buffer;
  let width = meta.width;
  let height = meta.height;
  try {
    const sharp = (await import("sharp")).default;
    const info = await sharp(buffer).metadata();
    if (info.width && info.height) {
      width = info.width;
      height = info.height;
    }
    const device = resolveCdpDeviceMetrics(viewport);
    if (viewport === "mo" && width > device.width + 8) {
      // Never crop left of a tall PC-layout PNG — that was the broken MO preview.
      // Only centered-crop a short letterboxed stream frame (≈1920×1080).
      if (width >= 1800 && height <= 1200) {
        const crop = resolveMoStreamCrop();
        const left = Math.max(0, Math.min(crop.x, width - device.width));
        const top = Math.max(0, Math.min(crop.y, height - Math.min(crop.height, height)));
        const cropH = Math.min(crop.height, height - top);
        outBuffer = await sharp(buffer)
          .extract({ left, top, width: device.width, height: cropH })
          .png()
          .toBuffer();
        width = device.width;
        height = cropH;
        console.log(
          `[capture] MO letterbox crop ${info.width}x${info.height} -> ${width}x${height} job=${jobId.slice(0, 8)}`
        );
      } else {
        console.warn(
          `[capture] MO png still ${width}x${height} (want ~${device.width} wide) job=${jobId.slice(0, 8)} — skipping left-strip crop`
        );
      }
    }
  } catch {
    /* keep document size fallback */
  }

  await writeFile(captureAbsPath(jobId, viewport), outBuffer);
  return {
    url: captureApiUrl(jobId, viewport),
    width,
    height,
    bboxes: meta.bboxes,
    tag_entries: meta.tag_entries,
    refreshed_entries: meta.refreshed_entries ?? meta.tag_entries,
    png_bytes: outBuffer.length,
    modal_cleared: meta.modal_cleared,
  };
}

async function waitForCaptureReady(
  page: import("playwright").Page,
  opts?: { skipNetworkIdle?: boolean }
): Promise<void> {
  // String evaluate — tsx injects __name into function-form page.evaluate and crashes remote CDP.
  await page
    .evaluate(`(() => { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); })()`)
    .catch(() => {});
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  if (!opts?.skipNetworkIdle) {
    await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
  }
  await page
    .evaluate(`(async () => { try { await document.fonts?.ready; } catch (e) {} })()`)
    .catch(() => {});
  await page.waitForTimeout(150);
}

async function scrollToLoadLazyContent(page: import("playwright").Page): Promise<void> {
  await page.evaluate(`(async () => { ${SCROLL_LAZY_LOAD_EVAL} })()`).catch(() => {});
}

export { scrollToLoadLazyContent };

/**
 * Force every scrollable surface to top. Sites often scroll an inner div
 * (not window) — window.scrollY===0 still leaves the GNB cut off.
 */
async function scrollPageToTop(page: import("playwright").Page): Promise<void> {
  // String-only evaluate avoids tsx `__name is not defined` on remote CDP pages.
  await page.evaluate(`(() => {
    try {
      document.documentElement.style.scrollBehavior = "auto";
      document.body.style.scrollBehavior = "auto";
    } catch (e) {}
    function zero(el) {
      if (!el) return;
      try {
        el.scrollTop = 0;
        el.scrollLeft = 0;
      } catch (e) {}
    }
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    zero(document.documentElement);
    zero(document.body);
    zero(document.scrollingElement);
    var nodes = document.querySelectorAll("*");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var style = window.getComputedStyle(el);
      var oy = style.overflowY;
      var ox = style.overflowX;
      if (
        (oy === "auto" || oy === "scroll" || ox === "auto" || ox === "scroll") &&
        (el.scrollTop > 0 || el.scrollLeft > 0)
      ) {
        zero(el);
      }
    }
  })()`);
  try {
    await page.waitForFunction(
      `() => {
        var y = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
        return y <= 1;
      }`,
      { timeout: 2_000 }
    );
  } catch {
    await page
      .evaluate(`(() => {
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      })()`)
      .catch(() => {});
  }
  await page.waitForTimeout(150);
  const y = (await page.evaluate(
    `(() => window.scrollY || document.documentElement.scrollTop || 0)()`
  )) as number;
  if (y > 1) {
    console.warn(`[capture] scrollY still ${y} before screenshot — retrying top`);
    await page.evaluate(`(() => { window.scrollTo(0, 0); })()`).catch(() => {});
    await page.waitForTimeout(250);
  }
}

async function pngPixelSize(buffer: Buffer): Promise<{ w: number; h: number }> {
  try {
    const sharp = (await import("sharp")).default;
    const info = await sharp(buffer).metadata();
    return { w: info.width ?? 0, h: info.height ?? 0 };
  } catch {
    return { w: 0, h: 0 };
  }
}

async function takePng(
  page: import("playwright").Page,
  fullPage: boolean
): Promise<Buffer> {
  try {
    return await page.screenshot({ type: "png", scale: "css", fullPage });
  } catch {
    return await page.screenshot({ type: "png", fullPage });
  }
}

/** True when PNG is clearly shorter than the document (below-fold crops will miss). */
function isShortPagePng(
  pngH: number,
  docH: number,
  deviceH: number
): boolean {
  if (pngH <= 0 || docH <= 0) return true;
  // Allow small measurement noise; require coverage of most of the document.
  if (docH <= deviceH + 40) return pngH < deviceH * 0.85;
  return pngH < docH * 0.85;
}

/**
 * Chromium fullPage stitches viewports and can crop sticky GNB at the top.
 * PC: expand the emulated viewport to document height and shoot one frame.
 * MO: pin width to 390 and use fullPage — tall Emulation override is unreliable
 * on remote Firecrawl CDP (often returns only 390×844).
 *
 * Critical: remote CDP often ignores tall Emulation and returns only the device
 * frame (e.g. 1920×1080). We detect that via sharp and retry with fullPage.
 */
async function screenshotDocumentOnce(
  page: import("playwright").Page,
  viewport: ViewportMode
): Promise<Buffer> {
  const device = resolveCdpDeviceMetrics(viewport);
  await scrollPageToTop(page);

  const dims = (await page.evaluate(() => {
    const w = Math.max(
      document.documentElement.scrollWidth || 0,
      document.body?.scrollWidth || 0,
      window.innerWidth
    );
    const h = Math.max(
      document.documentElement.scrollHeight || 0,
      document.body?.scrollHeight || 0,
      window.innerHeight
    );
    return { w, h };
  })) as { w: number; h: number };

  const cdp = await page.context().newCDPSession(page);
  try {
    if (viewport === "mo") {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: device.width,
        height: device.height,
        deviceScaleFactor: 1,
        mobile: true,
        screenWidth: device.width,
        screenHeight: device.height,
      });
      await scrollPageToTop(page);
      await page.waitForTimeout(150);
      let buffer = await takePng(page, true);
      let actual = await pngPixelSize(buffer);
      console.log(
        `[capture] mo fullPage png=${actual.w}x${actual.h} (doc≈${dims.w}x${dims.h}) device=${device.width}x${device.height}`
      );

      // fullPage sometimes still returns only the device frame on remote CDP.
      if (isShortPagePng(actual.h, dims.h, device.height)) {
        const tallH = Math.max(device.height, Math.min(dims.h, 16_384));
        console.warn(
          `[capture] MO png short ${actual.w}x${actual.h} vs doc ${dims.h} — retry tall metrics`
        );
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: device.width,
          height: tallH,
          deviceScaleFactor: 1,
          mobile: true,
          screenWidth: device.width,
          screenHeight: tallH,
        });
        await scrollPageToTop(page);
        await page.waitForTimeout(150);
        const retry = await takePng(page, false);
        const retrySize = await pngPixelSize(retry);
        if (retrySize.h > actual.h) {
          buffer = retry;
          actual = retrySize;
          console.log(`[capture] MO tall-frame png=${actual.w}x${actual.h}`);
        } else {
          // Last resort: fullPage again after tall override.
          const retry2 = await takePng(page, true);
          const retry2Size = await pngPixelSize(retry2);
          if (retry2Size.h > actual.h) {
            buffer = retry2;
            actual = retry2Size;
            console.log(`[capture] MO tall+fullPage png=${actual.w}x${actual.h}`);
          }
        }
      }
      if (isShortPagePng(actual.h, dims.h, device.height)) {
        console.warn(
          `[capture] MO still short png=${actual.w}x${actual.h} doc=${dims.h} — below-fold crops may miss`
        );
      }
      return buffer;
    }

    const width = Math.max(device.width, Math.min(dims.w, 4_096));
    const height = Math.max(device.height, Math.min(dims.h, 16_384));
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    });
    await scrollPageToTop(page);
    await page.waitForTimeout(120);

    let buffer = await takePng(page, false);
    let actual = await pngPixelSize(buffer);
    console.log(
      `[capture] single-frame requested=${width}x${height} png=${actual.w}x${actual.h} (doc≈${dims.w}x${dims.h}) mode=pc`
    );

    // Firecrawl CDP often keeps the stream frame (~1080) despite tall override.
    if (isShortPagePng(actual.h, dims.h, device.height)) {
      console.warn(
        `[capture] PC png short ${actual.w}x${actual.h} vs doc ${dims.h} — retry fullPage`
      );
      await scrollPageToTop(page);
      const retry = await takePng(page, true);
      const retrySize = await pngPixelSize(retry);
      if (retrySize.h >= actual.h) {
        buffer = retry;
        actual = retrySize;
        console.log(`[capture] PC fullPage png=${actual.w}x${actual.h}`);
      }
    }
    if (isShortPagePng(actual.h, dims.h, device.height)) {
      console.warn(
        `[capture] PC still short png=${actual.w}x${actual.h} doc=${dims.h} — below-fold crops may miss`
      );
    }
    return buffer;
  } finally {
    try {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: device.width,
        height: device.height,
        deviceScaleFactor: 1,
        mobile: viewport === "mo",
        screenWidth: device.width,
        screenHeight: device.height,
      });
    } catch {
      /* restore best-effort — caller may re-apply viewport */
    }
    await cdp.detach().catch(() => {});
  }
}

function normalizeCapturePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/** `www.example.com` and `example.com` are the same site — don't treat the
 * host's own canonical www redirect as "wrong page" and force a reload. */
function normalizeCaptureHost(host: string): string {
  return host.replace(/^www\./i, "");
}

/** Navigate CDP tab to the target URL when Firecrawl left us on a different path. */
async function ensurePageAtUrl(
  page: import("playwright").Page,
  pageUrl: string
): Promise<void> {
  let current = "";
  try {
    current = page.url();
    const target = new URL(pageUrl);
    const cur = new URL(current);
    if (
      normalizeCaptureHost(cur.host) !== normalizeCaptureHost(target.host) ||
      normalizeCapturePath(cur.pathname) !== normalizeCapturePath(target.pathname)
    ) {
      console.log(`[capture] navigating ${current} -> ${pageUrl}`);
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(600);
    }
  } catch (err) {
    console.warn(
      `[capture] ensurePageAtUrl skipped current=${current || "?"} target=${pageUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

async function preparePageForCapture(
  page: import("playwright").Page,
  pageUrl: string,
  viewport: ViewportMode,
  opts?: { skipNetworkIdle?: boolean; maxModalAttempts?: number }
): Promise<{ modal_cleared: boolean }> {
  await ensurePageAtUrl(page, pageUrl);
  const adapter = pickSiteAdapter(pageUrl, viewport);
  const hints = adapter?.overlayDismissHints ?? {};

  await waitForCaptureReady(page, { skipNetworkIdle: opts?.skipNetworkIdle });

  // Probe point clamped into the actual viewport (PC coords are off-screen on MO).
  const innerWidth = (await page
    .evaluate(`(() => window.innerWidth)()`)
    .catch(() => 0)) as number;
  const rawProbe = hints.verifyProbePoint ?? { x: 960, y: 96 };
  const probe =
    innerWidth && rawProbe.x >= innerWidth
      ? { x: Math.max(10, Math.floor(innerWidth / 2)), y: rawProbe.y }
      : rawProbe;

  // Loop until the CENTER (where popups sit) is clear — catches late modals.
  const maxAttempts = opts?.maxModalAttempts ?? 3;
  let modalCleared = true;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.keyboard.press("Escape").catch(() => {});
    await dismissOverlaysBeforeReveal(page, hints, pageUrl).catch(() => {});
    const state = await removeBlockingModals(page).catch(() => ({ removed: 0, centerBlocked: false }));
    // Escape only — do NOT use adapter.closeSiblingMenus (it re-opens MO drawer).
    await closeOpenMenus(page);
    // A dismiss click may have navigated us away (e.g. a promo popup's only
    // button is a CTA, not a close) — restore before continuing this attempt.
    await ensurePageAtUrl(page, pageUrl);
    await page.evaluate(`(() => { window.scrollTo(0, 0); })()`).catch(() => {});

    const topHit = (await page.evaluate(
      `((px, py) => {
        var el = document.elementFromPoint(px, py);
        if (!el) return null;
        return { tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 80) };
      })(${probe.x}, ${probe.y})`
    )) as { tag: string; text: string } | null;
    const topBlocked =
      !!topHit && /쿠폰|멤버십|회원가입 후|지금 회원가입|그만보기/i.test(topHit.text);

    if (!state.centerBlocked && !topBlocked) {
      modalCleared = true;
      break;
    }
    modalCleared = false;
    console.log(
      `[capture] modal still present attempt=${attempt}/${maxAttempts} center=${state.centerBlocked} top=${topBlocked}`
    );
    await page.waitForTimeout(200);
  }

  await page.evaluate(`(() => { window.scrollTo(0, 0); })()`).catch(() => {});
  await page.waitForTimeout(80);
  return { modal_cleared: modalCleared };
}

export { preparePageForCapture };

async function ensureCaptureViewport(
  page: import("playwright").Page,
  viewport: ViewportMode
): Promise<void> {
  const device = resolveCdpDeviceMetrics(viewport);
  const measure = async () =>
    (await page.evaluate(`(() => ({
      iw: window.innerWidth,
      sw: Math.max(
        document.documentElement.scrollWidth || 0,
        document.body && document.body.scrollWidth || 0,
        window.innerWidth
      ),
    }))()`)) as { iw: number; sw: number };

  for (let attempt = 0; attempt < 3; attempt++) {
    await applyCdpLiveViewViewport(viewport, { page }).catch(() => {});
    const dims = await measure();
    const innerOk = Math.abs(dims.iw - device.width) <= 4;
    const moLayoutOk = viewport !== "mo" || dims.sw <= device.width + 48;
    if (innerOk && moLayoutOk) {
      if (attempt > 0) {
        console.log(
          `[capture] viewport settled mode=${viewport} inner=${dims.iw} sw=${dims.sw} after ${attempt + 1} tries`
        );
      }
      return;
    }
    console.warn(
      `[capture] viewport not ready attempt=${attempt + 1} mode=${viewport} inner=${dims.iw} sw=${dims.sw} expected=${device.width}`
    );
    await applyCdpLiveViewViewport(viewport, { page }).catch(() => {});
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1_000);
  }

  const final = await measure();
  if (viewport === "mo" && (Math.abs(final.iw - device.width) > 4 || final.sw > device.width + 48)) {
    console.warn(
      `[capture] MO still desktop-like after retries inner=${final.iw} sw=${final.sw} (want ${device.width})`
    );
  }
}

function touchCaptureProgress(jobId: string, current: number, total = 6): void {
  try {
    updateJobProgress(jobId, {
      step: "page_capture",
      progress: { current, total },
    });
  } catch {
    /* ignore — stall watchdog best-effort */
  }
}

async function captureViaCdp(
  cdpUrl: string,
  jobId: string,
  viewport: ViewportMode,
  pageUrl: string,
  opts?: { keepAlive?: boolean; skipHeavyPrep?: boolean }
): Promise<PageCaptureResult | null> {
  const hadPage = hasCdpConnection(cdpUrl);
  const page = hadPage
    ? await ensureCdpConnected(cdpUrl, pageUrl)
    : await connectOverCdp(cdpUrl, pageUrl);
  try {
    touchCaptureProgress(jobId, 1);
    await ensureCaptureViewport(page, viewport);
    touchCaptureProgress(jobId, 2);
    const prep = await preparePageForCapture(page, pageUrl, viewport, {
      skipNetworkIdle: opts?.skipHeavyPrep || hadPage,
      maxModalAttempts: opts?.skipHeavyPrep || hadPage ? 2 : 3,
    });
    touchCaptureProgress(jobId, 3);
    await scrollToLoadLazyContent(page);
    await scrollPageToTop(page);
    // Same passive GNB collect as explore — stamp header/panel links before scan.
    const adapter = pickSiteAdapter(pageUrl, viewport);
    await assignExtraTagsOnPage(page, adapter).catch(() => {});
    await collectHiddenDomMenuItems(page).catch(() => 0);
    let captureTagResult = await tagLiveDomOnPage(page, viewport);
    touchCaptureProgress(jobId, 4);

    await scrollPageToTop(page);
    let bboxPayload = (await page.evaluate(`(() => {
      ${CAPTURE_BBOX_EVAL}
    })()`)) as {
      width: number;
      height: number;
      scrollY?: number;
      bboxes: CaptureBboxMap;
    };
    if ((bboxPayload.scrollY ?? 0) > 1) {
      console.warn(
        `[capture] bbox measured at scrollY=${bboxPayload.scrollY} — re-scrolling`
      );
      await scrollPageToTop(page);
    }

    // Empty capture bboxes → below-fold / retag miss. One retry after re-tag.
    if (Object.keys(bboxPayload.bboxes || {}).length === 0) {
      console.warn(`[capture] bbox=0 job=${jobId.slice(0, 8)} — re-tag and remeasure`);
      captureTagResult = await tagLiveDomOnPage(page, viewport);
      await scrollPageToTop(page);
      bboxPayload = (await page.evaluate(`(() => {
        ${CAPTURE_BBOX_EVAL}
      })()`)) as typeof bboxPayload;
    }

    const docSize = {
      width: bboxPayload.width,
      height: bboxPayload.height,
    };

    let html: string | undefined;
    try {
      html = await page.content();
    } catch {
      /* optional — orchestrator falls back to fetchPageHtml */
    }

    touchCaptureProgress(jobId, 5);
    await scrollPageToTop(page);
    let buffer: Buffer;
    try {
      buffer = await screenshotDocumentOnce(page, viewport);
    } catch (err) {
      console.warn(
        `[capture] single-frame failed, falling back to fullPage: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      await scrollPageToTop(page);
      try {
        buffer = await page.screenshot({ fullPage: true, type: "png", scale: "css" });
      } catch {
        buffer = await page.screenshot({ fullPage: true, type: "png" });
      }
    }
    // Restore normal live-view metrics after expanded-viewport capture.
    await applyCdpLiveViewViewport(viewport, { page }).catch(() => {});
    touchCaptureProgress(jobId, 6);
    const persisted = await persistCapture(jobId, viewport, buffer, {
      width: docSize.width || bboxPayload.width,
      height: docSize.height || bboxPayload.height,
      bboxes: bboxPayload.bboxes ?? {},
      tag_entries: captureTagResult.entries,
      modal_cleared: prep.modal_cleared,
    });
    return { ...persisted, html };
  } finally {
    if (!opts?.keepAlive) {
      await disconnectCdp(cdpUrl);
    }
  }
}

async function captureViaInteract(
  scrapeId: string,
  jobId: string,
  viewport: ViewportMode,
  pageUrl: string
): Promise<PageCaptureResult | null> {
  const device = resolveCdpDeviceMetrics(viewport);
  // MO needs reload so media queries reflow before screenshot.
  const applyVp =
    viewport === "mo"
      ? setViewportAndReload(scrapeId, viewport, [], device)
      : setViewport(scrapeId, viewport, device);
  await applyVp.catch((err) => {
    console.warn(
      `[capture] interact setViewport(${viewport}) skipped: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  });

  const resp = await interactCode(scrapeId, buildCaptureInteractCode(pageUrl, viewport), 120);
  if (resp.success !== true) {
    throw new Error(resp.error ?? "interact screenshot failed");
  }

  const parsed = JSON.parse(resp.result ?? "{}") as {
    width?: number;
    height?: number;
    bboxes?: CaptureBboxMap;
    pngBase64?: string;
    modalCleared?: boolean;
  };

  if (!parsed.pngBase64?.length) {
    throw new Error("interact screenshot returned empty png");
  }

  const buffer = Buffer.from(parsed.pngBase64, "base64");
  return persistCapture(jobId, viewport, buffer, {
    width: parsed.width ?? 0,
    height: parsed.height ?? 0,
    bboxes: parsed.bboxes ?? {},
    modal_cleared: parsed.modalCleared !== false,
  });
}

/** Full-page PNG for page_view only — load settle, dismiss overlays, full-page shot. */
export async function capturePageScreenshot(
  session: Pick<FirecrawlSession, "scrapeId" | "cdpUrl">,
  jobId: string,
  viewport: ViewportMode,
  pageUrl = "",
  opts?: { keepAlive?: boolean; skipHeavyPrep?: boolean }
): Promise<PageCaptureResult | null> {
  const tag = `job=${jobId.slice(0, 8)} viewport=${viewport}`;
  let working: Pick<FirecrawlSession, "scrapeId" | "cdpUrl"> = session;

  if (!working.cdpUrl && working.scrapeId) {
    const refreshed = await refreshLiveViewSession(working as FirecrawlSession);
    if (refreshed.ok && refreshed.session.cdpUrl) {
      working = refreshed.session;
    }
  }

  if (working.cdpUrl) {
    try {
      const viaCdp = await captureViaCdp(working.cdpUrl, jobId, viewport, pageUrl, {
        keepAlive: opts?.keepAlive,
        skipHeavyPrep: opts?.skipHeavyPrep,
      });
      if (viaCdp) {
        console.log(
          `[capture] ok via=cdp ${tag} ${viaCdp.width}x${viaCdp.height} bbox=${Object.keys(viaCdp.bboxes).length}`
        );
        return viaCdp;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[capture] cdp failed ${tag}: ${message}`);
    }
  }

  if (!working.scrapeId) {
    console.warn(`[capture] skipped ${tag}: no scrapeId`);
    return null;
  }

  try {
    const viaInteract = await captureViaInteract(working.scrapeId, jobId, viewport, pageUrl);
    if (viaInteract) {
      console.log(
        `[capture] ok via=interact ${tag} ${viaInteract.width}x${viaInteract.height} bbox=${Object.keys(viaInteract.bboxes).length}`
      );
      return viaInteract;
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[capture] interact failed ${tag}: ${message}`);
    return null;
  }
}
