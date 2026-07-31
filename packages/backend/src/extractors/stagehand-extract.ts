import type { SnapshotCandidate } from "@autotag/shared";
import type { ExtractorHint, ExtractorInput, ExtractorResult } from "./types.js";

const USE_STAGEHAND = process.env.USE_STAGEHAND === "1";

export function isStagehandEnabled(): boolean {
  return USE_STAGEHAND;
}

function candidateBlock(candidates: SnapshotCandidate[]): string {
  return candidates
    .map(
      (c) =>
        `- data-tag-id="${c.tag_id}" name="${c.accessible_name}" tag=${c.tag} hidden=${c.hidden_in_dom} reason=${c.reason ?? "ambiguous"}`
    )
    .join("\n");
}

interface TargetRow {
  tag_id: number;
  is_analytics_target: boolean;
  suggested_event_name?: string;
  element_role?: string;
}

/**
 * Stagehand page.extract() on html_snapshot via setContent (LOCAL or Browserbase).
 * Requires USE_STAGEHAND=1.
 */
export async function stagehandExtract(input: ExtractorInput): Promise<ExtractorResult> {
  const start = Date.now();
  if (!USE_STAGEHAND) {
    return { source: "stagehand", hints: [] };
  }

  const ambiguous = input.candidates.filter((c) => c.classification === "ambiguous");
  if (ambiguous.length === 0) {
    return { source: "stagehand", hints: [], durationMs: Date.now() - start };
  }

  try {
    const [{ Stagehand }, { z }] = await Promise.all([
      import("@browserbasehq/stagehand"),
      import("zod/v3"),
    ]);

    const browserbaseKey = process.env.STAGEHAND_API_KEY?.trim();
    const geminiKey = process.env.GEMINI_API_KEY?.trim();

    const stagehand = new Stagehand({
      env: browserbaseKey ? "BROWSERBASE" : "LOCAL",
      apiKey: browserbaseKey,
      modelName: (process.env.STAGEHAND_MODEL ?? "google/gemini-2.0-flash") as "google/gemini-2.0-flash",
      modelClientOptions: geminiKey ? { apiKey: geminiKey } : undefined,
      verbose: process.env.AUTOTAG_PIPELINE_DEBUG === "1" ? 2 : 1,
      localBrowserLaunchOptions: { headless: true },
      disablePino: true,
    });

    await stagehand.init();

    const baseUrl = input.url ?? "https://snapshot.local/";
    await stagehand.page.setContent(wrapSnapshotHtml(input.html_snapshot, baseUrl), {
      waitUntil: "domcontentloaded",
    });

    const TargetSchema = z.object({
      targets: z.array(
        z.object({
          tag_id: z.number(),
          is_analytics_target: z.boolean(),
          suggested_event_name: z.string().optional(),
          element_role: z.string().optional(),
        })
      ),
    });

    const instruction = `For each candidate element with data-tag-id attribute, determine if it is a genuine analytics click target (navigation, CTA, menu item, product action).
Skip decorative text and non-interactive wrappers.

Candidates:
${candidateBlock(ambiguous)}

Return targets array with tag_id, is_analytics_target, optional suggested_event_name (snake_case with click_ prefix), optional element_role.`;

    const extracted = await stagehand.page.extract({
      instruction,
      schema: TargetSchema,
    });

    await stagehand.close();

    const rows = (extracted.targets ?? []) as TargetRow[];
    const hints: ExtractorHint[] = rows
      .filter((t) => t.is_analytics_target)
      .map((t) => ({
        tag_id: t.tag_id,
        event_name: t.suggested_event_name,
        confidence: 0.75,
        source: "stagehand" as const,
        note: t.element_role ? `role=${t.element_role}` : undefined,
      }));

    return {
      source: "stagehand",
      hints,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    console.warn("[autotag] Stagehand extract failed — skipping", err);
    return {
      source: "stagehand",
      hints: [],
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

function wrapSnapshotHtml(html: string, baseUrl: string): string {
  const trimmed = html.trim();
  if (/<html[\s>]/i.test(trimmed)) return trimmed;
  return `<!DOCTYPE html><html><head><base href="${baseUrl}"></head><body>${trimmed}</body></html>`;
}
