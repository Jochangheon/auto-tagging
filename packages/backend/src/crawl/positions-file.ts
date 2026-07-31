import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ViewportMode, ElementPosition, RecommendedTagCandidate, HiddenReason, Platform } from "@autotag/shared";
import { hasElementBbox, reconcileHiddenReasonWithBbox, buildElementLocation } from "@autotag/shared";
import type { LiveTagEntry } from "./tag-live-dom.js";
import type { CaptureBbox, CaptureBboxMap } from "./page-capture.js";
import { captureDir } from "./page-capture.js";

export interface PositionRecord extends ElementPosition {}

export interface PositionsFile {
  job_id: string;
  viewport: ViewportMode;
  page_url: string;
  page_width: number;
  page_height: number;
  /** Full-page capture URL (pc.png | mo.png) — same folder as this file. */
  capture_url?: string | null;
  saved_at: string;
  positions: PositionRecord[];
}

/** Valid document-space bbox (w/h > 0). */
export function hasValidBbox(bbox: CaptureBbox | null | undefined): boolean {
  return hasElementBbox(bbox);
}

/** Keep page_view (tag_id 0) and elements with a confirmed overlay bbox. */
export function candidateHasConfirmedPosition(c: RecommendedTagCandidate): boolean {
  if (c.tag_id === 0) return true;
  return hasValidBbox(c.overlay_bbox);
}

export function filterCandidatesWithConfirmedPosition(
  candidates: RecommendedTagCandidate[]
): RecommendedTagCandidate[] {
  return candidates.filter(candidateHasConfirmedPosition);
}

export function positionsRelPath(): string {
  return "positions.json";
}

export function positionsAbsPath(jobId: string): string {
  return path.join(captureDir(), jobId, positionsRelPath());
}

function bboxArea(bbox: CaptureBbox | null | undefined): number {
  if (!bbox) return 0;
  return Math.max(0, bbox.w) * Math.max(0, bbox.h);
}

function pickBbox(
  tagged: CaptureBbox | null | undefined,
  captured: CaptureBbox | undefined,
  hasMenuPath: boolean
): CaptureBbox | null {
  const tagArea = bboxArea(tagged);
  const capArea = bboxArea(captured);
  if (capArea <= 0) return tagged ?? null;
  if (tagArea <= 0) return captured ?? null;
  if (hasMenuPath && tagArea >= capArea * 0.5) return tagged ?? null;
  // page_view 오버레이는 캡처 시점(스크롤 0·팝업 닫힘) 좌표가 PNG와 일치
  if (capArea >= tagArea * 0.5) return captured ?? null;
  return tagged ?? captured ?? null;
}

/** Merge explore-time tag bboxes with capture-time resample into positions.json rows. */
export function buildPositionsFromEntries(
  entries: LiveTagEntry[],
  opts: {
    jobId: string;
    viewport: ViewportMode;
    pageUrl: string;
    pageWidth: number;
    pageHeight: number;
    captureBboxes?: CaptureBboxMap;
  }
): PositionsFile {
  const captureBboxes = opts.captureBboxes ?? {};
  const positions: PositionRecord[] = [];

  for (const entry of entries) {
    if (entry.tag_id <= 0) continue;
    const hasMenuPath = (entry.menu_reveal_path?.length ?? 0) > 0;
    const bbox = pickBbox(entry.bbox, captureBboxes[entry.tag_id], hasMenuPath);
    if (!hasValidBbox(bbox)) continue;
    positions.push({
      tag_id: entry.tag_id,
      selector_hint: `[data-tag-id="${entry.tag_id}"]`,
      bbox,
      platform: entry.platform,
      menu_reveal_path: entry.menu_reveal_path,
      hidden_reason: reconcileHiddenReasonWithBbox(entry.visibility?.hidden_reason, bbox),
      text: entry.text?.slice(0, 120),
    });
  }

  positions.sort((a, b) => a.tag_id - b.tag_id);

  return {
    job_id: opts.jobId,
    viewport: opts.viewport,
    page_url: opts.pageUrl,
    page_width: opts.pageWidth,
    page_height: opts.pageHeight,
    saved_at: new Date().toISOString(),
    positions,
  };
}

export async function writePositionsFile(jobId: string, file: PositionsFile): Promise<void> {
  const abs = positionsAbsPath(jobId);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(file, null, 2), "utf8");
}

export async function readPositionsFile(jobId: string): Promise<PositionsFile | null> {
  try {
    const raw = await readFile(positionsAbsPath(jobId), "utf8");
    return JSON.parse(raw) as PositionsFile;
  } catch {
    return null;
  }
}

export function positionsByTagId(file: PositionsFile | null): Map<number, PositionRecord> {
  const map = new Map<number, PositionRecord>();
  for (const row of file?.positions ?? []) {
    map.set(row.tag_id, row);
  }
  return map;
}

export function positionsWithBbox(file: PositionsFile | null): PositionRecord[] {
  return (file?.positions ?? []).filter((p) => hasValidBbox(p.bbox));
}

/** Canonical positions.json from finalized candidates (page_view + confirmed elements only). */
export function buildPositionsFileFromCandidates(
  candidates: RecommendedTagCandidate[],
  opts: {
    jobId: string;
    viewport: ViewportMode;
    pageUrl: string;
    pageWidth: number;
    pageHeight: number;
    captureUrl?: string | null;
  }
): PositionsFile {
  const positions: PositionRecord[] = [];
  const platform = opts.viewport === "mo" ? "MO" : "PC";

  if (opts.pageWidth > 0 && opts.pageHeight > 0) {
    const pageView = candidates.find((c) => c.tag_id === 0);
    positions.push({
      tag_id: 0,
      selector_hint: pageView?.selector_hint?.trim() || "document",
      bbox: { x: 0, y: 0, w: opts.pageWidth, h: opts.pageHeight },
      platform,
      viewport: opts.viewport,
      page_width: opts.pageWidth,
      page_height: opts.pageHeight,
      capture_url: opts.captureUrl ?? null,
      hidden_reason: "visible",
      text: pageView?.text || pageView?.label || "page_view",
    });
  }

  for (const c of candidates) {
    if (c.tag_id <= 0) continue;
    if (!hasValidBbox(c.overlay_bbox)) continue;
    const row = buildElementLocation(c, {
      viewport: opts.viewport,
      page_width: opts.pageWidth,
      page_height: opts.pageHeight,
      capture_url: opts.captureUrl ?? null,
    });
    positions.push(row);
  }

  positions.sort((a, b) => a.tag_id - b.tag_id);

  return {
    job_id: opts.jobId,
    viewport: opts.viewport,
    page_url: opts.pageUrl,
    page_width: opts.pageWidth,
    page_height: opts.pageHeight,
    capture_url: opts.captureUrl ?? null,
    saved_at: new Date().toISOString(),
    positions,
  };
}

/** Merge positions.json rows onto candidates — single geometry source for UI & taxonomy. */
export function applyPositionsToCandidates(
  candidates: RecommendedTagCandidate[],
  positions: ElementPosition[]
): RecommendedTagCandidate[] {
  if (!positions.length) return candidates;
  const byTag = new Map(positions.map((p) => [p.tag_id, p]));
  return candidates.map((c) => {
    const pos = byTag.get(c.tag_id);
    if (!pos) return c;
    return {
      ...c,
      selector_hint: pos.selector_hint?.trim() || c.selector_hint,
      selectors_fallback: pos.selectors_fallback?.length
        ? pos.selectors_fallback
        : c.selectors_fallback,
      overlay_bbox: pos.bbox ?? c.overlay_bbox ?? null,
      menu_reveal_path: pos.menu_reveal_path ?? c.menu_reveal_path,
      hidden_reason: reconcileHiddenReasonWithBbox(
        (pos.hidden_reason ?? c.hidden_reason) as import("@autotag/shared").HiddenReason | undefined,
        pos.bbox ?? c.overlay_bbox
      ),
      platform: (pos.platform as Platform | undefined) ?? c.platform,
      element_capture_url: pos.element_capture_url ?? c.element_capture_url ?? null,
    };
  });
}

export function positionsByTagIdFromList(
  positions: ElementPosition[] | undefined
): Map<number, ElementPosition> {
  const map = new Map<number, ElementPosition>();
  for (const row of positions ?? []) {
    map.set(row.tag_id, row);
  }
  return map;
}
