/**
 * URL discovery orchestration: direct sitemap first, Firecrawl /v2/map second.
 *
 * The sitemap pass answers in ~1s and never times out the request, so the user
 * always sees real URLs even when Firecrawl cannot reach the host (common for
 * dev./stg. subdomains that are absent from its index).
 */

import {
  canonicalizeLinkUrl,
  dedupeLinks,
  mapSiteUrls,
  mapSiteUrlsProgressive,
  normalizeSeedUrl,
  sortMapLinks,
  type FirecrawlMapLink,
  type MapProgressEvent,
  type MapSiteOptions,
  type MapSiteResult,
} from "./firecrawl-map.js";
import { fetchSitemapPageUrls } from "./sitemap-fetch.js";

function clampLimit(raw: unknown, fallback: number): number {
  return Math.max(1, Math.min(5000, Number(raw) || fallback));
}

/**
 * Progressive discovery. Emits the seed, then a sitemap batch, then Firecrawl
 * batches. Firecrawl is skipped entirely when the sitemap already satisfies the
 * request (`sitemap: "only"` or the limit is filled).
 */
export async function discoverSiteUrlsProgressive(
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

  const limit = clampLimit(opts.limit, 100);
  const includeSubdomains = opts.includeSubdomains === true;
  const sitemapMode = opts.sitemap ?? "include";

  const seedCanon = canonicalizeLinkUrl(seed_url) || seed_url;
  let accumulated: FirecrawlMapLink[] = [{ url: seedCanon }];
  await onEvent({ type: "seed", seed_url, links: [...accumulated] });

  const merge = (incoming: FirecrawlMapLink[]): number => {
    const before = accumulated.length;
    accumulated = sortMapLinks(dedupeLinks([...accumulated, ...incoming]), seed_url);
    return Math.max(0, accumulated.length - before);
  };
  const view = () => accumulated.slice(0, limit);

  let sitemapRaw = 0;
  let sitemapFiltered = 0;

  if (sitemapMode !== "skip") {
    const sm = await fetchSitemapPageUrls({
      seedUrl: seed_url,
      limit,
      includeSubdomains,
      signal: opts.signal,
    });
    sitemapRaw = sm.raw_count;
    sitemapFiltered = sm.filtered_out;
    console.log(
      `[site-url-discovery] sitemap seed=${seed_url} docs=${sm.sources.length} raw=${sm.raw_count} kept=${sm.links.length}`
    );
    if (sm.links.length > 0) {
      const added = merge(sm.links);
      await onEvent({
        type: "batch",
        seed_url,
        links: view(),
        added,
        total: Math.min(accumulated.length, limit),
        step_limit: limit,
      });
    }
  }

  if (opts.signal?.aborted) {
    await onEvent({
      type: "stopped",
      reason: "aborted",
      error: "수집이 중단됐습니다.",
      seed_url,
      links: view(),
      total: Math.min(accumulated.length, limit),
    });
    return;
  }

  // Sitemap answered the question — no reason to pay Firecrawl's latency.
  const sitemapSufficient =
    accumulated.length > 1 && (sitemapMode === "only" || accumulated.length >= limit);
  if (sitemapSufficient) {
    await onEvent({
      type: "done",
      seed_url,
      links: view(),
      raw_count: sitemapRaw,
      filtered_out: sitemapFiltered,
    });
    return;
  }

  const hadSitemapLinks = accumulated.length > 1;

  await mapSiteUrlsProgressive({ ...opts, url: seed_url }, async (ev) => {
    switch (ev.type) {
      case "seed":
        return;
      case "batch": {
        const added = merge(ev.links);
        await onEvent({
          ...ev,
          links: view(),
          added,
          total: Math.min(accumulated.length, limit),
        });
        return;
      }
      case "stopped": {
        merge(ev.links);
        await onEvent({
          ...ev,
          links: view(),
          total: Math.min(accumulated.length, limit),
        });
        return;
      }
      case "done": {
        merge(ev.links);
        await onEvent({
          type: "done",
          seed_url,
          links: view(),
          raw_count: ev.raw_count + sitemapRaw,
          filtered_out: ev.filtered_out + sitemapFiltered,
        });
        return;
      }
      case "error": {
        // Sitemap already produced usable URLs — finish with those instead of failing.
        if (hadSitemapLinks) {
          console.warn(`[site-url-discovery] firecrawl failed, using sitemap only: ${ev.error}`);
          await onEvent({
            type: "done",
            seed_url,
            links: view(),
            raw_count: sitemapRaw,
            filtered_out: sitemapFiltered,
          });
          return;
        }
        await onEvent(ev);
        return;
      }
    }
  });
}

/** One-shot discovery for the non-streaming endpoint. */
export async function discoverSiteUrls(opts: MapSiteOptions): Promise<MapSiteResult> {
  let seed_url: string;
  try {
    seed_url = normalizeSeedUrl(opts.url);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const limit = clampLimit(opts.limit, 200);
  const includeSubdomains = opts.includeSubdomains === true;
  const sitemapMode = opts.sitemap ?? "include";
  const seedCanon = canonicalizeLinkUrl(seed_url) || seed_url;

  let sitemapLinks: FirecrawlMapLink[] = [];
  let sitemapRaw = 0;
  let sitemapFiltered = 0;
  if (sitemapMode !== "skip") {
    const sm = await fetchSitemapPageUrls({
      seedUrl: seed_url,
      limit,
      includeSubdomains,
      signal: opts.signal,
    });
    sitemapLinks = sm.links;
    sitemapRaw = sm.raw_count;
    sitemapFiltered = sm.filtered_out;
  }

  const finish = (
    links: FirecrawlMapLink[],
    raw_count: number,
    filtered_out: number
  ): MapSiteResult => ({
    ok: true,
    seed_url,
    links: sortMapLinks(dedupeLinks([{ url: seedCanon }, ...links]), seed_url).slice(0, limit),
    raw_count,
    filtered_out,
  });

  if (sitemapLinks.length > 0 && (sitemapMode === "only" || sitemapLinks.length >= limit)) {
    return finish(sitemapLinks, sitemapRaw, sitemapFiltered);
  }

  const mapped = await mapSiteUrls({ ...opts, url: seed_url });
  if (!mapped.ok) {
    if (sitemapLinks.length > 0) {
      console.warn(`[site-url-discovery] firecrawl failed, using sitemap only: ${mapped.error}`);
      return finish(sitemapLinks, sitemapRaw, sitemapFiltered);
    }
    return mapped;
  }

  return finish(
    [...sitemapLinks, ...mapped.links],
    mapped.raw_count + sitemapRaw,
    mapped.filtered_out + sitemapFiltered
  );
}
