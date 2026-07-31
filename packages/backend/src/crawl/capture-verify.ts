import type { RecommendedTagCandidate } from "@autotag/shared";
import type { CaptureBboxMap } from "./page-capture.js";
import type { LiveTagEntry } from "./tag-live-dom.js";

export interface CaptureQcReport {
  ok: boolean;
  png_bytes: number;
  page_width: number;
  page_height: number;
  tagged_in_dom: number;
  candidate_count: number;
  with_overlay_bbox: number;
  positions_saved: number;
  capture_found_count: number;
  no_capture_count: number;
  missing_bbox_tag_ids: number[];
  modal_cleared: boolean;
  element_capture_ok: number;
  element_capture_total: number;
  warnings: string[];
  errors: string[];
}

function bboxArea(bbox: { w: number; h: number } | null | undefined): number {
  if (!bbox) return 0;
  return Math.max(0, bbox.w) * Math.max(0, bbox.h);
}

/** Post-capture QA — page_view PNG + per-element capture coverage. */
export function verifyCaptureQuality(opts: {
  captureBboxes?: CaptureBboxMap;
  captureWidth: number;
  captureHeight: number;
  entries: LiveTagEntry[];
  candidates?: RecommendedTagCandidate[];
  modalCleared?: boolean;
  pngBytes?: number;
  elementCaptureOk?: number;
  elementCaptureTotal?: number;
  positionsSaved?: number;
}): CaptureQcReport {
  const warnings: string[] = [];
  const errors: string[] = [];

  const pngBytes = opts.pngBytes ?? 0;
  if (pngBytes < 8_000) errors.push(`png_too_small bytes=${pngBytes}`);

  const pageWidth = opts.captureWidth;
  const pageHeight = opts.captureHeight;
  if (pageWidth <= 0 || pageHeight <= 0) {
    errors.push(`invalid_page_size ${pageWidth}x${pageHeight}`);
  }

  const taggedInDom = opts.entries.filter((e) => e.tag_id > 0).length;
  const candidates = opts.candidates ?? [];
  const actionable = candidates.filter((c) => c.tag_id > 0);
  const withOverlay = actionable.filter((c) => bboxArea(c.overlay_bbox) > 0);
  const captureFoundCount = actionable.filter((c) => c.capture_found).length;
  const noCaptureCount = actionable.filter((c) => c.no_capture).length;

  const missingBboxTagIds: number[] = [];
  for (const c of actionable) {
    if (c.element_capture_url) continue;
    if (bboxArea(c.overlay_bbox) > 0) continue;
    missingBboxTagIds.push(c.tag_id);
  }
  if (missingBboxTagIds.length > 0) {
    const sample = missingBboxTagIds.slice(0, 8).join(",");
    warnings.push(`missing_capture count=${missingBboxTagIds.length} sample=${sample}`);
  }

  const modalCleared = opts.modalCleared !== false;
  if (!modalCleared) errors.push("modal_not_cleared");

  const positionsSaved = opts.positionsSaved ?? 0;
  if (positionsSaved <= 0) {
    errors.push("positions_json_missing");
  } else if (withOverlay.length === 0) {
    warnings.push(`positions_saved=${positionsSaved} but no overlay_bbox on candidates`);
  }

  const elementOk = opts.elementCaptureOk ?? captureFoundCount;
  const elementTotal = opts.elementCaptureTotal ?? actionable.length;
  if (elementTotal > 0 && elementOk === 0) {
    errors.push("no_element_captures");
  } else if (elementTotal > 0 && elementOk < elementTotal * 0.3) {
    warnings.push(`low_element_capture ok=${elementOk} total=${elementTotal}`);
  }

  const ok = errors.length === 0;
  return {
    ok,
    png_bytes: pngBytes,
    page_width: pageWidth,
    page_height: pageHeight,
    tagged_in_dom: taggedInDom,
    candidate_count: actionable.length,
    with_overlay_bbox: withOverlay.length,
    positions_saved: positionsSaved,
    capture_found_count: captureFoundCount,
    no_capture_count: noCaptureCount,
    missing_bbox_tag_ids: missingBboxTagIds,
    modal_cleared: modalCleared,
    element_capture_ok: elementOk,
    element_capture_total: elementTotal,
    warnings,
    errors,
  };
}

export function logCaptureQc(report: CaptureQcReport, jobId: string, viewport: string): void {
  const tag = `job=${jobId.slice(0, 8)} viewport=${viewport}`;
  const level = report.ok ? "ok" : "fail";
  const detail = [
    `page=${report.page_width}x${report.page_height}`,
    `png=${report.png_bytes}`,
    `positions=${report.positions_saved}`,
    `elements=${report.element_capture_ok}/${report.element_capture_total}`,
    `no_capture=${report.no_capture_count}`,
  ].join(" ");
  if (report.ok && report.warnings.length === 0) {
    console.log(`[capture-verify] ${level} ${tag} ${detail}`);
    return;
  }
  const extra = [...report.errors, ...report.warnings].join("; ");
  console.warn(`[capture-verify] ${level} ${tag} ${detail} — ${extra}`);
}
