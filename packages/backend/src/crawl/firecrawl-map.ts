/**
 * Firecrawl /v2/map — discover URLs for a site (no scrape/LLM / no analyze).
 */

import {
  acquireFirecrawlKey,
  releaseFirecrawlKey,
  resolveFirecrawlApiKey,
} from "./firecrawl-key-pool.js";
import { hostFromUrl, rootDomain } from "./site-domain.js";

export type FirecrawlMapLink = {
  url: string;
  title?: string;
  description?: string;
};

export type MapSiteOptions = {
  url: string;
  limit?: number;
  sitemap?: "skip" | "include" | "only";
  includeSubdomains?: boolean;
  ignoreQueryParameters?: boolean;
  search?: string;
  timeoutMs?: number;
  /** Abort in-flight Firecrawl map (client disconnect / user cancel). */
  signal?: AbortSignal;
};

export type MapSiteResult =
  | {
      ok: true;
      seed_url: string;
      links: FirecrawlMapLink[];
      raw_count: number;
      filtered_out: number;
    }
  | { ok: false; error: string };

export type MapProgressEvent =
  | { type: "seed"; seed_url: string; links: FirecrawlMapLink[] }
  | {
      type: "batch";
      seed_url: string;
      links: FirecrawlMapLink[];
      added: number;
      total: number;
      step_limit: number;
    }
  | {
      type: "stopped";
      reason: "timeout" | "aborted";
      error: string;
      seed_url: string;
      links: FirecrawlMapLink[];
      total: number;
    }
  | { type: "error"; error: string }
  | {
      type: "done";
      seed_url: string;
      links: FirecrawlMapLink[];
      raw_count: number;
      filtered_out: number;
    };

/** Non-HTML assets / docs dumps — not useful as tagging page targets. */
const ASSET_EXT =
  /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|mp3|pdf|zip|gz|xml|json|txt|md|markdown|csv|rss|atom|yaml|yml|webp|avif)(?:$|\?)/i;

/** Auth / SSO endpoints — skip (not analysis landing pages). */
const JUNK_PATH =
  /\/(?:login|logout|signin|signout|signup|register|oauth|auth\/|callback|sso|saml|passport)(?:\/|$|\?)/i;

const JUNK_HOST = /^(?:nid|accounts?|login|auth|sso|passport)\./i;

/** Framework / API paths — not user-facing pages. */
const NON_PAGE_PATH =
  /\/(?:api|_next|static|assets|cdn-cgi|wp-json|graphql|__webpack|node_modules)(?:\/|$)/i;

function apiBase(): string {
  return (process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev").replace(/\/$/, "");
}

/** Accept bare domain (`kanu.co.kr`) or full URL → canonical https origin URL. */
export function normalizeSeedUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("url required");
  // Strip accidental whitespace / trailing punctuation from paste.
  const cleaned = trimmed.replace(/[)\],.;]+$/g, "");
  const withProto = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  const u = new URL(withProto);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("http(s) URL only");
  }
  const host = u.hostname;
  const isLocal =
    host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (!host || (!isLocal && !host.includes("."))) {
    throw new Error("유효한 도메인/URL이 아닙니다");
  }
  u.hash = "";
  u.search = "";
  // Domain-only → site root (Firecrawl map expects a page URL).
  if (!u.pathname || u.pathname === "") u.pathname = "/";
  // Prefer trailing slash on origin root for stable seed matching.
  if (u.pathname === "/") {
    return `${u.protocol}//${u.host}/`;
  }
  // Drop trailing slash on deeper paths for dedupe consistency.
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.href;
}

export function canonicalizeLinkUrl(href: string): string | null {
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.href;
  } catch {
    return null;
  }
}

function stripWwwHost(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}

/**
 * True when host is registrable apex or www.<apex> (not blog./api./dev.).
 */
function isApexOrWwwHost(host: string): boolean {
  const h = host.toLowerCase();
  const root = rootDomain(h);
  return stripWwwHost(h) === root;
}

/**
 * Sitemap often lists https://www.example.com/page/... while the user seeded
 * https://dev.example.com/. With includeSubdomains=false those www URLs were
 * dropped → only the seed survived after timeout. Rewrite apex/www paths onto
 * the seed host so the same paths are kept.
 */
export function rewriteUrlOntoSeedHost(href: string, seedHost: string): string | null {
  try {
    const u = new URL(href);
    const seed = seedHost.toLowerCase();
    if (u.hostname.toLowerCase() === seed) {
      return canonicalizeLinkUrl(u.href);
    }
    if (rootDomain(u.hostname) !== rootDomain(seed)) return null;
    if (!isApexOrWwwHost(u.hostname)) return null;
    u.hostname = seed;
    return canonicalizeLinkUrl(u.href);
  } catch {
    return null;
  }
}

export function shouldKeepUrl(
  href: string,
  seedRoot: string,
  opts?: { seedHost?: string; includeSubdomains?: boolean }
): boolean {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (rootDomain(u.hostname) !== seedRoot) return false;
  if (opts?.includeSubdomains === false && opts.seedHost) {
    if (stripWwwHost(u.hostname) !== stripWwwHost(opts.seedHost)) return false;
  }
  if (JUNK_HOST.test(u.hostname)) return false;
  if (ASSET_EXT.test(u.pathname)) return false;
  if (NON_PAGE_PATH.test(u.pathname)) return false;
  const pathAndQuery = u.pathname + (u.search || "");
  if (JUNK_PATH.test(pathAndQuery)) return false;
  if (/^(?:mailto|javascript|tel):/i.test(href)) return false;
  return true;
}

function pathDepth(href: string): number {
  try {
    const p = new URL(href).pathname.replace(/\/+$/, "");
    if (!p || p === "/") return 0;
    return p.split("/").filter(Boolean).length;
  } catch {
    return 99;
  }
}

/** Seed first → same host → shallow paths → alpha. */
export function sortMapLinks(links: FirecrawlMapLink[], seedUrl: string): FirecrawlMapLink[] {
  const seedCanon = canonicalizeLinkUrl(seedUrl) || seedUrl;
  let seedHost = "";
  try {
    seedHost = new URL(seedCanon).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    /* ignore */
  }

  return [...links].sort((a, b) => {
    const aSeed = a.url === seedCanon || a.url === seedUrl ? 0 : 1;
    const bSeed = b.url === seedCanon || b.url === seedUrl ? 0 : 1;
    if (aSeed !== bSeed) return aSeed - bSeed;

    let aHost = "";
    let bHost = "";
    try {
      aHost = new URL(a.url).hostname.replace(/^www\./i, "").toLowerCase();
      bHost = new URL(b.url).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      /* ignore */
    }
    const aSame = seedHost && aHost === seedHost ? 0 : 1;
    const bSame = seedHost && bHost === seedHost ? 0 : 1;
    if (aSame !== bSame) return aSame - bSame;

    const d = pathDepth(a.url) - pathDepth(b.url);
    if (d !== 0) return d;
    return a.url.localeCompare(b.url);
  });
}

export function dedupeLinks(links: FirecrawlMapLink[]): FirecrawlMapLink[] {
  const seen = new Set<string>();
  const out: FirecrawlMapLink[] = [];
  for (const link of links) {
    const key = canonicalizeLinkUrl(link.url) || link.url.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...link, url: key });
  }
  return out;
}

function parseLinks(body: Record<string, unknown>): FirecrawlMapLink[] {
  const raw = body.links ?? (body.data as Record<string, unknown> | undefined)?.links;
  if (!Array.isArray(raw)) return [];
  const out: FirecrawlMapLink[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push({ url: item.trim() });
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const url = typeof o.url === "string" ? o.url.trim() : "";
      if (!url) continue;
      const title = typeof o.title === "string" ? o.title.trim() : "";
      const description = typeof o.description === "string" ? o.description.trim() : "";
      out.push({
        url,
        title: title || undefined,
        description: description || undefined,
      });
    }
  }
  return out;
}

function locationForSeed(seedUrl: string): { country: string; languages: string[] } | undefined {
  try {
    const host = new URL(seedUrl).hostname.toLowerCase();
    if (host.endsWith(".kr") || host.endsWith(".co.kr")) {
      return { country: "KR", languages: ["ko-KR", "ko", "en"] };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function isMapTimeoutError(err: string): boolean {
  return /timed out|timeout|시간 초과|초과됐습니다|TimeoutError/i.test(err);
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === "object" && "name" in err && (err as { name?: string }).name === "AbortError") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /aborted|AbortError/i.test(msg);
}

/** Node 18-safe combine of abort signals (AbortSignal.any is Node 20+). */
function anyAbortSignal(...signals: AbortSignal[]): AbortSignal {
  const nativeAny = (
    AbortSignal as unknown as { any?: (list: AbortSignal[]) => AbortSignal }
  ).any;
  if (typeof nativeAny === "function") return nativeAny(signals);
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
    for (const s of signals) s.removeEventListener("abort", onAbort);
  };
  for (const s of signals) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

/** Build increasing map limits so smaller batches can finish (and surface) first. */
function progressiveStepLimits(limit: number): number[] {
  const caps = [20, 40, 80, 150, 300, 500, 1000, 2000, 5000];
  const steps: number[] = [];
  for (const c of caps) {
    if (c >= limit) break;
    steps.push(c);
  }
  steps.push(limit);
  return steps;
}

type MapRunContext = {
  seed_url: string;
  apiKey: string;
  includeSubdomains: boolean;
  ignoreQueryParameters: boolean;
  search?: string;
  signal?: AbortSignal;
};

async function runMapOnce(
  ctx: MapRunContext,
  sitemapMode: "skip" | "include" | "only",
  mapLimit: number,
  mapTimeout: number
): Promise<MapSiteResult> {
  const { seed_url, apiKey, includeSubdomains, ignoreQueryParameters } = ctx;
  try {
    if (ctx.signal?.aborted) {
      return { ok: false, error: "aborted" };
    }
    const key = resolveFirecrawlApiKey(apiKey);
    const body: Record<string, unknown> = {
      url: seed_url,
      limit: mapLimit,
      sitemap: sitemapMode,
      includeSubdomains,
      ignoreQueryParameters,
      timeout: mapTimeout,
    };
    if (ctx.search?.trim()) body.search = ctx.search.trim();
    const loc = locationForSeed(seed_url);
    if (loc) body.location = loc;

    const timeoutSignal = AbortSignal.timeout(mapTimeout + 15_000);
    const signal = ctx.signal ? anyAbortSignal(ctx.signal, timeoutSignal) : timeoutSignal;

    const response = await fetch(`${apiBase()}/v2/map`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, error: `map invalid JSON (HTTP ${response.status})` };
    }

    if (response.status >= 400 || json.success === false) {
      const err =
        (typeof json.error === "string" && json.error) ||
        (typeof json.message === "string" && json.message) ||
        `map failed HTTP ${response.status}`;
      return { ok: false, error: err };
    }

    const parsed = parseLinks(json);
    const seedHost = hostFromUrl(seed_url);
    const seedRoot = rootDomain(seedHost);
    const kept: FirecrawlMapLink[] = [];
    let filtered_out = 0;
    for (const link of parsed) {
      if (
        shouldKeepUrl(link.url, seedRoot, {
          seedHost,
          includeSubdomains,
        })
      ) {
        kept.push(link);
        continue;
      }
      // www./apex sitemap → same path on the seeded host (dev./stg./…)
      if (!includeSubdomains && seedHost) {
        const rewritten = rewriteUrlOntoSeedHost(link.url, seedHost);
        if (
          rewritten &&
          shouldKeepUrl(rewritten, seedRoot, {
            seedHost,
            includeSubdomains: false,
          })
        ) {
          kept.push({ ...link, url: rewritten });
          continue;
        }
      }
      filtered_out += 1;
    }

    const seedCanon = canonicalizeLinkUrl(seed_url) || seed_url;
    if (!kept.some((l) => canonicalizeLinkUrl(l.url) === seedCanon)) {
      kept.unshift({ url: seedCanon });
    }

    const links = sortMapLinks(dedupeLinks(kept), seed_url);
    return {
      ok: true,
      seed_url,
      links,
      raw_count: parsed.length,
      filtered_out,
    };
  } catch (err) {
    if (isAbortError(err) || ctx.signal?.aborted) {
      return { ok: false, error: "aborted" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/timeout|aborted|TimeoutError/i.test(msg)) {
      return {
        ok: false,
        error:
          "페이지 URL 수집 시간이 초과됐습니다. 최대 개수를 줄이거나 「사이트맵만」으로 다시 시도하세요.",
      };
    }
    return { ok: false, error: msg };
  }
}

/** Call Firecrawl map and return filtered same-site page URLs. Never starts analysis. */
export async function mapSiteUrls(opts: MapSiteOptions): Promise<MapSiteResult> {
  let seed_url: string;
  try {
    seed_url = normalizeSeedUrl(opts.url);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 200));
  const sitemap = opts.sitemap ?? "include";
  const includeSubdomains = opts.includeSubdomains === true;
  const ignoreQueryParameters = opts.ignoreQueryParameters !== false;
  const timeoutMs = Math.max(15_000, Math.min(300_000, Number(opts.timeoutMs) || 120_000));

  const jobId = `map-${Date.now().toString(36)}`;
  let apiKey: string;
  try {
    apiKey = await acquireFirecrawlKey(jobId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const result = await runMapOnce(
      {
        seed_url,
        apiKey,
        includeSubdomains,
        ignoreQueryParameters,
        search: opts.search,
        signal: opts.signal,
      },
      sitemap,
      limit,
      timeoutMs
    );

    if (!result.ok && isMapTimeoutError(result.error)) {
      return {
        ok: false,
        error:
          "사이트 규모가 커서 URL 수집이 시간 초과됐습니다. 「최대」를 줄이거나 「사이트맵만」으로 다시 시도하세요.",
      };
    }
    return result;
  } finally {
    releaseFirecrawlKey(jobId);
  }
}

/**
 * Progressive map: emit seed immediately, then growing limit batches.
 * On timeout/abort: stop immediately (no auto-retry) and keep whatever was found.
 */
export async function mapSiteUrlsProgressive(
  opts: MapSiteOptions,
  onEvent: (ev: MapProgressEvent) => void | Promise<void>
): Promise<void> {
  let seed_url: string;
  try {
    seed_url = normalizeSeedUrl(opts.url);
  } catch (err) {
    await onEvent({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 100));
  const sitemap = opts.sitemap ?? "include";
  const includeSubdomains = opts.includeSubdomains === true;
  const ignoreQueryParameters = opts.ignoreQueryParameters !== false;
  const baseTimeout = Math.max(15_000, Math.min(300_000, Number(opts.timeoutMs) || 90_000));

  const seedCanon = canonicalizeLinkUrl(seed_url) || seed_url;
  let accumulated: FirecrawlMapLink[] = [{ url: seedCanon }];
  await onEvent({ type: "seed", seed_url, links: [...accumulated] });

  const jobId = `map-p-${Date.now().toString(36)}`;
  let apiKey: string;
  try {
    apiKey = await acquireFirecrawlKey(jobId);
  } catch (err) {
    await onEvent({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const ctx: MapRunContext = {
    seed_url,
    apiKey,
    includeSubdomains,
    ignoreQueryParameters,
    search: opts.search,
    signal: opts.signal,
  };

  let lastRaw = 0;
  let lastFiltered = 0;

  try {
    const steps = progressiveStepLimits(limit);
    for (const stepLimit of steps) {
      if (opts.signal?.aborted) {
        await onEvent({
          type: "stopped",
          reason: "aborted",
          error: "수집이 중단됐습니다.",
          seed_url,
          links: accumulated,
          total: accumulated.length,
        });
        return;
      }

      // Smaller steps get shorter timeouts so we fail fast and keep partial results.
      const stepTimeout =
        stepLimit <= 20
          ? Math.min(baseTimeout, 60_000)
          : stepLimit <= 40
            ? Math.min(baseTimeout, 75_000)
            : stepLimit <= 80
              ? Math.min(baseTimeout, 90_000)
              : baseTimeout;

      console.log(
        `[firecrawl-map] progressive step limit=${stepLimit} timeout=${stepTimeout} sitemap=${sitemap} seed=${seed_url}`
      );

      const result = await runMapOnce(ctx, sitemap, stepLimit, stepTimeout);

      if (!result.ok) {
        if (result.error === "aborted" || opts.signal?.aborted) {
          await onEvent({
            type: "stopped",
            reason: "aborted",
            error: "수집이 중단됐습니다.",
            seed_url,
            links: accumulated,
            total: accumulated.length,
          });
          return;
        }
        if (isMapTimeoutError(result.error)) {
          await onEvent({
            type: "stopped",
            reason: "timeout",
            error:
              "시간 초과로 수집을 중단했습니다. 지금까지 찾은 URL만 선택하세요. (최대를 줄이거나 「사이트맵만」 권장)",
            seed_url,
            links: accumulated,
            total: accumulated.length,
          });
          return;
        }
        await onEvent({ type: "error", error: result.error });
        return;
      }

      lastRaw = result.raw_count;
      lastFiltered = result.filtered_out;
      const before = accumulated.length;
      const merged = sortMapLinks(dedupeLinks([...accumulated, ...result.links]), seed_url);
      accumulated = merged;
      const added = Math.max(0, accumulated.length - before);
      await onEvent({
        type: "batch",
        seed_url,
        links: accumulated,
        added,
        total: accumulated.length,
        step_limit: stepLimit,
      });

      // Already have enough for the user's limit — stop early.
      if (accumulated.length >= limit) break;
      // Firecrawl returned fewer than requested → site exhausted.
      if (result.links.length < stepLimit) break;
    }

    await onEvent({
      type: "done",
      seed_url,
      links: accumulated.slice(0, limit),
      raw_count: lastRaw,
      filtered_out: lastFiltered,
    });
  } finally {
    releaseFirecrawlKey(jobId);
  }
}
