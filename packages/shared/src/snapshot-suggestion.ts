import {
  actionFromEventName,
  canonicalizeEventName,
  findRegistryEventName,
  normalizeDisplaySpacing,
  sanitizeThinkingDataEventName,
  type EventRegistry,
} from "./event-registry.js";
import { filterLlmClickExtras } from "./event-params.js";
import type { SnapshotSuggestion } from "./snapshot-pipeline.js";

export interface NormalizeSuggestionOpts {
  registry?: EventRegistry;
}

/** Normalize LLM JSON row → SnapshotSuggestion (event_name from LLM + registry). */
export function normalizeSnapshotSuggestion(
  raw: unknown,
  opts: NormalizeSuggestionOpts = {}
): SnapshotSuggestion | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.tag_id !== "number") return null;

  const registry = opts.registry ?? {};
  const category =
    typeof row.category === "string" ? normalizeDisplaySpacing(row.category) : "";
  let label = typeof row.label === "string" ? normalizeDisplaySpacing(row.label) : "";
  let merge_label =
    typeof row.merge_label === "string" ? normalizeDisplaySpacing(row.merge_label) : "";

  const newEventName =
    typeof row.new_event_name === "string" ? row.new_event_name.trim() : "";
  const newEventReason =
    typeof row.new_event_reason === "string" ? row.new_event_reason.trim() : "";
  let rawEventName = typeof row.event_name === "string" ? row.event_name.trim() : "";

  let registryCreated = Boolean(newEventName);
  if (newEventName) {
    rawEventName = newEventName;
  }

  if (!category) return null;
  if (!label) label = category;
  if (!merge_label) merge_label = label;

  // Prefer existing registry spelling (spacing-insensitive) before creating a new name.
  const registryHit = findRegistryEventName(rawEventName || "클릭", registry);
  if (registryHit) {
    rawEventName = registryHit;
    registryCreated = false;
  } else if (rawEventName) {
    rawEventName = canonicalizeEventName(rawEventName);
  }

  const event_name = sanitizeThinkingDataEventName(rawEventName || "클릭", registry);
  const action =
    typeof row.action === "string" && row.action.trim()
      ? row.action.trim()
      : actionFromEventName(event_name);

  const parameters = normalizeParameters(row.parameters);
  const rationale = typeof row.rationale === "string" ? row.rationale : undefined;

  return {
    tag_id: row.tag_id,
    category,
    action,
    label,
    merge_label,
    event_name,
    parameters,
    rationale,
    registry_created: registryCreated && !registry[event_name],
    new_event_reason:
      registryCreated && !registry[event_name] ? newEventReason || rationale : undefined,
  };
}

function normalizeParameters(raw: unknown): SnapshotSuggestion["parameters"] {
  if (!Array.isArray(raw)) return [];
  const parsed = raw.filter(
    (p): p is { name: string; value_hint: string | null } =>
      !!p &&
      typeof p === "object" &&
      typeof (p as { name: unknown }).name === "string"
  );
  return filterLlmClickExtras(parsed);
}
