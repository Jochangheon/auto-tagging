import type { ExtractorHint, ExtractorInput, ExtractorResult } from "./types.js";

const SCRAPEGRAPH_URL = process.env.SCRAPEGRAPH_URL?.trim();

export function isScrapegraphEnabled(): boolean {
  return Boolean(SCRAPEGRAPH_URL);
}

/**
 * Calls optional Python Scrapegraph microservice (POST /extract).
 * Set SCRAPEGRAPH_URL=http://127.0.0.1:8090 when the service is running.
 */
export async function scrapegraphExtract(input: ExtractorInput): Promise<ExtractorResult> {
  const start = Date.now();
  if (!SCRAPEGRAPH_URL) {
    return { source: "scrapegraph", hints: [] };
  }

  const ambiguous = input.candidates.filter((c) => c.classification === "ambiguous");
  if (ambiguous.length === 0) {
    return { source: "scrapegraph", hints: [], durationMs: Date.now() - start };
  }

  try {
    const res = await fetch(`${SCRAPEGRAPH_URL.replace(/\/$/, "")}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        html: input.html_snapshot,
        url: input.url,
        stage_title: input.stageTitle,
        candidates: ambiguous.map((c) => ({
          tag_id: c.tag_id,
          accessible_name: c.accessible_name,
          tag: c.tag,
          hidden_in_dom: c.hidden_in_dom,
          reason: c.reason,
        })),
        schema: {
          type: "analytics_targets",
          event_name_prefix: "click_",
        },
      }),
      signal: AbortSignal.timeout(Number(process.env.SCRAPEGRAPH_TIMEOUT_MS ?? 60_000)),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Scrapegraph ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      mappings?: {
        tag_id: number;
        event_name?: string;
        confidence?: number;
        parameters?: { name: string; value_hint: string | null }[];
      }[];
    };

    const hints: ExtractorHint[] = (data.mappings ?? []).map((m) => ({
      tag_id: m.tag_id,
      event_name: m.event_name,
      parameters: m.parameters,
      confidence: m.confidence ?? 0.7,
      source: "scrapegraph",
    }));

    return {
      source: "scrapegraph",
      hints,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    console.warn("[autotag] Scrapegraph extract failed — skipping", err);
    return {
      source: "scrapegraph",
      hints: [],
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}
