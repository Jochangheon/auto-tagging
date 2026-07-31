/**
 * Direct-sitemap smoke test (no Firecrawl key needed).
 * Usage: npx tsx packages/backend/scripts/smoke-sitemap-fetch.mjs <url> [limit]
 */
const { fetchSitemapPageUrls } = await import("../src/crawl/sitemap-fetch.ts");
const { normalizeSeedUrl } = await import("../src/crawl/firecrawl-map.ts");

const url = process.argv[2] || "https://dev.happypointcard.com/";
const limit = Number(process.argv[3] || 200);

const seedUrl = normalizeSeedUrl(url);
const t0 = Date.now();
const r = await fetchSitemapPageUrls({
  seedUrl,
  limit,
  includeSubdomains: false,
});
console.log(
  `seed=${seedUrl} elapsed=${Date.now() - t0}ms docs=${r.sources.length} raw=${r.raw_count} kept=${r.links.length} filtered=${r.filtered_out}`
);
console.log("sources:", r.sources);
for (const l of r.links) console.log(" ", l.url);
