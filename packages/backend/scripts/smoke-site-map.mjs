import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");
try {
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]]) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
} catch {
  /* ignore */
}

const { mapSiteUrls } = await import("../src/crawl/firecrawl-map.ts");
const seed = process.argv[2] || "https://firecrawl.dev";
const r = await mapSiteUrls({
  url: seed,
  limit: 30,
  includeSubdomains: false,
});
if (!r.ok) {
  console.error(r);
  process.exit(1);
}
console.log(
  JSON.stringify(
    {
      ok: r.ok,
      seed_url: r.seed_url,
      count: r.links.length,
      filtered_out: r.filtered_out,
      sample: r.links.slice(0, 8).map((l) => l.url),
    },
    null,
    2
  )
);
