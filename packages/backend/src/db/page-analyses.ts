import type { PageNode, ViewportMode } from "@autotag/shared";
import { normalizePageUrl } from "@autotag/shared";
import { query } from "./pool.js";

export type PageAnalysisRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  page_url: string;
  page_url_norm: string;
  viewport: string;
  page_name: string | null;
  payload: PageNode;
  selection: Record<string, boolean> | null;
  analyzed_at: Date;
  updated_at: Date;
};

export async function upsertPageAnalysis(input: {
  userId: string;
  projectId: string;
  page: PageNode;
  selection?: Record<string, boolean> | null;
}): Promise<PageAnalysisRow> {
  const pageUrl = normalizePageUrl(input.page.page_url);
  const viewport = (input.page.active_viewport ?? "pc") as ViewportMode;
  const payload: PageNode = { ...input.page, page_url: pageUrl };

  const { rows } = await query<PageAnalysisRow>(
    `INSERT INTO page_analyses (
       user_id, project_id, page_url, page_url_norm, viewport, page_name, payload, selection, analyzed_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, COALESCE($9::timestamptz, now()), now())
     ON CONFLICT (project_id, page_url_norm, viewport) DO UPDATE SET
       page_url = EXCLUDED.page_url,
       page_name = EXCLUDED.page_name,
       payload = EXCLUDED.payload,
       selection = COALESCE(EXCLUDED.selection, page_analyses.selection),
       analyzed_at = EXCLUDED.analyzed_at,
       updated_at = now()
     RETURNING *`,
    [
      input.userId,
      input.projectId,
      pageUrl,
      pageUrl,
      viewport,
      payload.page_name ?? null,
      JSON.stringify(payload),
      input.selection != null ? JSON.stringify(input.selection) : null,
      payload.analyzed_at ?? null,
    ]
  );
  return hydrateRow(rows[0]);
}

export async function getPageAnalysis(
  userId: string,
  projectId: string,
  pageUrl: string,
  viewport: ViewportMode = "pc"
): Promise<PageAnalysisRow | null> {
  const norm = normalizePageUrl(pageUrl);
  const { rows } = await query<PageAnalysisRow>(
    `SELECT * FROM page_analyses
     WHERE user_id = $1 AND project_id = $2 AND page_url_norm = $3 AND viewport = $4
     LIMIT 1`,
    [userId, projectId, norm, viewport]
  );
  return rows[0] ? hydrateRow(rows[0]) : null;
}

export async function listPageAnalysesForProject(
  userId: string,
  projectId: string
): Promise<PageAnalysisRow[]> {
  const { rows } = await query<PageAnalysisRow>(
    `SELECT * FROM page_analyses WHERE user_id = $1 AND project_id = $2`,
    [userId, projectId]
  );
  return rows.map(hydrateRow);
}

export async function listPageAnalysesForUrls(
  userId: string,
  projectId: string,
  urls: Array<{ url: string; viewport?: ViewportMode }>
): Promise<PageAnalysisRow[]> {
  if (!urls.length) return [];
  const norms = urls.map((u) => normalizePageUrl(u.url));
  const viewports = urls.map((u) => u.viewport ?? "pc");

  // Compatible with PostgreSQL + PGlite (avoid unnest join quirks)
  const rows = await listPageAnalysesForProject(userId, projectId);
  const want = new Set(norms.map((n, i) => `${n}::${viewports[i]}`));
  return rows.filter((r) => want.has(`${r.page_url_norm}::${r.viewport}`));
}

export async function updatePageAnalysisPayload(input: {
  userId: string;
  projectId: string;
  pageUrl: string;
  viewport: ViewportMode;
  page: PageNode;
  selection?: Record<string, boolean> | null;
}): Promise<PageAnalysisRow | null> {
  const norm = normalizePageUrl(input.pageUrl);
  const payload: PageNode = { ...input.page, page_url: norm };
  const { rows } = await query<PageAnalysisRow>(
    `UPDATE page_analyses SET
       payload = $5::jsonb,
       page_name = $6,
       selection = COALESCE($7::jsonb, selection),
       updated_at = now()
     WHERE user_id = $1 AND project_id = $2 AND page_url_norm = $3 AND viewport = $4
     RETURNING *`,
    [
      input.userId,
      input.projectId,
      norm,
      input.viewport,
      JSON.stringify(payload),
      payload.page_name ?? null,
      input.selection != null ? JSON.stringify(input.selection) : null,
    ]
  );
  return rows[0] ? hydrateRow(rows[0]) : null;
}

export async function patchPageSelection(input: {
  userId: string;
  projectId: string;
  pageUrl: string;
  viewport: ViewportMode;
  selection: Record<string, boolean>;
}): Promise<void> {
  const norm = normalizePageUrl(input.pageUrl);
  await query(
    `UPDATE page_analyses SET
       selection = COALESCE(selection, '{}'::jsonb) || $5::jsonb,
       updated_at = now()
     WHERE user_id = $1 AND project_id = $2 AND page_url_norm = $3 AND viewport = $4`,
    [
      input.userId,
      input.projectId,
      norm,
      input.viewport,
      JSON.stringify(input.selection),
    ]
  );
}

function hydrateRow(row: PageAnalysisRow): PageAnalysisRow {
  const payload =
    typeof row.payload === "string" ? (JSON.parse(row.payload) as PageNode) : row.payload;
  const selection =
    row.selection == null
      ? null
      : typeof row.selection === "string"
        ? (JSON.parse(row.selection) as Record<string, boolean>)
        : row.selection;
  return { ...row, payload, selection };
}
