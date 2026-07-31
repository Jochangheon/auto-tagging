// Optional Firecrawl HTML→markdown engine (self-hosted /parse or Firecrawl Cloud).
// Feature flag: USE_FIRECRAWL_MD=1 + FIRECRAWL_API_KEYS (cloud) or FIRECRAWL_API_URL (self-hosted)
// Falls back to custom md-converter on failure or missing config.
// We use Firecrawl ONLY on extension-provided HTML snapshots — NOT as URL crawler.

import type { SnapshotCandidate } from "@autotag/shared";
import type { HydratedDocument } from "./hydrate.js";
import { htmlToTaggedMarkdown, candidatesToMarkdown } from "./md-converter.js";
import { loadFirecrawlApiKeys, pickBestFirecrawlKey } from "../crawl/firecrawl-key-pool.js";

const FIRECRAWL_CLOUD_DEFAULT = "https://api.firecrawl.dev";

export interface FirecrawlMdOptions {
  apiUrl?: string;
  apiKey?: string;
}

export function isFirecrawlMdEnabled(): boolean {
  return process.env.USE_FIRECRAWL_MD === "1";
}

function resolveFirecrawlApiUrl(): string {
  const explicit = process.env.FIRECRAWL_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  if (loadFirecrawlApiKeys().length) return FIRECRAWL_CLOUD_DEFAULT;
  return "http://localhost:3002";
}

/**
 * Convert html_snapshot to tagged markdown via Firecrawl /parse or Cloud /scrape.
 * Post-processes output to inject [text](tag:N) links for candidate tag_ids.
 */
export async function htmlToMarkdownViaFirecrawl(
  html: string,
  candidates: SnapshotCandidate[],
  fallbackDoc: HydratedDocument
): Promise<string> {
  const opts: FirecrawlMdOptions = {
    apiUrl: resolveFirecrawlApiUrl(),
    apiKey: await pickBestFirecrawlKey(),
  };

  try {
    const rawMd = await callFirecrawl(html, opts);
    const tagged = injectTagLinks(rawMd, candidates);
    const candidateBlock = candidatesToMarkdown(candidates);
    return `${tagged}\n\n${candidateBlock}`.trim();
  } catch (err) {
    console.warn("[autotag] Firecrawl MD failed — custom converter fallback", err);
    return `${htmlToTaggedMarkdown(fallbackDoc)}\n\n${candidatesToMarkdown(candidates)}`;
  }
}

async function callFirecrawl(html: string, opts: FirecrawlMdOptions): Promise<string> {
  try {
    return await callFirecrawlParse(html, opts);
  } catch (parseErr) {
    console.warn("[autotag] Firecrawl /parse failed, trying /scrape", parseErr);
    return await callFirecrawlScrape(html, opts);
  }
}

async function callFirecrawlParse(html: string, opts: FirecrawlMdOptions): Promise<string> {
  const base = opts.apiUrl!.replace(/\/$/, "");
  const wrappedHtml = wrapHtml(html);

  const headers: Record<string, string> = {};
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  const paths = ["/v2/parse", "/v1/parse"];
  let lastError: Error | null = null;

  for (const path of paths) {
    try {
      const form = new FormData();
      form.append("file", new Blob([wrappedHtml], { type: "text/html" }), "snapshot.html");
      form.append(
        "options",
        JSON.stringify({
          formats: ["markdown"],
          onlyMainContent: false,
        })
      );

      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: form,
      });

      if (res.status === 404) continue;

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Firecrawl ${path} ${res.status}: ${errText.slice(0, 200)}`);
      }

      const md = extractMarkdown(await res.json());
      if (md) return md;

      throw new Error(`Firecrawl ${path} returned empty markdown`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  throw lastError ?? new Error("Firecrawl parse unavailable");
}

/** Cloud fallback: POST /v1/scrape with inline HTML via raw: URL or html body field. */
async function callFirecrawlScrape(html: string, opts: FirecrawlMdOptions): Promise<string> {
  const base = opts.apiUrl!.replace(/\/$/, "");
  const wrappedHtml = wrapHtml(html);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  const scrapeOptions = {
    formats: ["markdown"],
    onlyMainContent: false,
  };

  const attempts: Array<Record<string, unknown>> = [
    { url: `raw:${wrappedHtml}`, ...scrapeOptions },
    { url: "raw:", html: wrappedHtml, ...scrapeOptions },
    { html: wrappedHtml, ...scrapeOptions },
  ];

  const paths = ["/v1/scrape", "/v2/scrape"];
  let lastError: Error | null = null;

  for (const path of paths) {
    for (const body of attempts) {
      try {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (res.status === 404) break;

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Firecrawl ${path} ${res.status}: ${errText.slice(0, 200)}`);
        }

        const md = extractMarkdown(await res.json());
        if (md) return md;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
  }

  throw lastError ?? new Error("Firecrawl scrape unavailable");
}

function wrapHtml(html: string): string {
  return html.includes("<body") ? html : `<body>${html}</body>`;
}

function extractMarkdown(data: unknown): string | null {
  const obj = data as {
    success?: boolean;
    data?: { markdown?: string };
    markdown?: string;
  };
  const md = obj.data?.markdown ?? obj.markdown;
  return typeof md === "string" && md.length > 0 ? md : null;
}

/** Ensure candidate accessible names appear as [text](tag:N) in Firecrawl markdown. */
function injectTagLinks(markdown: string, candidates: SnapshotCandidate[]): string {
  let result = markdown;

  for (const c of candidates) {
    const name = c.accessible_name.trim();
    if (!name) continue;

    const tagLink = `[${truncate(name)}](tag:${c.tag_id})`;
    if (result.includes(`tag:${c.tag_id}`)) continue;

    const escaped = escapeRegex(name);
    const pattern = new RegExp(`(?<!\\[)${escaped}(?!\\]\\()`, "g");
    result = result.replace(pattern, tagLink);
  }

  return result;
}

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
