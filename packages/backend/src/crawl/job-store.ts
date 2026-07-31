import { randomUUID } from "node:crypto";

import type {

  CrawlJobProgress,

  JobFailureReason,

  JobStatus,

  RecommendedTagCandidate,

  CandidateGroup,
  CandidateTree,
  PageNode,
  SessionResult,

  ViewportMode,

} from "@autotag/shared";

import { normalizePageUrl } from "@autotag/shared";
import { mergeSelection } from "@autotag/shared";

import type { LlmProvider, ExtractLlmBatchMeta } from "../llm/types.js";

import type { LiveTagEntry } from "./tag-live-dom.js";



export type JobStage =

  | "crawling"

  | "collecting"

  | "tagging"

  | "naming"

  | "grouping"

  | "waiting_mo"

  | "done"

  | "failed";



export const STAGE_LABELS: Record<JobStage, string> = {

  crawling: "페이지 여는 중",

  collecting: "클릭 가능 요소 수집 중",

  tagging: "요소에 태그 ID 부여 중",

  naming: "AI가 버튼 이름 짓는 중",

  grouping: "비슷한 버튼 묶는 중",

  waiting_mo: "모바일 뷰포트 대기 중 (90초)",

  done: "완료",

  failed: "실패",

};



export interface JobProgress {

  current: number;

  total: number;

}



const STAGE_RANGES: Record<JobStage, [number, number]> = {

  crawling: [0, 15],

  collecting: [15, 40],

  tagging: [40, 55],

  naming: [55, 90],

  grouping: [90, 100],

  waiting_mo: [95, 95],

  done: [100, 100],

  failed: [0, 0],

};



export function computePercent(stage: JobStage, progress: JobProgress): number {

  if (stage === "done") return 100;

  const [start, end] = STAGE_RANGES[stage];

  if (stage === "failed") return start;

  if (progress.total <= 0) return start;

  const ratio = Math.min(1, Math.max(0, progress.current / progress.total));

  return Math.round(start + ratio * (end - start));

}



export interface StoredJob {

  job_id: string;

  source_url: string;

  status: JobStatus;

  stage: JobStage;

  stage_label: string;

  progress: JobProgress;

  percent: number;

  step?: string;

  progress_pct?: number;

  error_message?: string | null;

  failure_reason?: JobFailureReason | null;

  created_at: string;

  updated_at: string;

  scrape_id?: string;

  live_view_url?: string | null;

  cdp_url?: string | null;

  html?: string;

  html_length?: number;

  live_entries?: LiveTagEntry[];

  candidates: RecommendedTagCandidate[];

  groups: CandidateGroup[];

  candidate_tree?: CandidateTree;

  llm_source?: LlmProvider;

  extract_meta?: ExtractLlmBatchMeta;

  gnb_hover_opened?: string[];
  viewport?: ViewportMode;
  capture_url?: string | null;
  capture_width?: number | null;
  capture_height?: number | null;
  capture_qc?: import("./capture-verify.js").CaptureQcReport | null;
  /** Canonical element geometry — same as positions.json on disk. */
  element_positions?: import("./positions-file.js").PositionsFile | null;
  /** User alias from URL list (e.g. "메인") — overrides LLM page_category. */
  page_alias?: string | null;
}



const jobs = new Map<string, StoredJob>();



export function createJob(sourceUrl: string): StoredJob {

  const now = new Date().toISOString();

  const stage: JobStage = "crawling";

  const progress: JobProgress = { current: 0, total: 1 };

  const job: StoredJob = {

    job_id: randomUUID(),

    source_url: sourceUrl,

    status: "queued",

    stage,

    stage_label: STAGE_LABELS[stage],

    progress,

    percent: computePercent(stage, progress),

    step: "queued",

    progress_pct: 0,

    created_at: now,

    updated_at: now,

    candidates: [],

    groups: [],

  };

  jobs.set(job.job_id, job);

  return job;

}



export function getJob(jobId: string): StoredJob | undefined {

  return jobs.get(jobId);

}



export function updateJob(jobId: string, patch: Partial<StoredJob>): StoredJob | undefined {

  const job = jobs.get(jobId);

  if (!job) return undefined;

  const updated: StoredJob = {

    ...job,

    ...patch,

    updated_at: new Date().toISOString(),

  };

  jobs.set(jobId, updated);

  return updated;

}



export type JobProgressPatch = Partial<

  Pick<StoredJob, "stage" | "progress" | "status" | "step" | "progress_pct">

>;



export function updateJobProgress(jobId: string, partial: JobProgressPatch): StoredJob | undefined {

  const job = jobs.get(jobId);

  if (!job) return undefined;



  const stage = partial.stage ?? job.stage;

  const progress = partial.progress ?? job.progress;

  const stage_label = STAGE_LABELS[stage];

  const percent =

    stage === "failed" ? job.percent : computePercent(stage, progress);

  const progress_pct = stage === "done" ? 100 : percent;



  return updateJob(jobId, {

    ...partial,

    stage,

    stage_label,

    progress,

    percent,

    progress_pct,

  });

}



export function toJobProgress(job: StoredJob): CrawlJobProgress {

  return {

    job_id: job.job_id,

    status: job.status,

    source_url: job.source_url,

    step: job.step,

    progress_pct: job.progress_pct ?? job.percent,

    error_message: job.error_message ?? null,

    failure_reason: job.failure_reason ?? null,

    created_at: job.created_at,

    updated_at: job.updated_at,

  };

}



export function clearJobs(): void {

  jobs.clear();

}



export interface AnalysisSession extends SessionResult {
  created_at: string;
  /** PostgreSQL user id that owns this session's persisted pages. */
  owner_user_id?: string | null;
  /** DB project that owns every page/selection/taxonomy in this session. */
  project_id?: string | null;
}

export function initSessionSelection(session: AnalysisSession): void {
  if (!session.selection) session.selection = {};
  for (const page of session.pages) {
    session.selection = mergeSelection(session.selection, page.page_url, page.candidates ?? []);
  }
}

export function updateSessionSelection(
  sessionId: string,
  selection: Record<string, boolean>
): AnalysisSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  session.selection = { ...session.selection, ...selection };
  session.updated_at = new Date().toISOString();
  return session;
}

export function setSessionTaxonomy(
  sessionId: string,
  taxonomy: import("@autotag/shared").TaxonomyViewModel
): AnalysisSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  session.taxonomy = taxonomy;
  session.taxonomy_confirmed_at = taxonomy.confirmed_at;
  session.updated_at = new Date().toISOString();
  return session;
}

const sessions = new Map<string, AnalysisSession>();

export function createAnalysisSession(
  ownerUserId?: string | null,
  projectId?: string | null
): AnalysisSession {
  const now = new Date().toISOString();
  const session: AnalysisSession = {
    session_id: randomUUID(),
    pages: [],
    active_page_url: null,
    created_at: now,
    updated_at: now,
    owner_user_id: ownerUserId ?? null,
    project_id: projectId ?? null,
  };
  sessions.set(session.session_id, session);
  return session;
}

export function setSessionOwnerUserId(
  sessionId: string,
  userId: string | null
): AnalysisSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  session.owner_user_id = userId;
  session.updated_at = new Date().toISOString();
  return session;
}

export function getAnalysisSession(sessionId: string): AnalysisSession | undefined {
  return sessions.get(sessionId);
}

export function resolveAnalysisSession(
  sessionId?: string | null,
  ownerUserId?: string | null,
  projectId?: string | null
): AnalysisSession {
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      if (ownerUserId && !existing.owner_user_id) {
        existing.owner_user_id = ownerUserId;
      }
      if (projectId && existing.project_id && existing.project_id !== projectId) {
        throw new Error("project_session_mismatch");
      }
      if (projectId && !existing.project_id) existing.project_id = projectId;
      return existing;
    }
  }
  return createAnalysisSession(ownerUserId, projectId);
}

function sessionPageKey(page: PageNode): string {
  const vp = page.active_viewport ?? "pc";
  return `${normalizePageUrl(page.page_url)}::${vp}`;
}

export function upsertSessionPage(
  sessionId: string,
  page: PageNode
): { session: AnalysisSession; added: boolean; updated: boolean } {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error("session_not_found");
  }

  const normUrl = normalizePageUrl(page.page_url);
  const normalized: PageNode = { ...page, page_url: normUrl };
  const key = sessionPageKey(normalized);
  const idx = session.pages.findIndex((p) => sessionPageKey(p) === key);
  const now = new Date().toISOString();
  session.updated_at = now;
  session.active_page_url = normUrl;

  if (idx >= 0) {
    session.pages[idx] = normalized;
    initSessionSelection(session);
    console.log(
      `[session] id=${sessionId.slice(0, 8)} pages=${session.pages.length} updated=${normUrl}`
    );
    return { session, added: false, updated: true };
  }

  session.pages.push(normalized);
  initSessionSelection(session);
  console.log(
    `[session] id=${sessionId.slice(0, 8)} pages=${session.pages.length} added=${normUrl}`
  );
  return { session, added: true, updated: false };
}

export function getSessionResult(sessionId: string): SessionResult | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  return {
    session_id: session.session_id,
    pages: session.pages,
    active_page_url: session.active_page_url,
    updated_at: session.updated_at,
    selection: session.selection,
    taxonomy: session.taxonomy ?? null,
    taxonomy_confirmed_at: session.taxonomy_confirmed_at ?? null,
    project_id: session.project_id ?? null,
  };
}

export function clearAnalysisSessions(): void {
  sessions.clear();
}

/** Drop in-memory analysis sessions bound to a project (after project delete). */
export function clearSessionsForProject(projectId: string): number {
  if (!projectId) return 0;
  let removed = 0;
  for (const [id, session] of sessions) {
    if (session.project_id === projectId) {
      sessions.delete(id);
      removed += 1;
    }
  }
  return removed;
}

