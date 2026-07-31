/** Minimal Firecrawl scrape + interact client (Phase 0 spike port). */

import type { ViewportMode } from "@autotag/shared";
import { resolveCdpDeviceMetrics, resolveCdpStreamBounds } from "@autotag/shared";
import {
  getFirecrawlKeyContext,
  registerJobScrapeSession,
  releaseJobScrapeSession,
  resolveFirecrawlApiKey,
  runWithFirecrawlKey,
} from "./firecrawl-key-pool.js";
import {
  cleanupRegisteredSessions,
  getScrapeSessionMeta,
  registerOpenScrapeId,
  unregisterOpenScrapeId,
} from "./firecrawl-session-registry.js";
import {
  buildLiveViewSessionMeta,
  logLiveViewSession,
  probeLiveViewUrl,
  type LiveViewSessionMeta,
} from "./liveview-session.js";

export interface FirecrawlInteractResult {
  success: boolean;
  result?: string;
  cdpUrl?: string;
  cdp_url?: string;
  liveViewUrl?: string;
  live_view_url?: string;
  interactiveLiveViewUrl?: string;
  interactive_live_view_url?: string;
  expiresAt?: string;
  expires_at?: string;
  ttl?: number;
  activityTtl?: number;
  activity_ttl?: number;
  error?: string;
  exitCode?: number;
  _http_status?: number;
}

export interface FirecrawlSession {
  scrapeId: string;
  cdpUrl: string | null;
  liveViewUrl: string | null;
  interactiveLiveViewUrl: string | null;
  liveViewMeta?: LiveViewSessionMeta;
}

function apiBase(): string {
  return (process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev").replace(/\/$/, "");
}

function apiKey(explicit?: string): string {
  return resolveFirecrawlApiKey(explicit);
}

function headers(explicitKey?: string): Record<string, string> {
  const key = apiKey(explicitKey);
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

function fcLog(...args: unknown[]): void {
  if (process.env.FIRECRAWL_DEBUG === "1" || process.env.AUTOTAG_PIPELINE_DEBUG === "1") {
    console.log("[firecrawl]", ...args);
  }
}

function summarizeError(body: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["error", "message", "detail", "_raw_text"]) {
    const val = body[key];
    if (val) parts.push(`${key}=${String(val)}`);
  }
  return parts.length ? parts.join(" | ") : JSON.stringify(body).slice(0, 500);
}

/** Parse scrapeId from v2 scrape response (multiple field fallbacks). */
export function extractScrapeId(body: Record<string, unknown>): string {
  const data = (body.data ?? {}) as Record<string, unknown>;
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  const candidates = [
    metadata.scrapeId,
    metadata.scrape_id,
    data.scrapeId,
    data.scrape_id,
    body.scrapeId,
    body.id,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c).trim();
  }
  return "";
}

export async function scrapeUrl(url: string): Promise<{ scrapeId: string; raw: Record<string, unknown> }> {
  const response = await fetch(`${apiBase()}/v2/scrape`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ url, formats: ["markdown"] }),
    signal: AbortSignal.timeout(120_000),
  });

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = { _raw_text: (await response.text()).slice(0, 2000) };
  }

  if (response.status >= 400) {
    throw new Error(`scrape HTTP ${response.status}: ${summarizeError(body)}`);
  }
  if (body.success !== true) {
    throw new Error(`scrape failed: ${summarizeError(body)}`);
  }

  const scrapeId = extractScrapeId(body);
  fcLog("scrape ok url=", url, "scrapeId=", scrapeId || "(missing)");
  if (!scrapeId) {
    throw new Error(`scrape response missing scrapeId: ${JSON.stringify(body).slice(0, 300)}`);
  }

  registerOpenScrapeId(scrapeId);

  const metadata = ((body.data as Record<string, unknown>)?.metadata ?? {}) as Record<string, unknown>;
  if (metadata.concurrencyLimited === true) {
    console.warn("[firecrawl] scrape returned concurrencyLimited=true — interact may fail until slots free");
  }

  return { scrapeId, raw: body };
}

function isRateLimitError(error: string | undefined): boolean {
  const msg = (error ?? "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("429");
}

export async function interactCode(
  scrapeId: string,
  code: string,
  timeoutSec = 30
): Promise<FirecrawlInteractResult> {
  if (!scrapeId?.trim()) {
    throw new Error("interactCode: scrapeId is empty");
  }

  const maxAttempts = 4;
  let lastBody: FirecrawlInteractResult = { success: false, error: "unknown" };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    fcLog("interact POST scrapeId=", scrapeId, "timeout=", timeoutSec, "attempt=", attempt);

    const response = await fetch(`${apiBase()}/v2/scrape/${encodeURIComponent(scrapeId)}/interact`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ code, language: "node", timeout: timeoutSec }),
      signal: AbortSignal.timeout((timeoutSec + 30) * 1000),
    });

    let body: FirecrawlInteractResult;
    try {
      body = (await response.json()) as FirecrawlInteractResult;
    } catch {
      body = { success: false, error: (await response.text()).slice(0, 500) };
    }
    body._http_status = response.status;
    lastBody = body;

    if (body.success === true) return body;

    fcLog("interact failed scrapeId=", scrapeId, "error=", body.error, "http=", response.status);

    if (isRateLimitError(body.error) && attempt < maxAttempts) {
      const waitMs = attempt * 15_000;
      console.warn(`[firecrawl] rate limit — retry in ${waitMs / 1000}s (attempt ${attempt}/${maxAttempts})`);
      await sleep(waitMs);
      continue;
    }
    break;
  }

  return lastBody;
}

export async function stopInteraction(scrapeId: string, explicitKey?: string): Promise<void> {
  if (!scrapeId?.trim()) return;
  fcLog("stop interact scrapeId=", scrapeId);
  const sessionMeta = getScrapeSessionMeta(scrapeId);
  const key = explicitKey ?? sessionMeta?.apiKey ?? apiKey();
  const jobId = sessionMeta?.jobId ?? getFirecrawlKeyContext()?.jobId;
  try {
    await runWithFirecrawlKey(key, jobId, async () => {
      await fetch(`${apiBase()}/v2/scrape/${encodeURIComponent(scrapeId)}/interact`, {
        method: "DELETE",
        headers: headers(key),
        signal: AbortSignal.timeout(30_000),
      });
    });
  } catch {
    // best-effort cleanup
  } finally {
    unregisterOpenScrapeId(scrapeId);
    if (jobId) releaseJobScrapeSession(jobId, scrapeId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableBootstrapError(error: string | undefined): boolean {
  const msg = (error ?? "").toLowerCase();
  return (
    msg.includes("job not found") ||
    msg.includes("maximum number of concurrent") ||
    msg.includes("maximum number of active browser") ||
    msg.includes("replay context") ||
    msg.includes("initialize browser session") ||
    msg.includes("rerun the scrape") ||
    msg.includes("deno repl") ||
    msg.includes("repl not ready") ||
    msg.includes("repl exited")
  );
}

/** Firecrawl remote interact VM died — usually concurrency / session eviction. */
export function isFirecrawlReplError(error: string | undefined): boolean {
  const msg = (error ?? "").toLowerCase();
  return (
    msg.includes("deno repl") ||
    msg.includes("repl not ready") ||
    msg.includes("repl exited") ||
    msg.includes("failed to execute code in browser session")
  );
}

export interface BootstrapSessionOptions {
  /** Batch queue: keep other workers' scrape sessions alive. */
  preserveOtherSessions?: boolean;
}

export async function bootstrapSession(
  url: string,
  opts?: BootstrapSessionOptions
): Promise<FirecrawlSession> {
  const preserveOtherSessions = opts?.preserveOtherSessions ?? false;
  if (!preserveOtherSessions) {
    await cleanupRegisteredSessions();
  }

  const maxAttempts = 3;
  let lastError = "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { scrapeId, raw } = await scrapeUrl(url);

    const metadata = ((raw.data as Record<string, unknown>)?.metadata ?? {}) as Record<string, unknown>;
    if (metadata.concurrencyLimited === true) {
      console.warn(
        `[firecrawl] scrape concurrencyLimited (attempt ${attempt}/${maxAttempts}) — freeing slots and retrying`
      );
      await stopInteraction(scrapeId);
      unregisterOpenScrapeId(scrapeId);
      if (attempt < maxAttempts) {
        if (!preserveOtherSessions) await cleanupRegisteredSessions();
        await sleep(3000);
        continue;
      }
    }

    // Immediately open interact — do not delay between scrape and first interact.
    const boot = await interactCode(scrapeId, "await page.title();", 30);

    if (boot.success === true) {
      fcLog("bootstrap ok scrapeId=", scrapeId);
      const liveViewUrl = boot.liveViewUrl ?? boot.live_view_url ?? null;
      const interactiveLiveViewUrl =
        boot.interactiveLiveViewUrl ?? boot.interactive_live_view_url ?? null;
      const liveViewMeta = buildLiveViewSessionMeta(boot, interactiveLiveViewUrl ?? liveViewUrl);
      logLiveViewSession(liveViewMeta, "created");
      return {
        scrapeId,
        cdpUrl: boot.cdpUrl ?? boot.cdp_url ?? null,
        liveViewUrl,
        interactiveLiveViewUrl,
        liveViewMeta,
      };
    }

    lastError = boot.error ?? JSON.stringify(boot);
    fcLog("bootstrap failed attempt=", attempt, "scrapeId=", scrapeId, "error=", lastError);
    await stopInteraction(scrapeId);
    unregisterOpenScrapeId(scrapeId);

    if (isRetryableBootstrapError(boot.error) && attempt < maxAttempts) {
      if (!preserveOtherSessions) await cleanupRegisteredSessions();
      const waitMs = attempt * 5000;
      console.warn(`[firecrawl] bootstrap retry in ${waitMs / 1000}s (attempt ${attempt}/${maxAttempts})`);
      await sleep(waitMs);
      continue;
    }

    break;
  }

  throw new Error(`interact bootstrap failed: ${lastError}`);
}

export async function fetchPageHtml(scrapeId: string): Promise<string> {
  const resp = await interactCode(scrapeId, "await (async () => await page.content())();", 60);
  if (resp.success !== true) {
    throw new Error(`page.content() failed: ${resp.error ?? JSON.stringify(resp)}`);
  }
  return (resp.result ?? "").trim();
}

export async function waitForPageReady(scrapeId: string, timeoutSec = 30): Promise<void> {
  const code = `
await (async () => {
  await page.waitForLoadState('domcontentloaded');
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('button, a[href], [role="button"]').length > 0,
      { timeout: 8000 }
    );
  } catch (_) {}
  await page.waitForTimeout(200);
})();
`.trim();

  const maxAttempts = 3;
  let lastError = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await interactCode(scrapeId, code, timeoutSec);
    if (resp.success === true) return;

    lastError = resp.error ?? JSON.stringify(resp);
    const replDead = isFirecrawlReplError(lastError);
    console.warn(
      `[firecrawl] waitForPageReady attempt=${attempt}/${maxAttempts} scrapeId=${scrapeId.slice(0, 8)}: ${lastError}`
    );

    // REPL already gone — further interact calls on this scrapeId won't help.
    if (replDead) break;
    if (attempt < maxAttempts) await sleep(attempt * 1500);
  }

  throw new Error(`waitForPageReady failed: ${lastError}`);
}

/**
 * Navigate an existing Firecrawl session to another path on the same host.
 * Avoids a full scrape/bootstrap — used by host-group session reuse.
 */
export async function navigateSessionToUrl(
  session: FirecrawlSession,
  url: string
): Promise<void> {
  const target = url.trim();
  if (!target) throw new Error("navigateSessionToUrl: empty url");

  if (session.cdpUrl) {
    try {
      const { ensureCdpConnected } = await import("./cdp-session.js");
      const page = await ensureCdpConnected(session.cdpUrl, target);
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(200).catch(() => {});
      console.log(`[firecrawl] navigate_reuse cdp url=${target}`);
      return;
    } catch (err) {
      console.warn(
        `[firecrawl] navigate via CDP failed, falling back to interact: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  const code = `
await (async () => {
  await page.goto(${JSON.stringify(target)}, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(200);
})();
`.trim();
  const resp = await interactCode(session.scrapeId, code, 90);
  if (resp.success !== true) {
    throw new Error(`navigateSessionToUrl failed: ${resp.error ?? JSON.stringify(resp)}`);
  }
  console.log(`[firecrawl] navigate_reuse interact url=${target}`);
}

export function buildCdpWindowViewportSyncBody(
  deviceW: number,
  deviceH: number,
  mobile: boolean,
  windowW?: number,
  windowH?: number
): string {
  const mo = mobile ? "true" : "false";
  const winW = windowW ?? deviceW;
  const winH = windowH ?? deviceH;
  return `  const client = await page.context().newCDPSession(page);
  let windowOk = false;
  try {
    const { targetInfo } = await client.send('Target.getTargetInfo');
    const { windowId } = await client.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
    await client.send('Browser.setWindowBounds', {
      windowId,
      bounds: { width: ${winW}, height: ${winH}, windowState: 'normal' },
    });
    windowOk = true;
  } catch (_) {}
  try {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: ${deviceW},
      height: ${deviceH},
      deviceScaleFactor: 1,
      mobile: ${mo},
      screenWidth: ${deviceW},
      screenHeight: ${deviceH},
      screenOrientation: ${mo}
        ? { type: 'portraitPrimary', angle: 0 }
        : { type: 'landscapePrimary', angle: 0 },
    });
  } catch (_) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: ${deviceW},
      height: ${deviceH},
      deviceScaleFactor: 1,
      mobile: ${mo},
      screenWidth: ${deviceW},
      screenHeight: ${deviceH},
    });
  }
  await page.waitForTimeout(300);
  const dims = await page.evaluate(() => ({
    iw: window.innerWidth,
    ih: window.innerHeight,
    ow: window.outerWidth,
    oh: window.outerHeight,
    sw: window.screen.width,
    sh: window.screen.height,
  }));
  await page.evaluate(() => { window.dispatchEvent(new Event('resize')); });
  return JSON.stringify({ windowOk, dims });`;
}

function buildCdpWindowViewportSyncCode(mode: ViewportMode, size?: { width: number; height: number }): string {
  const device = size ?? resolveCdpDeviceMetrics(mode);
  const stream = resolveCdpStreamBounds(mode);
  return `
await (async () => {
${buildCdpWindowViewportSyncBody(device.width, device.height, mode === "mo", stream.width, stream.height)}
})();
`.trim();
}

/** Set remote Chrome window + viewport via interact CDP (fallback when local CDP unavailable). */
export async function setViewport(
  scrapeId: string,
  mode: ViewportMode,
  size?: { width: number; height: number }
): Promise<void> {
  const device = size ?? resolveCdpDeviceMetrics(mode);
  const code = buildCdpWindowViewportSyncCode(mode, device);
  const resp = await interactCode(scrapeId, code, 30);
  if (resp.success !== true) {
    throw new Error(`setViewport(${mode}) failed: ${resp.error ?? JSON.stringify(resp)}`);
  }
  try {
    const parsed = JSON.parse(resp.result ?? "{}") as {
      windowOk?: boolean;
      dims?: { iw: number; ih: number; ow: number; oh: number; sw: number; sh: number };
    };
    const d = parsed.dims;
    if (d) {
      const stream = resolveCdpStreamBounds(mode);
      console.log(
        `[viewport] interact window=${stream.width}x${stream.height} device=${device.width}x${device.height} inner=${d.iw}x${d.ih} outer=${d.ow}x${d.oh} screen=${d.sw}x${d.sh} windowBounds=${parsed.windowOk ? "ok" : "skip"}`
      );
    }
  } catch {
    /* result parse optional */
  }
  fcLog("setViewport ok mode=", mode, `device=${device.width}x${device.height}`);
}

/** Resize viewport, reload for responsive reflow, re-stamp data-tag-id (live view sync). */
export async function setViewportAndReload(
  scrapeId: string,
  mode: ViewportMode,
  restoreTagIds: Array<{ tag_id: number; selector_hint: string }> = [],
  size?: { width: number; height: number }
): Promise<void> {
  const device = size ?? resolveCdpDeviceMetrics(mode);
  const stampList = restoreTagIds.filter((t) => t.selector_hint?.trim());
  const stampJson = JSON.stringify(stampList);
  const stampBlock =
    stampList.length > 0
      ? `
  await page.evaluate((list) => {
    for (const item of list) {
      try {
        const el = document.querySelector(item.selector_hint);
        if (el) el.setAttribute('data-tag-id', String(item.tag_id));
      } catch (_) {}
    }
  }, ${stampJson});
  await page.waitForTimeout(300);`
      : "";
  // IIFE — Firecrawl interact REPL persists top-level bindings between calls.
  const code = `
await (async () => {
${buildCdpWindowViewportSyncBody(device.width, device.height, mode === "mo", resolveCdpStreamBounds(mode).width, resolveCdpStreamBounds(mode).height)}
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(600);${stampBlock}
})();
`.trim();
  const resp = await interactCode(scrapeId, code, 90);
  if (resp.success !== true) {
    throw new Error(`setViewportAndReload(${mode}) failed: ${resp.error ?? JSON.stringify(resp)}`);
  }
  fcLog("setViewportAndReload ok mode=", mode, `device=${device.width}x${device.height}`, "tags=", stampList.length);
}

export function pickLiveViewUrl(session: FirecrawlSession): string | null {
  return (
    session.liveViewMeta?.live_view_url ??
    session.interactiveLiveViewUrl ??
    session.liveViewUrl
  );
}

/** Ping interact to refresh live view URL while scrape session is still alive. */
export async function refreshLiveViewSession(
  session: FirecrawlSession
): Promise<{ ok: boolean; session: FirecrawlSession; error?: string }> {
  const boot = await interactCode(session.scrapeId, "await page.title();", 20);
  if (boot.success !== true) {
    return { ok: false, session, error: boot.error ?? "interact failed" };
  }

  const liveViewUrl = boot.liveViewUrl ?? boot.live_view_url ?? session.liveViewUrl;
  const interactiveLiveViewUrl =
    boot.interactiveLiveViewUrl ??
    boot.interactive_live_view_url ??
    session.interactiveLiveViewUrl;
  const liveViewMeta = buildLiveViewSessionMeta(
    boot,
    interactiveLiveViewUrl ?? liveViewUrl ?? pickLiveViewUrl(session)
  );
  logLiveViewSession(liveViewMeta, "refreshed");

  const updated: FirecrawlSession = {
    ...session,
    cdpUrl: boot.cdpUrl ?? boot.cdp_url ?? session.cdpUrl,
    liveViewUrl,
    interactiveLiveViewUrl,
    liveViewMeta,
  };
  return { ok: true, session: updated };
}

export { probeLiveViewUrl, liveViewRemainingSec, isLiveViewExpired } from "./liveview-session.js";
export type { LiveViewSessionMeta } from "./liveview-session.js";
export { fetchCreditUsageForKey } from "./firecrawl-key-pool.js";
export type { FirecrawlCreditUsage } from "./firecrawl-key-pool.js";

/** GET team credit usage for the active/context API key. */
export async function fetchCreditUsage(): Promise<import("./firecrawl-key-pool.js").FirecrawlCreditUsage> {
  const { fetchCreditUsageForKey } = await import("./firecrawl-key-pool.js");
  return fetchCreditUsageForKey();
}
