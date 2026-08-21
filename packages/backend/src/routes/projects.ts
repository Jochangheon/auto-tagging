import { Router } from "express";
import { normalizePageUrl, type ViewportMode } from "@autotag/shared";
import { getRequestUserId } from "../auth/middleware.js";
import { ensureMigrated } from "../db/pool.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  saveProjectSettings,
  saveProjectState,
  touchProjectOpened,
  type ProjectWizardState,
  type ProjectOptions,
} from "../db/projects.js";
import { hydrateSessionFromCache } from "../db/persist-page.js";
import { createAnalysisSession, setSessionTaxonomy } from "../crawl/job-store.js";

export const projectsRouter = Router();

function requireUserId(req: Parameters<typeof getRequestUserId>[0]): string {
  const userId = getRequestUserId(req);
  if (!userId) throw new Error("authentication_required");
  return userId;
}

function cleanState(input: unknown): ProjectWizardState {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    step: Math.max(1, Math.min(5, Number(raw.step) || 1)),
    urls: Array.isArray(raw.urls) ? raw.urls.slice(0, 500) : [],
    jobs: Array.isArray(raw.jobs) ? raw.jobs.slice(0, 1000) : [],
    cover_url: typeof raw.cover_url === "string" && raw.cover_url.trim() ? raw.cover_url.trim() : null,
    savedAt: new Date().toISOString(),
  };
}

function coverUrlFromJobs(jobs: Array<Record<string, unknown>>): string | null {
  for (const job of jobs) {
    if (job.status !== "done") continue;
    if (typeof job.capture_url === "string" && job.capture_url.trim()) {
      return job.capture_url.trim();
    }
    if (typeof job.job_id === "string" && job.job_id.trim()) {
      const vp = job.viewport === "mo" ? "mo" : "pc";
      return `/api/dev/captures/${job.job_id.trim()}/${vp}.png`;
    }
  }
  return null;
}

function parseViewports(input: unknown): Array<"pc" | "mo"> {
  const raw = Array.isArray(input) ? input : [];
  const viewports = raw.filter((v): v is "pc" | "mo" => v === "pc" || v === "mo");
  return viewports.length ? [...new Set(viewports)] : ["pc"];
}

function projectSummary(row: Awaited<ReturnType<typeof listProjects>>[number]) {
  const state = cleanState(row.wizard_state);
  const jobs = (state.jobs || []) as Array<Record<string, unknown>>;
  const urls = (state.urls || []) as Array<Record<string, unknown>>;
  const inputCount = urls.reduce((total, entry) => {
    const viewports = Array.isArray(entry.viewports) ? entry.viewports.length : 1;
    return total + Math.max(1, viewports);
  }, 0);
  return {
    id: row.id,
    name: row.name,
    page_count: jobs.length || inputCount,
    analyzed_count: jobs.filter((j) => j.status === "done").length,
    cover_url: state.cover_url || coverUrlFromJobs(jobs),
    current_step: state.step || 1,
    updated_at: row.updated_at,
    last_opened_at: row.last_opened_at,
  };
}

function projectDetail(row: Awaited<ReturnType<typeof getProject>>) {
  if (!row) return null;
  return {
    ...projectSummary(row),
    description: row.description || "",
    options: row.options,
  };
}

projectsRouter.get("/", async (req, res) => {
  try {
    await ensureMigrated();
    const rows = await listProjects(requireUserId(req));
    return res.json({ ok: true, projects: rows.map(projectSummary) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(message === "authentication_required" ? 401 : 500).json({
      ok: false,
      error: message,
    });
  }
});

projectsRouter.post("/", async (req, res) => {
  try {
    await ensureMigrated();
    const rawName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const name =
      rawName || `새 프로젝트 ${new Date().toLocaleDateString("ko-KR")}`;
    const project = await createProject(requireUserId(req), name.slice(0, 120));
    return res.status(201).json({ ok: true, project: projectDetail(project) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(message === "authentication_required" ? 401 : 500).json({
      ok: false,
      error: message,
    });
  }
});

projectsRouter.get("/:id", async (req, res) => {
  try {
    await ensureMigrated();
    const userId = requireUserId(req);
    const project = await getProject(userId, req.params.id);
    if (!project) {
      return res.status(404).json({ ok: false, error: "project_not_found" });
    }

    const state = cleanState(project.wizard_state);
    const session = createAnalysisSession(userId, project.id);
    const jobs = (state.jobs || []) as Array<Record<string, unknown>>;
    const requests = jobs
      .map((job) => ({
        url: typeof job.url === "string" ? job.url : "",
        alias: typeof job.alias === "string" ? job.alias : undefined,
        viewport: (job.viewport === "mo" ? "mo" : "pc") as ViewportMode,
      }))
      .filter((job) => job.url);

    const { hits } = await hydrateSessionFromCache(
      session.session_id,
      userId,
      project.id,
      requests
    );
    if (project.taxonomy) {
      // Do not regenerate action crops here — sharp over every row blocked project open.
      setSessionTaxonomy(session.session_id, project.taxonomy);
    }
    const hitKeys = new Set(
      hits.map((hit) => `${normalizePageUrl(hit.url)}::${hit.viewport}`)
    );
    state.jobs = jobs.map((job) => {
      const url = typeof job.url === "string" ? job.url : "";
      const viewport = job.viewport === "mo" ? "mo" : "pc";
      const cached = url && hitKeys.has(`${normalizePageUrl(url)}::${viewport}`);
      return {
        ...job,
        status: cached ? "done" : "queued",
        progress: cached ? 100 : 0,
        error: null,
        fromCache: Boolean(cached),
      };
    });
    state.savedAt = new Date().toISOString();
    await touchProjectOpened(userId, project.id);

    return res.json({
      ok: true,
      project: projectDetail(project),
      state,
      session_id: session.session_id,
      cached_pages: hits.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[projects] open failed:", message);
    return res.status(message === "authentication_required" ? 401 : 500).json({
      ok: false,
      error: message,
    });
  }
});

projectsRouter.patch("/:id/settings", async (req, res) => {
  try {
    await ensureMigrated();
    const userId = requireUserId(req);
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      return res.status(400).json({ ok: false, error: "project_name_required" });
    }
    const rawOptions =
      req.body?.options && typeof req.body.options === "object"
        ? (req.body.options as Record<string, unknown>)
        : {};
    const options: ProjectOptions = {
      default_viewports: parseViewports(rawOptions.default_viewports),
      cache_mode: rawOptions.cache_mode === "force" ? "force" : "reuse",
    };
    const project = await saveProjectSettings({
      userId,
      projectId: req.params.id,
      name: name.slice(0, 120),
      description:
        typeof req.body?.description === "string"
          ? req.body.description.slice(0, 1000)
          : null,
      options,
    });
    if (!project) {
      return res.status(404).json({ ok: false, error: "project_not_found" });
    }
    return res.json({ ok: true, project: projectDetail(project) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(message === "authentication_required" ? 401 : 500).json({
      ok: false,
      error: message,
    });
  }
});

projectsRouter.put("/:id", async (req, res) => {
  try {
    await ensureMigrated();
    const userId = requireUserId(req);
    const state = cleanState(req.body?.state);
    const project = await saveProjectState({
      userId,
      projectId: req.params.id,
      name: typeof req.body?.name === "string" ? req.body.name : undefined,
      state,
    });
    if (!project) {
      return res.status(404).json({ ok: false, error: "project_not_found" });
    }
    return res.json({ ok: true, project: projectSummary(project), saved_at: state.savedAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(message === "authentication_required" ? 401 : 500).json({
      ok: false,
      error: message,
    });
  }
});

projectsRouter.delete("/:id", async (req, res) => {
  try {
    await ensureMigrated();
    const deleted = await deleteProject(requireUserId(req), req.params.id);
    if (!deleted) {
      return res.status(404).json({ ok: false, error: "project_not_found" });
    }
    return res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(message === "authentication_required" ? 401 : 500).json({
      ok: false,
      error: message,
    });
  }
});
