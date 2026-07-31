import { chromium, type Browser, type Page } from "playwright";
import type { PanelSizeHint, ViewportMode } from "@autotag/shared";
import { resolveCdpDeviceMetrics, resolveCdpStreamBounds } from "@autotag/shared";

/**
 * One remote Chrome per Firecrawl CDP endpoint.
 * Concurrent analyze jobs MUST NOT share a single global connection —
 * connecting a second endpoint used to call disconnectCdp() and kill the
 * first job mid-explore ("Target page, context or browser has been closed").
 */
interface CdpSlot {
  browser: Browser;
  page: Page;
  connectedAt: number;
}

const slots = new Map<string, CdpSlot>();

/** Dev/test: drop stale CDP after 30 min. */
const CDP_TTL_MS = 30 * 60 * 1000;

function slotKey(cdpUrl: string): string {
  return cdpUrl.trim();
}

function isSlotAlive(slot: CdpSlot): boolean {
  if (Date.now() - slot.connectedAt > CDP_TTL_MS) return false;
  try {
    return !slot.page.isClosed();
  } catch {
    return false;
  }
}

async function closeSlot(key: string): Promise<void> {
  const slot = slots.get(key);
  if (!slot) return;
  slots.delete(key);
  try {
    await slot.browser.close();
  } catch {
    /* ignore */
  }
}

/** True when this CDP endpoint already has a live Playwright page. */
export function hasCdpConnection(cdpUrl: string): boolean {
  const key = slotKey(cdpUrl);
  const slot = slots.get(key);
  if (!slot) return false;
  if (!isSlotAlive(slot)) {
    void closeSlot(key);
    return false;
  }
  return true;
}

/**
 * Connect (or reconnect) a single endpoint. Does NOT touch other endpoints.
 */
/** Prevent Playwright dialog auto-dismiss races from killing the Node process. */
function attachSafeDialogHandlers(browser: Browser): void {
  const bindPage = (page: Page): void => {
    page.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => {
        /* dialog already closed — ProtocolError must not become uncaught */
      });
    });
  };
  for (const context of browser.contexts()) {
    context.on("page", bindPage);
    for (const page of context.pages()) bindPage(page);
  }
  browser.on("disconnected", () => {
    /* no-op — slot cleanup is owned by closeSlot */
  });
}

export async function connectOverCdp(cdpUrl: string, preferUrl?: string): Promise<Page> {
  const key = slotKey(cdpUrl);
  await closeSlot(key);

  const browser = await chromium.connectOverCDP(cdpUrl);
  attachSafeDialogHandlers(browser);
  const context = browser.contexts()[0];
  if (!context) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    throw new Error("CDP: no browser context");
  }
  const pages = context.pages();
  if (!pages.length) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    throw new Error("CDP: no pages in context");
  }
  const page = await pickContentPage(pages, preferUrl);
  slots.set(key, { browser, page, connectedAt: Date.now() });
  console.log(
    `[cdp] connected endpoints=${slots.size} url=${page.url().slice(0, 80)}`
  );
  return page;
}

/**
 * Reuse an existing CDP page for this endpoint when still healthy.
 * Avoids disconnect→reconnect between menu explore, page capture, and element capture.
 */
export async function ensureCdpConnected(cdpUrl: string, preferUrl?: string): Promise<Page> {
  const key = slotKey(cdpUrl);
  const slot = slots.get(key);
  if (slot && isSlotAlive(slot)) {
    try {
      if (preferUrl) {
        const current = slot.page.url();
        const preferHost = preferUrl.replace(/^https?:\/\//i, "").split("/")[0]?.replace(/^www\./i, "");
        const curHost = current.replace(/^https?:\/\//i, "").split("/")[0]?.replace(/^www\./i, "");
        if (preferHost && curHost && preferHost === curHost) {
          slot.connectedAt = Date.now();
          return slot.page;
        }
      } else {
        slot.connectedAt = Date.now();
        return slot.page;
      }
    } catch {
      /* fall through to reconnect */
    }
  }
  return connectOverCdp(cdpUrl, preferUrl);
}

/**
 * Firecrawl's remote browser can expose several targets (about:blank, extension
 * pages, the real content tab). Always grabbing pages[0] sometimes bound us to a
 * blank page — the screenshot came out white and 0 elements were tagged. Pick
 * the page that actually holds the site content.
 */
function normalizePathname(pathname: string): string {
  const p = pathname.replace(/\/+$/, "") || "/";
  return p;
}

/** `www.example.com` and `example.com` are the same site for matching purposes. */
function normalizeHost(host: string): string {
  return host.replace(/^www\./i, "");
}

function pathMatchScore(pageUrl: string, preferUrl: string): number {
  try {
    const a = new URL(pageUrl);
    const b = new URL(preferUrl);
    if (normalizeHost(a.host) !== normalizeHost(b.host)) return 0;
    const pa = normalizePathname(a.pathname);
    const pb = normalizePathname(b.pathname);
    if (pa === pb) return 15_000;
    // Strongly penalize tabs on a different path (e.g. /lounge/events vs /).
    if (pb === "/" || pa === "/") return -12_000;
    return -6_000;
  } catch {
    return 0;
  }
}

async function pickContentPage(pages: Page[], preferUrl?: string): Promise<Page> {
  if (pages.length === 1) return pages[0]!;

  let preferHost = "";
  try {
    if (preferUrl) preferHost = new URL(preferUrl).host;
  } catch {
    /* ignore */
  }

  let best = pages[0]!;
  let bestScore = -Infinity;
  for (const p of pages) {
    const u = p.url();
    let score = 0;
    if (/^https?:/i.test(u)) score += 1000;
    if (!u || u === "about:blank" || u.startsWith("chrome") || u.startsWith("devtools")) {
      score -= 5000;
    }
    if (preferHost) {
      try {
        if (normalizeHost(new URL(u).host) === normalizeHost(preferHost)) score += 5000;
      } catch {
        /* ignore */
      }
    }
    if (preferUrl) {
      score += pathMatchScore(u, preferUrl);
    }
    try {
      const count = (await p.evaluate(() => document.querySelectorAll("*").length)) as number;
      score += Math.min(count, 4000);
    } catch {
      score -= 100;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  console.log(`[cdp] picked content page url=${best.url()} of ${pages.length} targets (score=${bestScore})`);
  return best;
}

/**
 * @param cdpUrl When set, return that endpoint's page. When omitted, returns
 *   null — callers must pass the URL (multi-session safe). Legacy code that
 *   called getCdpPage() after connectOverCdp should use the returned Page.
 */
export function getCdpPage(cdpUrl?: string): Page | null {
  if (!cdpUrl) return null;
  const key = slotKey(cdpUrl);
  const slot = slots.get(key);
  if (!slot) return null;
  if (!isSlotAlive(slot)) {
    void closeSlot(key);
    return null;
  }
  return slot.page;
}

/**
 * Disconnect one endpoint, or every endpoint when `cdpUrl` is omitted
 * (full teardown / pipeline reset).
 */
export async function disconnectCdp(cdpUrl?: string): Promise<void> {
  if (cdpUrl) {
    await closeSlot(slotKey(cdpUrl));
    return;
  }
  const keys = [...slots.keys()];
  await Promise.all(keys.map((k) => closeSlot(k)));
}

export interface ViewportSyncMetrics {
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  screenWidth: number;
  screenHeight: number;
  windowBoundsApplied: boolean;
  windowBoundsError?: string;
}

export interface ApplyCdpLiveViewViewportResult {
  ok: boolean;
  width: number;
  height: number;
  error?: string;
  metrics?: ViewportSyncMetrics;
}

/**
 * Align Chrome window bounds (stream canvas) and emulated page viewport.
 * MO: window = 1920×1080 stream, device = 390×844 mobile.
 */
export async function syncCdpWindowAndViewport(
  page: Page,
  device: { width: number; height: number },
  mobile: boolean,
  windowBounds?: { width: number; height: number }
): Promise<ViewportSyncMetrics> {
  const cdp = await page.context().newCDPSession(page);
  const winW = windowBounds?.width ?? device.width;
  const winH = windowBounds?.height ?? device.height;

  let windowBoundsApplied = false;
  let windowBoundsError: string | undefined;

  try {
    const { targetInfo } = (await cdp.send("Target.getTargetInfo")) as {
      targetInfo: { targetId: string };
    };
    const { windowId } = (await cdp.send("Browser.getWindowForTarget", {
      targetId: targetInfo.targetId,
    })) as { windowId: number };
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { width: winW, height: winH, windowState: "normal" },
    });
    windowBoundsApplied = true;
  } catch (err) {
    windowBoundsError = err instanceof Error ? err.message : String(err);
    console.warn(`[viewport] setWindowBounds skipped: ${windowBoundsError}`);
  }

  const metricsOverride = {
    width: device.width,
    height: device.height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: device.width,
    screenHeight: device.height,
    screenOrientation: mobile
      ? ({ type: "portraitPrimary", angle: 0 } as const)
      : ({ type: "landscapePrimary", angle: 0 } as const),
  };

  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", metricsOverride);
  } catch {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: device.width,
      height: device.height,
      deviceScaleFactor: 1,
      mobile,
      screenWidth: device.width,
      screenHeight: device.height,
    });
  }

  await page.waitForTimeout(300);

  const dims = (await page.evaluate(`(() => ({
    iw: window.innerWidth,
    ih: window.innerHeight,
    ow: window.outerWidth,
    oh: window.outerHeight,
    sw: window.screen.width,
    sh: window.screen.height,
  }))()`)) as {
    iw: number;
    ih: number;
    ow: number;
    oh: number;
    sw: number;
    sh: number;
  };

  console.log(
    `[viewport] window=${winW}x${winH} device=${device.width}x${device.height} inner=${dims.iw}x${dims.ih} outer=${dims.ow}x${dims.oh} screen=${dims.sw}x${dims.sh} windowBounds=${windowBoundsApplied ? "ok" : "skip"}`
  );

  await page
    .evaluate(`(() => { window.dispatchEvent(new Event("resize")); })()`)
    .catch(() => {});

  return {
    innerWidth: dims.iw,
    innerHeight: dims.ih,
    outerWidth: dims.ow,
    outerHeight: dims.oh,
    screenWidth: dims.sw,
    screenHeight: dims.sh,
    windowBoundsApplied,
    windowBoundsError,
  };
}

/**
 * Enlarge remote Chrome via CDP (Firecrawl interact has no viewport param).
 * Non-fatal — caller may fall back to interact setViewport.
 */
export async function applyCdpLiveViewViewport(
  mode: ViewportMode,
  opts?: { cdpUrl?: string; panel?: PanelSizeHint; page?: Page }
): Promise<ApplyCdpLiveViewViewportResult> {
  const panelW = opts?.panel?.width ?? 0;
  const panelH = opts?.panel?.height ?? 0;
  const device = resolveCdpDeviceMetrics(mode, opts?.panel);
  const stream = resolveCdpStreamBounds(mode);
  const scaleHint = panelW > 0 ? (panelW / stream.width).toFixed(4) : "n/a";

  try {
    let p = opts?.page ?? (opts?.cdpUrl ? getCdpPage(opts.cdpUrl) : null);
    if (!p && opts?.cdpUrl) {
      p = await connectOverCdp(opts.cdpUrl);
    }
    if (!p) throw new Error("no_cdp_page");

    const metrics = await syncCdpWindowAndViewport(p, device, mode === "mo", stream);
    // Width is the responsive breakpoint; height often differs by a few px (scrollbar).
    const innerOk = Math.abs(metrics.innerWidth - device.width) <= 4;

    console.log(
      `[viewport] cdp stream=${stream.width}x${stream.height} device=${device.width}x${device.height} panel=${panelW}x${panelH} scale=${scaleHint} mode=${mode} inner=${metrics.innerWidth}x${metrics.innerHeight} innerMatch=${innerOk}`
    );
    return { ok: innerOk, width: device.width, height: device.height, metrics };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[viewport] cdp stream=${stream.width}x${stream.height} device=${device.width}x${device.height} panel=${panelW}x${panelH} scale=${scaleHint} mode=${mode} failed: ${message}`
    );
    return { ok: false, width: device.width, height: device.height, error: message };
  }
}

/** Resize live CDP page viewport, reload for responsive reflow, re-stamp tag ids. */
export async function setCdpViewport(
  mode: ViewportMode,
  opts?: {
    cdpUrl?: string;
    page?: Page;
    restoreTagIds?: Array<{ tag_id: number; selector_hint: string }>;
    panel?: PanelSizeHint;
  }
): Promise<void> {
  const p = opts?.page ?? (opts?.cdpUrl ? getCdpPage(opts.cdpUrl) : null);
  if (!p) throw new Error("CDP: no active page");
  const device = resolveCdpDeviceMetrics(mode, opts?.panel);
  const stream = resolveCdpStreamBounds(mode);

  await syncCdpWindowAndViewport(p, device, mode === "mo", stream);
  await p.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await p.waitForTimeout(1500);

  await p
    .evaluate(`(() => { window.dispatchEvent(new Event("resize")); })()`)
    .catch(() => {});

  const items = opts?.restoreTagIds?.filter((t) => t.selector_hint?.trim()) ?? [];
  if (items.length > 0) {
    await p.evaluate(
      `((stampList) => {
        for (var i = 0; i < stampList.length; i++) {
          var item = stampList[i];
          try {
            var el = document.querySelector(item.selector_hint);
            if (el) el.setAttribute("data-tag-id", String(item.tag_id));
          } catch (e) {}
        }
      })(${JSON.stringify(items)})`
    );
    await p.waitForTimeout(300);
  }
}
