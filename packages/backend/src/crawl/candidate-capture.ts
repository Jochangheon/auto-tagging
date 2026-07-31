import type {
  CandidateMember,
  CandidateTree,
  RecommendedTagCandidate,
} from "@autotag/shared";
import type { HiddenReason } from "@autotag/shared";
import { reconcileHiddenReasonWithBbox } from "@autotag/shared";
import type { LiveTagEntry } from "./tag-live-dom.js";
import type { CaptureBboxMap } from "./page-capture.js";

/** Truly absent from a static full-page capture. */
const NO_CAPTURE_REASONS: HiddenReason[] = [
  "display_none",
  "visibility_hidden",
  "opacity_zero",
  "zero_size",
];

function bboxArea(bbox: { w: number; h: number } | null | undefined): number {
  if (!bbox) return 0;
  return Math.max(0, bbox.w) * Math.max(0, bbox.h);
}

function pickOverlayBbox(
  tagged: { x: number; y: number; w: number; h: number } | null | undefined,
  captured: { x: number; y: number; w: number; h: number } | undefined,
  hasMenuPath: boolean
): { x: number; y: number; w: number; h: number } | null {
  const tagArea = bboxArea(tagged);
  const capArea = bboxArea(captured);

  if (capArea <= 0) return tagged ?? null;
  if (tagArea <= 0) return captured ?? null;

  // Menu/popup items: tagging snapshot (menu open) beats baseline capture (menu closed).
  if (hasMenuPath && tagArea >= capArea * 0.5) return tagged ?? null;

  // Header/GNB: prefer fresh capture coords when both exist.
  return captured ?? tagged ?? null;
}

export function shouldNoCapture(candidate: RecommendedTagCandidate): boolean {
  if (candidate.tag_id === 0) return true;
  const bbox = candidate.overlay_bbox;
  if (!bbox || bbox.w <= 0 || bbox.h <= 0) return true;
  const reason = candidate.hidden_reason;
  if (reason && NO_CAPTURE_REASONS.includes(reason)) return true;
  return false;
}

/** Merge live-tag bbox (explore) with capture-time resample — never drop tagging coords. */
export function applyCaptureBboxes(
  candidates: RecommendedTagCandidate[],
  captureBboxes: CaptureBboxMap,
  liveEntries: LiveTagEntry[] = []
): RecommendedTagCandidate[] {
  const entryBbox = new Map<number, LiveTagEntry["bbox"]>();
  for (const e of liveEntries) entryBbox.set(e.tag_id, e.bbox);

  return candidates.map((c) => {
    if (c.tag_id === 0) return c;

    const tagged = entryBbox.get(c.tag_id) ?? c.overlay_bbox;
    const captured = captureBboxes[c.tag_id];
    const hasMenuPath = (c.menu_reveal_path?.length ?? 0) > 0;
    const overlay_bbox = pickOverlayBbox(tagged, captured, hasMenuPath);
    const hidden_reason = reconcileHiddenReasonWithBbox(c.hidden_reason, overlay_bbox);

    return {
      ...c,
      overlay_bbox,
      hidden_reason,
      capture_found: !!captured && bboxArea(captured) > 0,
    };
  });
}

function patchMember(
  member: CandidateMember,
  byTagId: Map<number, RecommendedTagCandidate>
): CandidateMember {
  const full = byTagId.get(member.tag_id);
  if (!full) return member;
  return {
    ...member,
    overlay_bbox: full.overlay_bbox ?? member.overlay_bbox,
    hidden_reason: full.hidden_reason ?? member.hidden_reason,
    element_capture_url: full.element_capture_url ?? member.element_capture_url,
    capture_status: full.capture_status ?? member.capture_status,
  };
}

/** Phase 1 done: candidates ready to show, element PNGs not captured yet. */
export function markCandidatesPendingCapture(
  candidates: RecommendedTagCandidate[]
): RecommendedTagCandidate[] {
  return candidates.map((c) =>
    c.tag_id === 0
      ? { ...c, capture_status: "done" }
      : { ...c, capture_status: "pending", element_capture_url: null }
  );
}

/** Phase 2 progress: patch a single tag_id's capture result into the live candidate list. */
export function patchCandidateElementCapture(
  candidates: RecommendedTagCandidate[],
  tagId: number,
  result: import("./element-capture.js").ElementCaptureResult
): RecommendedTagCandidate[] {
  return candidates.map((c) => {
    if (c.tag_id !== tagId) return c;
    if (!result.ok) {
      return {
        ...c,
        capture_status: "failed",
        element_capture_url: null,
        capture_found: false,
        no_capture: true,
      };
    }
    return {
      ...c,
      capture_status: "done",
      element_capture_url: result.url,
      capture_found: true,
      no_capture: false,
      overlay_bbox: result.bbox ?? c.overlay_bbox,
    };
  });
}

/** Tree is built before capture bbox merge — sync members from final candidates. */
export function syncCandidateTreeBboxes(
  tree: CandidateTree,
  candidates: RecommendedTagCandidate[]
): CandidateTree {
  const byTagId = new Map(candidates.map((c) => [c.tag_id, c]));

  return {
    ...tree,
    categories: tree.categories.map((cat) => ({
      ...cat,
      actions: cat.actions.map((act) => ({
        ...act,
        label_groups: act.label_groups.map((lg) => ({
          ...lg,
          members: lg.members.map((m) => patchMember(m, byTagId)),
        })),
      })),
    })),
  };
}

/** Merge per-element capture PNGs (highlight baked in) onto candidates. */
export function attachElementCaptureResults(
  candidates: RecommendedTagCandidate[],
  captures: Map<number, import("./element-capture.js").ElementCaptureResult>
): RecommendedTagCandidate[] {
  return candidates.map((c) => {
    if (c.tag_id === 0) return c;
    const shot = captures.get(c.tag_id);
    if (!shot?.ok) {
      return {
        ...c,
        element_capture_url: null,
        capture_found: false,
        no_capture: true,
        capture_status: "failed",
      };
    }
    return {
      ...c,
      element_capture_url: shot.url,
      capture_found: true,
      no_capture: false,
      overlay_bbox: shot.bbox ?? c.overlay_bbox,
      capture_status: "done",
    };
  });
}

/** @deprecated page_view uses full-page capture; elements use attachElementCaptureResults. */
export function mergeEntryBboxesAfterCapture(
  exploreEntries: LiveTagEntry[],
  refreshedEntries: LiveTagEntry[]
): LiveTagEntry[] {
  const refreshed = new Map(refreshedEntries.map((e) => [e.tag_id, e]));
  return exploreEntries.map((entry) => {
    const fresh = refreshed.get(entry.tag_id);
    if (!fresh) return entry;
    if (entry.menu_reveal_path?.length) return entry;
    return {
      ...entry,
      bbox: fresh.bbox ?? entry.bbox,
      visibility: fresh.visibility ?? entry.visibility,
    };
  });
}

export function annotateCandidatesCapture(
  candidates: RecommendedTagCandidate[],
  _captureHeight?: number | null
): RecommendedTagCandidate[] {
  return candidates.map((c) => {
    if (c.tag_id === 0) return { ...c, no_capture: false };
    const no_capture = !c.element_capture_url;
    return { ...c, no_capture };
  });
}
