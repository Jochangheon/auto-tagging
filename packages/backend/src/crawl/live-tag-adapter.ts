import type { SnapshotCandidate } from "@autotag/shared";
import type { LiveTagEntry } from "./tag-live-dom.js";

/** Map live DOM tag entries to snapshot pipeline candidates for LLM bulk extract. */
export function liveEntriesToSnapshotCandidates(
  entries: LiveTagEntry[],
  linkByTagId?: Map<number, string | null>
): SnapshotCandidate[] {
  return entries.map((e) => ({
    tag_id: e.tag_id,
    rect: e.bbox ?? { x: 0, y: 0, w: 0, h: 0 },
    accessible_name: e.text,
    tag: e.tag,
    classification: "ambiguous" as const,
    hidden_in_dom: isElementHidden(e),
    role: inferRole(e.tag),
    reason: buildCandidateReason(e),
    dom_path: e.dom_path,
    link_url: linkByTagId?.get(e.tag_id) ?? extractLinkFromHints(e.identification_hints),
  }));
}

function extractLinkFromHints(hints: string | undefined): string | null {
  if (!hints) return null;
  const m = hints.match(/href=([^\s|]+)/);
  if (!m?.[1]) return null;
  const href = m[1].trim();
  if (href === "#" || href.toLowerCase().startsWith("javascript:")) return null;
  try {
    const u = new URL(href, "https://example.local/");
    return u.pathname + u.search + u.hash;
  } catch {
    return href;
  }
}

function buildCandidateReason(entry: LiveTagEntry): string {
  if (entry.identification_hints) {
    return `live_dom_interactive | hints: ${entry.identification_hints}`;
  }
  if (!entry.text || entry.text.startsWith("[")) {
    return "live_dom_interactive | classification: ambiguous";
  }
  return "live_dom_interactive";
}

function isElementHidden(entry: LiveTagEntry): boolean {
  if (entry.bbox && entry.bbox.w > 0 && entry.bbox.h > 0) {
    const hr = entry.visibility?.hidden_reason;
    if (hr === "offscreen" || hr === "collapsed_parent") return false;
  }
  if (entry.visibility) return !entry.visibility.is_visible;
  if (!entry.bbox) return true;
  return entry.bbox.w <= 0 && entry.bbox.h <= 0;
}

function inferRole(tag: string): string | null {
  if (tag === "button") return "button";
  if (tag === "a") return "link";
  if (tag === "input") return "textbox";
  return null;
}

