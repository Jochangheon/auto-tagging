import type { SnapshotSuggestion } from "@autotag/shared";
import { deriveEventName } from "@autotag/shared";
import type { ExtractorHint } from "./types.js";

const SOURCE_PRIORITY: Record<ExtractorHint["source"], number> = {
  stagehand: 3,
  scrapegraph: 2,
  skyvern: 1,
};

/** Merge extractor hints by tag_id — higher-priority source wins per field */
export function mergeExtractorHints(hints: ExtractorHint[]): ExtractorHint[] {
  const byTag = new Map<number, ExtractorHint>();

  for (const hint of hints) {
    const existing = byTag.get(hint.tag_id);
    if (!existing) {
      byTag.set(hint.tag_id, { ...hint });
      continue;
    }

    const keepExisting =
      (existing.confidence ?? 0) > (hint.confidence ?? 0) ||
      ((existing.confidence ?? 0) === (hint.confidence ?? 0) &&
        SOURCE_PRIORITY[existing.source] >= SOURCE_PRIORITY[hint.source]);

    if (keepExisting) {
      byTag.set(hint.tag_id, {
        ...existing,
        event_name: existing.event_name ?? hint.event_name,
        parameters: existing.parameters ?? hint.parameters,
        note: [existing.note, hint.note].filter(Boolean).join(" | ") || undefined,
      });
    } else {
      byTag.set(hint.tag_id, {
        ...hint,
        event_name: hint.event_name ?? existing.event_name,
        parameters: hint.parameters ?? existing.parameters,
        note: [hint.note, existing.note].filter(Boolean).join(" | ") || undefined,
      });
    }
  }

  return [...byTag.values()].sort((a, b) => a.tag_id - b.tag_id);
}

/** Format merged hints as LLM context block */
export function hintsToMarkdown(hints: ExtractorHint[]): string {
  if (hints.length === 0) return "";

  const lines = ["## Extractor hints (pre-merged, use for disambiguation)", ""];
  for (const h of hints) {
    const parts = [
      `tag:${h.tag_id}`,
      `source=${h.source}`,
      h.event_name ? `suggested_name="${h.event_name}"` : null,
      h.confidence != null ? `confidence=${h.confidence.toFixed(2)}` : null,
      h.note ? `note="${h.note}"` : null,
    ].filter(Boolean);
    lines.push(`- ${parts.join(" ")}`);
  }
  return lines.join("\n");
}

/** Apply Gemini suggestions, preserving extractor-only tag_ids if Gemini omitted them */
export function finalizeSuggestions(
  gemini: SnapshotSuggestion[],
  hints: ExtractorHint[],
  allowedTagIds: Set<number>
): SnapshotSuggestion[] {
  const byTag = new Map<number, SnapshotSuggestion>();
  for (const s of gemini) {
    if (allowedTagIds.has(s.tag_id)) byTag.set(s.tag_id, s);
  }

  for (const h of hints) {
    if (!allowedTagIds.has(h.tag_id) || byTag.has(h.tag_id)) continue;
    if (!h.event_name) continue;
    byTag.set(h.tag_id, {
      tag_id: h.tag_id,
      category: "unknown",
      action: h.event_name,
      label: h.event_name,
      merge_label: h.event_name,
      event_name: deriveEventName("unknown", h.event_name),
      parameters: h.parameters ?? [],
    });
  }

  return [...byTag.values()].sort((a, b) => a.tag_id - b.tag_id);
}
