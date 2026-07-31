// Unified resolve policy: tag_id → selector_hint → fallbacks → bbox-only

import type { UiTarget } from "./schema.js";

export type ResolveMethod = "tag_id" | "selector_hint" | "fallback" | "bbox_only" | "none";

export interface ResolveTargetInput {
  tag_id?: number | string | null;
  selector_hint?: string;
  selectors_fallback?: string[];
  overlay_bbox?: UiTarget["overlay_bbox"];
}

export interface ResolveTargetResult {
  element: Element | null;
  method: ResolveMethod;
  resolved_selector: string | null;
}

type QueryRoot = Document | Element;

/** Resolve a live DOM element using Phase 0 priority order. */
export function resolveTarget(root: QueryRoot, input: ResolveTargetInput): ResolveTargetResult {
  const tagId = normalizeTagId(input.tag_id);
  if (tagId != null) {
    const byTag = root.querySelector(`[data-tag-id="${tagId}"]`);
    if (byTag) {
      return { element: byTag, method: "tag_id", resolved_selector: `[data-tag-id="${tagId}"]` };
    }
  }

  const hint = input.selector_hint?.trim();
  if (hint) {
    const el = queryUnique(root, hint);
    if (el) {
      return { element: el, method: "selector_hint", resolved_selector: hint };
    }
  }

  for (const sel of input.selectors_fallback ?? []) {
    const trimmed = sel?.trim();
    if (!trimmed) continue;
    const el = queryUnique(root, trimmed);
    if (el) {
      return { element: el, method: "fallback", resolved_selector: trimmed };
    }
  }

  if (input.overlay_bbox) {
    return { element: null, method: "bbox_only", resolved_selector: null };
  }

  return { element: null, method: "none", resolved_selector: null };
}

/** Tag id selector string (CDP highlight primary). */
export function tagIdSelector(tagId: number | string): string {
  return `[data-tag-id="${tagId}"]`;
}

function normalizeTagId(raw: number | string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

function queryUnique(root: QueryRoot, selector: string): Element | null {
  try {
    const matches = root.querySelectorAll(selector);
    if (matches.length === 1) return matches[0] ?? null;
    return null;
  } catch {
    return null;
  }
}
