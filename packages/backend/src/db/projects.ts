import { query } from "./pool.js";
import type { TaxonomyViewModel } from "@autotag/shared";

export type ProjectWizardState = {
  step?: number;
  urls?: unknown[];
  jobs?: unknown[];
  cover_url?: string | null;
  savedAt?: string | null;
};

export type ProjectOptions = {
  default_viewports: Array<"pc" | "mo">;
  cache_mode: "reuse" | "force";
};

export type ProjectRow = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  options: ProjectOptions;
  wizard_state: ProjectWizardState;
  taxonomy: TaxonomyViewModel | null;
  taxonomy_confirmed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_opened_at: Date | string;
};

function hydrate(row: ProjectRow): ProjectRow {
  const rawOptions =
    typeof row.options === "string"
      ? (JSON.parse(row.options) as Partial<ProjectOptions>)
      : row.options || {};
  const viewports = Array.isArray(rawOptions.default_viewports)
    ? rawOptions.default_viewports.filter((v): v is "pc" | "mo" => v === "pc" || v === "mo")
    : [];
  return {
    ...row,
    wizard_state:
      typeof row.wizard_state === "string"
        ? (JSON.parse(row.wizard_state) as ProjectWizardState)
        : row.wizard_state || {},
    taxonomy:
      row.taxonomy == null
        ? null
        : typeof row.taxonomy === "string"
          ? (JSON.parse(row.taxonomy) as TaxonomyViewModel)
          : row.taxonomy,
    options: {
      default_viewports: viewports.length ? viewports : ["pc"],
      cache_mode: rawOptions.cache_mode === "force" ? "force" : "reuse",
    },
  };
}

export async function listProjects(userId: string): Promise<ProjectRow[]> {
  const { rows } = await query<ProjectRow>(
    `SELECT * FROM projects
     WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [userId]
  );
  return rows.map(hydrate);
}

export async function getProject(
  userId: string,
  projectId: string
): Promise<ProjectRow | null> {
  const { rows } = await query<ProjectRow>(
    `SELECT * FROM projects WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [projectId, userId]
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function createProject(
  userId: string,
  name: string
): Promise<ProjectRow> {
  const initial: ProjectWizardState = {
    step: 1,
    urls: [],
    jobs: [],
    savedAt: new Date().toISOString(),
  };
  const { rows } = await query<ProjectRow>(
    `INSERT INTO projects (user_id, name, wizard_state)
     VALUES ($1, $2, $3::jsonb)
     RETURNING *`,
    [userId, name.trim(), JSON.stringify(initial)]
  );
  return hydrate(rows[0]);
}

export async function saveProjectState(input: {
  userId: string;
  projectId: string;
  name?: string;
  state: ProjectWizardState;
}): Promise<ProjectRow | null> {
  const { rows } = await query<ProjectRow>(
    `UPDATE projects SET
       name = COALESCE(NULLIF($3, ''), name),
       wizard_state = $4::jsonb,
       updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [
      input.projectId,
      input.userId,
      input.name?.trim() || null,
      JSON.stringify(input.state),
    ]
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function saveProjectSettings(input: {
  userId: string;
  projectId: string;
  name: string;
  description?: string | null;
  options: ProjectOptions;
}): Promise<ProjectRow | null> {
  const { rows } = await query<ProjectRow>(
    `UPDATE projects SET
       name = $3,
       description = $4,
       options = $5::jsonb,
       updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [
      input.projectId,
      input.userId,
      input.name.trim(),
      input.description?.trim() || null,
      JSON.stringify(input.options),
    ]
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function touchProjectOpened(
  userId: string,
  projectId: string
): Promise<void> {
  await query(
    `UPDATE projects SET last_opened_at = now()
     WHERE id = $1 AND user_id = $2`,
    [projectId, userId]
  );
}

/**
 * Delete a project and cascade-related DB rows (page_analyses via FK).
 * Also removes on-disk capture folders referenced by that project's pages,
 * and clears in-memory analysis sessions for the project.
 */
export async function deleteProject(
  userId: string,
  projectId: string
): Promise<boolean> {
  const { listPageAnalysesForProject } = await import("./page-analyses.js");
  const { clearSessionsForProject } = await import("../crawl/job-store.js");
  const { captureDir } = await import("../crawl/page-capture.js");
  const { rm } = await import("node:fs/promises");
  const path = await import("node:path");

  const pages = await listPageAnalysesForProject(userId, projectId);
  const jobIds = new Set<string>();
  for (const row of pages) {
    const jobId = row.payload?.job_id?.trim();
    if (jobId) jobIds.add(jobId);
    const captureUrl = row.payload?.capture_url || "";
    const m = /\/captures\/([^/]+)\//.exec(captureUrl);
    if (m?.[1]) jobIds.add(m[1]);
  }

  const result = await query(
    `DELETE FROM projects WHERE id = $1 AND user_id = $2`,
    [projectId, userId]
  );
  const deleted = (result.rowCount ?? 0) > 0;
  if (!deleted) return false;

  // page_analyses rows for this project_id are removed by ON DELETE CASCADE.
  const cleared = clearSessionsForProject(projectId);
  if (cleared > 0) {
    console.log(`[db] cleared ${cleared} in-memory session(s) for project=${projectId.slice(0, 8)}`);
  }

  const root = captureDir();
  for (const jobId of jobIds) {
    if (!jobId || jobId.includes("..") || jobId.includes("/") || jobId.includes("\\")) continue;
    const dir = path.join(root, jobId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `[db] capture cleanup skipped job=${jobId.slice(0, 8)}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  if (jobIds.size) {
    console.log(
      `[db] project delete cleaned captures=${jobIds.size} project=${projectId.slice(0, 8)}`
    );
  }

  return true;
}

export async function saveProjectTaxonomy(input: {
  userId: string;
  projectId: string;
  taxonomy: TaxonomyViewModel;
}): Promise<boolean> {
  const result = await query(
    `UPDATE projects SET
       taxonomy = $3::jsonb,
       taxonomy_confirmed_at = COALESCE($4::timestamptz, now()),
       updated_at = now()
     WHERE id = $1 AND user_id = $2`,
    [
      input.projectId,
      input.userId,
      JSON.stringify(input.taxonomy),
      input.taxonomy.confirmed_at ?? null,
    ]
  );
  return (result.rowCount ?? 0) > 0;
}
