import type {
  PageNode,
  TaxonomyUniqueEventRow,
  TaxonomyViewModel,
  ViewportMode,
} from "@autotag/shared";
import { normalizePageUrl } from "@autotag/shared";
import { cropActionGroupFromPagePng } from "../crawl/element-capture.js";
import { captureApiUrl } from "../crawl/page-capture.js";
import { positionsByTagId, readPositionsFile } from "../crawl/positions-file.js";
import type { CaptureBbox } from "../crawl/page-capture.js";

function jobIdFromCapture(url: string | null | undefined): string | null {
  const m = /\/captures\/([^/]+)\//.exec(url || "");
  return m?.[1] || null;
}

function validBbox(bbox: CaptureBbox | null | undefined): CaptureBbox | null {
  if (!bbox) return null;
  if (!(bbox.w > 0) || !(bbox.h > 0)) return null;
  return { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h };
}

interface PageIndexEntry {
  jobId: string | null;
  viewport: ViewportMode;
  captureUrl: string | null;
  bboxByTag: Map<number, CaptureBbox>;
}

function pageKey(url: string, viewport: ViewportMode): string {
  return `${normalizePageUrl(url)}::${viewport}`;
}

function buildPageIndex(pages: PageNode[]): Map<string, PageIndexEntry> {
  const index = new Map<string, PageIndexEntry>();
  for (const page of pages) {
    const viewport: ViewportMode = page.active_viewport === "mo" ? "mo" : "pc";
    const bboxByTag = new Map<number, CaptureBbox>();
    for (const position of page.positions ?? []) {
      const bbox = validBbox(position.bbox as CaptureBbox | null | undefined);
      if (bbox) bboxByTag.set(position.tag_id, bbox);
    }
    for (const candidate of page.candidates ?? []) {
      if (bboxByTag.has(candidate.tag_id)) continue;
      const bbox = validBbox(candidate.overlay_bbox as CaptureBbox | null | undefined);
      if (bbox) bboxByTag.set(candidate.tag_id, bbox);
    }
    const jobId = page.job_id || jobIdFromCapture(page.capture_url);
    index.set(pageKey(page.page_url, viewport), {
      jobId,
      viewport,
      captureUrl: page.capture_url || (jobId ? captureApiUrl(jobId, viewport) : null),
      bboxByTag,
    });
  }
  return index;
}

async function diskBboxes(
  jobId: string,
  cache: Map<string, Map<number, CaptureBbox>>
): Promise<Map<number, CaptureBbox>> {
  const cached = cache.get(jobId);
  if (cached) return cached;
  const byTag = new Map<number, CaptureBbox>();
  const file = await readPositionsFile(jobId);
  for (const [tagId, row] of positionsByTagId(file)) {
    const bbox = validBbox(row.bbox as CaptureBbox | null | undefined);
    if (bbox) byTag.set(tagId, bbox);
  }
  cache.set(jobId, byTag);
  return byTag;
}

async function pickCropSource(
  row: TaxonomyUniqueEventRow,
  pageIndex: Map<string, PageIndexEntry>,
  diskCache: Map<string, Map<number, CaptureBbox>>
): Promise<{
  jobId: string;
  viewport: ViewportMode;
  boxes: CaptureBbox[];
  fallbackUrl: string | null;
} | null> {
  const groups = new Map<
    string,
    { jobId: string; viewport: ViewportMode; boxes: CaptureBbox[]; fallbackUrl: string | null }
  >();
  for (const member of row.members || []) {
    const loc = member.element_location;
    const viewport: ViewportMode = loc?.viewport === "mo" ? "mo" : "pc";
    const page = member.page_url ? pageIndex.get(pageKey(member.page_url, viewport)) : undefined;
    const jobId = jobIdFromCapture(loc?.capture_url) || page?.jobId || "";
    const fallbackUrl =
      loc?.capture_url || page?.captureUrl || (jobId ? captureApiUrl(jobId, viewport) : null);
    if (!jobId && !fallbackUrl) continue;

    let bbox = validBbox(loc?.bbox as CaptureBbox | null | undefined);
    if (!bbox && page) bbox = page.bboxByTag.get(member.tag_id) ?? null;
    if (!bbox && jobId) bbox = (await diskBboxes(jobId, diskCache)).get(member.tag_id) ?? null;

    const key = `${jobId || fallbackUrl}::${viewport}`;
    const g = groups.get(key) ?? {
      jobId: jobId || "page",
      viewport,
      boxes: [],
      fallbackUrl,
    };
    if (bbox) g.boxes.push(bbox);
    groups.set(key, g);
  }
  let best: {
    jobId: string;
    viewport: ViewportMode;
    boxes: CaptureBbox[];
    fallbackUrl: string | null;
  } | null = null;
  for (const g of groups.values()) {
    if (!best || g.boxes.length > best.boxes.length) best = g;
  }
  return best;
}

function fileKeyForRow(row: TaxonomyUniqueEventRow): string {
  const raw = [
    row.event_name,
    row.category_display || row.category || "",
    row.action_display || row.action || "",
    String(row.member_count || 0),
  ].join("_");
  return (raw.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 68) || "action") + "_sq";
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

/**
 * Attach full-page action images (boxes drawn on the page capture).
 */
export async function attachActionImagesToTaxonomy(
  taxonomy: TaxonomyViewModel,
  pages: PageNode[] = [],
  options?: { onlyMissing?: boolean }
): Promise<TaxonomyViewModel> {
  if (!Array.isArray(taxonomy?.tabs)) return taxonomy;
  const pageIndex = buildPageIndex(pages);
  const diskCache = new Map<string, Map<number, CaptureBbox>>();
  const jobs: TaxonomyUniqueEventRow[] = [];

  for (const tab of taxonomy.tabs) {
    if (tab.kind !== "page_category") continue;
    for (const row of tab.event_rows || []) {
      if (options?.onlyMissing && row.action_image_url) continue;
      jobs.push(row);
    }
  }

  let attached = 0;
  let missing = 0;
  await mapPool(jobs, 4, async (row) => {
    const source = await pickCropSource(row, pageIndex, diskCache);
    if (!source) {
      row.action_image_url = null;
      missing += 1;
      return;
    }
    if (row.event_name !== "페이지뷰" && source.boxes.length) {
      const cropped = await cropActionGroupFromPagePng(
        source.jobId,
        source.viewport,
        source.boxes,
        { fileKey: fileKeyForRow(row) }
      );
      if (cropped) {
        row.action_image_url = cropped.url;
        attached += 1;
        return;
      }
    }
    row.action_image_url = source.fallbackUrl;
    if (source.fallbackUrl) attached += 1;
    else missing += 1;
  });

  console.log(`[taxonomy] action images attached=${attached} missing=${missing}`);
  return taxonomy;
}

/** Copy action_image_url from a skeleton taxonomy onto a freshly described one. */
export function copyActionImages(
  from: TaxonomyViewModel,
  to: TaxonomyViewModel
): TaxonomyViewModel {
  const byKey = new Map<string, string | null>();
  for (const tab of from.tabs || []) {
    if (tab.kind !== "page_category") continue;
    for (const row of tab.event_rows || []) {
      if (row.action_image_url) byKey.set(row.row_key, row.action_image_url);
    }
  }
  for (const tab of to.tabs || []) {
    if (tab.kind !== "page_category") continue;
    for (const row of tab.event_rows || []) {
      const url = byKey.get(row.row_key);
      if (url) row.action_image_url = url;
    }
  }
  return to;
}
