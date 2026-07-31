/**
 * Direct sitemap/robots.txt fetch — the fast path before Firecrawl /v2/map.
 *
 * Firecrawl has to reach the site from its own infra, which is slow (often
 * >90s → timeout) for dev/stage hosts that are not in its index. Reading
 * robots.txt + sitemap.xml ourselves takes ~1s and covers most Korean sites.
 */

import {
  canonicalizeLinkUrl,
  dedupeLinks,
  rewriteUrlOntoSeedHost,
  shouldKeepUrl,
  sortMapLinks,
  type FirecrawlMapLink,
} from "./firecrawl-map.js";
import { hostFromUrl, rootDomain } from "./site-domain.js";

export type SitemapFetchOptions = {
  /** Already normalized seed URL. */
  seedUrl: string;
  limit: number;
  includeSubdomains: boolean;
  signal?: AbortSignal;
  /** Whole-operation budget. */
  budgetMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
};

export type SitemapFetchResult = {
  links: FirecrawlMapLink[];
  raw_count: number;
  filtered_out: number;
  /** Sitemap documents that returned at least one <loc>. */
  sources: string[];
};

const DEFAULT_BUDGET_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const MAX_DOCUMENTS = 12;
const MAX_BYTES = 8 * 1024 * 1024;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const anyOf = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyOf === "function") return anyOf([a, b]);
  const ac = new AbortController();
  const abort = () => ac.abort();
  if (a.aborted || b.aborted) ac.abort();
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return ac.signal;
}

async function fetchText(
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "*/*" },
      signal: combineSignals(signal, AbortSignal.timeout(timeoutMs)),
    });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") || 0);
    if (Number.isFinite(len) && len > MAX_BYTES) return null;
    const text = await res.text();
    return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
  } catch {
    return null;
  }
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const raw = decodeXmlEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim());
    if (raw) out.push(raw);
  }
  return out;
}

function parseRobotsSitemaps(txt: string): string[] {
  const out: string[] = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** Same-root-domain sitemap docs only — a foreign host's sitemap is not this site. */
function sitemapCandidateAllowed(href: string, seedRoot: string): string | null {
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (rootDomain(u.hostname) !== seedRoot) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Read robots.txt + common sitemap paths and return same-site page URLs.
 * Never throws: on any failure it returns an empty link list so the caller
 * can fall back to Firecrawl.
 */
export async function fetchSitemapPageUrls(
  opts: SitemapFetchOptions
): Promise<SitemapFetchResult> {
  const { seedUrl, limit, includeSubdomains } = opts;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const deadline = Date.now() + budgetMs;
  const empty: SitemapFetchResult = {
    links: [],
    raw_count: 0,
    filtered_out: 0,
    sources: [],
  };

  let origin: string;
  let seedHost: string;
  try {
    origin = new URL(seedUrl).origin;
    seedHost = hostFromUrl(seedUrl);
  } catch {
    return empty;
  }
  const seedRoot = rootDomain(seedHost);

  const queue: string[] = [];
  const queued = new Set<string>();
  const pushCandidate = (href: string) => {
    const allowed = sitemapCandidateAllowed(href, seedRoot);
    if (!allowed || queued.has(allowed)) return;
    queued.add(allowed);
    queue.push(allowed);
  };

  const robots = await fetchText(`${origin}/robots.txt`, opts.signal, requestTimeoutMs);
  if (robots) {
    for (const href of parseRobotsSitemaps(robots)) pushCandidate(href);
  }
  for (const path of [
    "/sitemap.xml",
    "/sitemap_index.xml",
    "/sitemap-index.xml",
    "/sitemap/sitemap.xml",
  ]) {
    pushCandidate(`${origin}${path}`);
  }

  const sources: string[] = [];
  const pageUrls: string[] = [];
  let documents = 0;

  while (queue.length > 0 && documents < MAX_DOCUMENTS) {
    if (opts.signal?.aborted || Date.now() >= deadline) break;
    const docUrl = queue.shift() as string;
    documents += 1;
    const xml = await fetchText(docUrl, opts.signal, requestTimeoutMs);
    if (!xml) continue;
    const locs = parseLocs(xml);
    if (locs.length === 0) continue;
    sources.push(docUrl);

    if (/<sitemapindex[\s>]/i.test(xml)) {
      for (const href of locs) pushCandidate(href);
      continue;
    }
    for (const href of locs) pageUrls.push(href);
    // Plenty of raw candidates already — filtering will trim below the limit.
    if (pageUrls.length >= limit * 20) break;
  }

  if (pageUrls.length === 0) return { ...empty, sources };

  const kept: FirecrawlMapLink[] = [];
  let filtered_out = 0;
  for (const href of pageUrls) {
    const canon = canonicalizeLinkUrl(href);
    if (!canon) {
      filtered_out += 1;
      continue;
    }
    if (shouldKeepUrl(canon, seedRoot, { seedHost, includeSubdomains })) {
      kept.push({ url: canon });
      continue;
    }
    // Dev/stage sitemaps often list www./apex URLs — keep the same path on the seeded host.
    if (!includeSubdomains) {
      const rewritten = rewriteUrlOntoSeedHost(canon, seedHost);
      if (
        rewritten &&
        shouldKeepUrl(rewritten, seedRoot, { seedHost, includeSubdomains: false })
      ) {
        kept.push({ url: rewritten });
        continue;
      }
    }
    filtered_out += 1;
  }

  return {
    links: sortMapLinks(dedupeLinks(kept), seedUrl),
    raw_count: pageUrls.length,
    filtered_out,
    sources,
  };
}
