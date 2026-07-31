import type { ExtractorHint, ExtractorInput, ExtractorResult } from "./types.js";

const SKYVERN_API_URL = process.env.SKYVERN_API_URL?.trim();
const SKYVERN_API_KEY = process.env.SKYVERN_API_KEY?.trim();

export function isSkyvernEnabled(): boolean {
  return Boolean(SKYVERN_API_URL);
}

/**
 * Optional Skyvern vision+DOM adapter stub.
 * Calls SKYVERN_API_URL/v1/extract when configured (self-hosted Skyvern or proxy).
 */
export async function skyvernExtract(input: ExtractorInput): Promise<ExtractorResult> {
  const start = Date.now();
  if (!SKYVERN_API_URL) {
    return { source: "skyvern", hints: [] };
  }

  const ambiguous = input.candidates.filter((c) => c.classification === "ambiguous");
  if (ambiguous.length === 0) {
    return { source: "skyvern", hints: [], durationMs: Date.now() - start };
  }

  try {
    const res = await fetch(`${SKYVERN_API_URL.replace(/\/$/, "")}/v1/extract`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(SKYVERN_API_KEY ? { Authorization: `Bearer ${SKYVERN_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        html: input.html_snapshot,
        url: input.url,
        goal: "Identify analytics click targets for ambiguous UI elements (popups, modals, complex menus)",
        candidates: ambiguous.map((c) => ({
          tag_id: c.tag_id,
          accessible_name: c.accessible_name,
          rect: c.rect,
          hidden_in_dom: c.hidden_in_dom,
        })),
      }),
      signal: AbortSignal.timeout(Number(process.env.SKYVERN_TIMEOUT_MS ?? 90_000)),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Skyvern ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      targets?: {
        tag_id: number;
        event_name?: string;
        confidence?: number;
      }[];
    };

    const hints: ExtractorHint[] = (data.targets ?? []).map((t) => ({
      tag_id: t.tag_id,
      event_name: t.event_name,
      confidence: t.confidence ?? 0.65,
      source: "skyvern",
      note: "vision+dom",
    }));

    return {
      source: "skyvern",
      hints,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    console.warn("[autotag] Skyvern extract failed — skipping", err);
    return {
      source: "skyvern",
      hints: [],
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}
