/** Types + browser script loader for CDP highlight (evaluate uses plain .browser.js string). */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface OverlayBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HighlightTarget {
  tagId?: number | null;
  selectorHint?: string | null;
  selectorsFallback?: string[];
  overlayBbox?: OverlayBbox | null;
}

export interface HighlightOverlayInput {
  tagId?: number | null;
  selectorHint?: string | null;
  selectorsFallback?: string[];
  label?: string | null;
  overlayBbox?: OverlayBbox | null;
  /** When set, highlight every target (merged label group). */
  targets?: HighlightTarget[];
}

export interface HighlightOverlayResult {
  ok: boolean;
  method: "tag_id" | "selector_hint" | "fallback" | "bbox_only" | "none";
  resolved_selector: string | null;
  status?: string;
  reason?: string;
  error?: string;
  highlighted_count?: number;
}

let cachedBrowserScript: string | null = null;

/** Load overlay-script.browser.js — works in tsx (src) and node (dist) layouts. */
export function loadHighlightBrowserScript(): string {
  if (cachedBrowserScript) return cachedBrowserScript;

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "overlay-script.browser.js"),
    join(here, "..", "src", "crawl", "overlay-script.browser.js"),
  ];

  for (const path of candidates) {
    try {
      cachedBrowserScript = readFileSync(path, "utf8");
      return cachedBrowserScript;
    } catch {
      /* try next */
    }
  }

  throw new Error("overlay-script.browser.js not found (cdp highlight)");
}
