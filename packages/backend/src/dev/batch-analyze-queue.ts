import { randomUUID } from "node:crypto";
import type { ViewportMode } from "@autotag/shared";
import { resolveCdpDeviceMetrics } from "@autotag/shared";
import {
  getAnalysisSession,
  getJob,
  updateJob,
  updateJobProgress,
  upsertSessionPage,
} from "../crawl/job-store.js";
import {
  stopInteraction,
  bootstrapSession,
  waitForPageReady,
  setViewport,
  setViewportAndReload,
  type FirecrawlSession,
} from "../crawl/firecrawl-interact.js";
import { unregisterOpenScrapeId, cleanupRegisteredSessions } from "../crawl/firecrawl-session-registry.js";
import {
  startDevAnalyzeJob,
  stopOrchestratorSession,
  collectWithFirecrawl,
  collectWithSessionReuse,
  nameWithLlm,
  captureFromArtifacts,
  releaseFirecrawlSession,
  type CollectArtifacts,
} from "../crawl/job-orchestrator.js";
import { buildPageNodeFromJob, derivePageNameFromHtml } from "../crawl/session-page.js";
import { cancelJob, clearJobCancel } from "../crawl/pipeline-cancel.js";
import { disconnectCdp, setCdpViewport, applyCdpLiveViewViewport } from "../crawl/cdp-session.js";
import {
  isLoginRequiredError,
  assertAnalysisUrl,
  assertAnalysisUrlResilient,
  classifyAnalyzeFailure,
  isMemberAreaUrl,
  parseLoginRequiredError,
  formatLoginRequiredMessage,
  type AnalyzeFailureKind,
} from "../crawl/analysis-url-guard.js";
import { injectAuthCookiesForUrl } from "../crawl/inject-auth-cookies.js";
import { withAcquiredFirecrawlKey, releaseFirecrawlKey } from "../crawl/firecrawl-key-pool.js";

export type BatchItemStatus =
  | "queued"
  | "collecting"
  | "naming"
  | "running"
  | "done"
  | "error"
  | "login_required";

export interface BatchAnalyzeItem {
  url: string;
  alias?: string;
  viewport?: ViewportMode;
  status: BatchItemStatus;
  job_id?: string;
  error?: string;
  /** login_required | session_dead | timeout | cancelled | other */
  error_kind?: AnalyzeFailureKind;
  /** When login redirect: the URL Firecrawl actually landed on */
  error_current_url?: string;
  candidate_count?: number;
  progress_pct?: number;
  /** Phase 2 element capture — reported while job.step === element_capture */
  capture_phase?: "idle" | "running" | "done";
  capture_pct?: number;
  capture_current?: number;
  capture_total?: number;
}

export interface BatchAnalyzeState {
  batch_id: string;
  session_id: string;
  status: "running" | "done";
  concurrency: number;
  done_count: number;
  total: number;
  items: BatchAnalyzeItem[];
  started_at: string;
  finished_at?: string;
  /** Set once the batch has been stopped by the user. */
  cancelled?: boolean;
}

export interface BatchItemDoneContext {
  sessionId: string;
  jobId: string;
  url: string;
  viewport: ViewportMode;
}

/** @deprecated Preview uses static captures — sessions are released after each job. */
export interface BatchHeldLiveSession {
  session: never;
  jobId: string;
  url: string;
  viewport: ViewportMode;
}

export interface BatchAnalyzeHooks {
  onItemDone?: (ctx: BatchItemDoneContext) => void | Promise<void>;
  onBatchComplete?: (batch: BatchAnalyzeState) => void | Promise<void>;
}

const batches = new Map<string, BatchAnalyzeState>();

/**
 * Phase 2 capture waiters per batch. Cancelled batches do not block new
 * pipelines (their CDP sessions are force-closed on stop).
 */
const pendingCapturesByBatch = new Map<string, number>();

function firecrawlQueueConcurrency(): number {
  const raw = Number(process.env.FIRECRAWL_QUEUE_CONCURRENCY ?? process.env.BATCH_ANALYZE_CONCURRENCY ?? "2");
  const n = Number.isFinite(raw) ? Math.floor(raw) : 2;
  return Math.min(2, Math.max(1, n));
}

function llmQueueConcurrency(): number {
  const raw = Number(process.env.LLM_QUEUE_CONCURRENCY ?? "4");
  const n = Number.isFinite(raw) ? Math.floor(raw) : 4;
  return Math.min(8, Math.max(1, n));
}

function captureQueueConcurrency(): number {
  const raw = Number(process.env.CAPTURE_QUEUE_CONCURRENCY ?? "3");
  const n = Number.isFinite(raw) ? Math.floor(raw) : 3;
  return Math.min(6, Math.max(1, n));
}

/** Hard cap so a dead Firecrawl session can't block the queue forever. */
function itemPhase1TimeoutMs(): number {
  const raw = Number(process.env.BATCH_ITEM_TIMEOUT_MS ?? String(5 * 60 * 1000));
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 5 * 60 * 1000;
}

/** If a running job stops updating for this long, cancel it (stuck CDP / remote). */
function itemStallMs(): number {
  const raw = Number(process.env.BATCH_ITEM_STALL_MS ?? String(90_000));
  return Number.isFinite(raw) && raw >= 30_000 ? Math.floor(raw) : 90_000;
}

/** page_capture does viewport reload + lazy scroll + tall screenshot — needs more idle room. */
function itemStallMsForStep(step: string | undefined): number {
  if (step === "page_capture" || step === "element_capture") {
    const raw = Number(process.env.BATCH_CAPTURE_STALL_MS ?? String(180_000));
    return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 180_000;
  }
  return itemStallMs();
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Cancel a job if job.updated_at goes stale while still awaiting Phase 1. */
function watchJobStall(
  jobId: string,
  label: string,
  getScrapeId: () => string | null
): () => void {
  const started = Date.now();
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    const job = getJob(jobId);
    if (!job) return;
    const updated = Date.parse(job.updated_at || "") || started;
    const idleMs = Date.now() - updated;
    const stallLimit = itemStallMsForStep(job.step);
    if (idleMs < stallLimit) return;
    fired = true;
    console.warn(
      `[batch] stall cancel job=${jobId.slice(0, 8)} ${label} idle=${Math.round(idleMs / 1000)}s step=${job.step} limit=${Math.round(stallLimit / 1000)}s`
    );
    cancelJob(jobId);
    const scrapeId = getScrapeId() ?? job.scrape_id;
    if (scrapeId) {
      void releaseScrapeSession(scrapeId).catch(() => {});
    }
  }, 15_000);
  return () => clearInterval(timer);
}

function incPendingCapture(batchId: string): void {
  pendingCapturesByBatch.set(batchId, (pendingCapturesByBatch.get(batchId) ?? 0) + 1);
}

function decPendingCapture(batchId: string): void {
  const n = (pendingCapturesByBatch.get(batchId) ?? 0) - 1;
  if (n <= 0) pendingCapturesByBatch.delete(batchId);
  else pendingCapturesByBatch.set(batchId, n);
}

function syncJobToSession(
  sessionId: string,
  jobId: string,
  url: string,
  viewport: ViewportMode,
  alias?: string
): void {
  const job = getJob(jobId);
  if (!job) return;
  const baseName = job.html ? derivePageNameFromHtml(job.html, url) : undefined;
  const vpLabel = viewport === "mo" ? "MO" : "PC";
  const effectiveAlias = alias?.trim() || job.page_alias?.trim();
  const pageName = effectiveAlias
    ? `${effectiveAlias} · ${vpLabel}`
    : baseName
      ? `${baseName} · ${vpLabel}`
      : undefined;
  const pageNode = buildPageNodeFromJob(job, { pageName, viewport });
  upsertSessionPage(sessionId, pageNode);

  const session = getAnalysisSession(sessionId);
  const userId = session?.owner_user_id;
  const projectId = session?.project_id;
  if (userId && projectId) {
    void import("../db/persist-page.js")
      .then(({ persistPageForUser }) =>
        persistPageForUser(userId, projectId, pageNode, session?.selection ?? null)
      )
      .catch((err) =>
        console.warn("[batch] persist page:", err instanceof Error ? err.message : err)
      );
  }
}

async function releaseScrapeSession(scrapeId: string | null | undefined): Promise<void> {
  if (!scrapeId) return;
  try {
    await stopOrchestratorSession(scrapeId);
  } catch {
    try {
      await stopInteraction(scrapeId);
    } catch {
      /* ignore */
    }
  }
  unregisterOpenScrapeId(scrapeId);
}

function enrichItemProgress(item: BatchAnalyzeItem): void {
  if (
    !item.job_id ||
    item.status === "error" ||
    item.status === "login_required" ||
    item.status === "queued"
  ) {
    return;
  }
  const job = getJob(item.job_id);
  if (!job) return;
  if (!item.alias?.trim() && job.page_alias?.trim()) {
    item.alias = job.page_alias.trim();
  }
  item.progress_pct = job.progress_pct ?? job.percent;
  if (item.status === "done" && job.candidates) {
    item.candidate_count = job.candidates.length;
  }

  if (
    (item.status === "done" || item.status === "naming") &&
    job.step === "element_capture"
  ) {
    const cur = job.progress?.current ?? 0;
    const total = Math.max(job.progress?.total ?? 1, 1);
    item.capture_phase = "running";
    item.capture_current = cur;
    item.capture_total = total;
    item.capture_pct = Math.min(100, Math.round((cur / total) * 100));
    return;
  }

  if (item.status === "done") {
    const pending = (job.candidates ?? []).some(
      (c) => c.tag_id > 0 && (c.capture_status === "pending" || c.capture_status === "capturing")
    );
    item.capture_phase = pending ? "running" : "done";
    if (pending) {
      const total = (job.candidates ?? []).filter((c) => c.tag_id > 0).length;
      const done = (job.candidates ?? []).filter(
        (c) => c.tag_id > 0 && c.capture_status === "done"
      ).length;
      item.capture_current = done;
      item.capture_total = total;
      item.capture_pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    } else {
      item.capture_pct = 100;
    }
  }
}

export function isCapturePhasePending(): boolean {
  for (const [batchId, n] of pendingCapturesByBatch) {
    if (n <= 0) continue;
    const batch = batches.get(batchId);
    if (batch && !batch.cancelled) return true;
  }
  return false;
}

export function getBatchAnalyze(batchId: string): BatchAnalyzeState | undefined {
  const batch = batches.get(batchId);
  if (!batch) return undefined;
  for (const item of batch.items) enrichItemProgress(item);
  return batch;
}

/**
 * Non-serializable per-batch control state (cancel flag + in-flight scrape ids).
 * Kept out of BatchAnalyzeState so the progress JSON stays clean.
 */
interface BatchControl {
  cancelled: boolean;
  activeScrapeIds: Set<string>;
}
const batchControls = new Map<string, BatchControl>();

function settleCancelledItems(batch: BatchAnalyzeState): void {
  for (const item of batch.items) {
    if (
      item.status === "queued" ||
      item.status === "running" ||
      item.status === "collecting" ||
      item.status === "naming"
    ) {
      item.status = "error";
      item.error = "중단됨";
      batch.done_count += 1;
    }
  }
  if (batch.done_count > batch.total) batch.done_count = batch.total;
  batch.status = "done";
  batch.finished_at = new Date().toISOString();
}

/**
 * Stop a running batch. Returns immediately — heavy teardown runs in background.
 * Cancels FC / LLM / capture jobs so the analyze lock clears.
 */
export function stopBatchAnalyze(batchId: string): boolean {
  const batch = batches.get(batchId);
  const control = batchControls.get(batchId);
  if (!batch) return false;

  if (control) control.cancelled = true;
  batch.cancelled = true;

  for (const item of batch.items) {
    if (item.job_id) cancelJob(item.job_id);
  }

  settleCancelledItems(batch);
  pendingCapturesByBatch.delete(batchId);

  const ids = control ? [...control.activeScrapeIds] : [];
  if (control) control.activeScrapeIds.clear();
  void Promise.all(ids.map((id) => releaseScrapeSession(id))).catch(() => {});

  console.log(
    `[batch] stopped id=${batchId.slice(0, 8)} items=${batch.total} ` +
      `pending_captures=${pendingCapturesByBatch.get(batchId) ?? 0}`
  );
  return true;
}

/** Hard-clear all analyze locks (stuck pipeline_already_running recovery). */
export function forceResetPipelines(): {
  stopped_batches: number;
  released_sessions: number;
} {
  let stopped = 0;
  const scrapeIds = new Set<string>();
  for (const [batchId, batch] of batches) {
    if (batch.status === "running" || !batch.cancelled) {
      batch.cancelled = true;
      for (const item of batch.items) {
        if (item.job_id) cancelJob(item.job_id);
      }
      settleCancelledItems(batch);
      stopped += 1;
    }
    const control = batchControls.get(batchId);
    if (control) {
      control.cancelled = true;
      for (const id of control.activeScrapeIds) scrapeIds.add(id);
      control.activeScrapeIds.clear();
    }
  }
  pendingCapturesByBatch.clear();
  void disconnectCdp().catch(() => {});
  void Promise.all([...scrapeIds].map((id) => releaseScrapeSession(id)))
    .then(() => cleanupRegisteredSessions().catch(() => {}))
    .catch(() => {});
  console.log(`[batch] forceReset stopped=${stopped} sessions=${scrapeIds.size}`);
  return { stopped_batches: stopped, released_sessions: scrapeIds.size };
}

export function isBatchAnalyzeRunning(): boolean {
  for (const b of batches.values()) {
    if (b.status === "running" && !b.cancelled) return true;
  }
  return false;
}

/** True when any non-cancelled batch still has Phase 2 element capture pending. */
export function isBatchCapturePending(): boolean {
  return isCapturePhasePending();
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]!);
    }
  }
  const workers = Math.min(concurrency, Math.max(items.length, 1));
  if (items.length === 0) return;
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

/** Async work queue with fixed concurrency — used for LLM / Capture pools. */
class WorkerQueue<T> {
  private readonly q: T[] = [];
  private active = 0;
  private closed = false;
  private drainWaiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly handler: (item: T) => Promise<void>
  ) {}

  enqueue(item: T): void {
    if (this.closed) return;
    this.q.push(item);
    this.pump();
  }

  close(): void {
    this.closed = true;
    this.checkDrain();
  }

  async drain(): Promise<void> {
    if (this.q.length === 0 && this.active === 0) return;
    await new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
      this.checkDrain();
    });
  }

  private checkDrain(): void {
    if (this.q.length === 0 && this.active === 0) {
      const waiters = this.drainWaiters.splice(0);
      for (const w of waiters) w();
    }
  }

  private pump(): void {
    while (this.active < this.concurrency && this.q.length > 0) {
      const item = this.q.shift()!;
      this.active += 1;
      void this.handler(item)
        .catch((err) => {
          console.warn(
            `[batch] worker error:`,
            err instanceof Error ? err.message : err
          );
        })
        .finally(() => {
          this.active -= 1;
          this.checkDrain();
          this.pump();
        });
    }
  }
}

/**
 * Firecrawl kills a browser session when the plan's concurrent-session limit is
 * hit (e.g. PC + MO of the same URL running together). Those failures — plus
 * generic timeouts — are transient and safe to retry with a fresh session.
 */
function isTransientAnalyzeError(message: string | undefined): boolean {
  const m = (message ?? "").toLowerCase();
  return (
    m.includes("has been closed") ||
    m.includes("target page") ||
    m.includes("execution timed out") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("concurrent") ||
    m.includes("concurrencylimited") ||
    m.includes("page.content()") ||
    m.includes("browser session") ||
    m.includes("net::") ||
    m.includes("socket hang up") ||
    m.includes("econnreset") ||
    m.includes("timed out after") ||
    m.includes("navigate") ||
    m.includes("deno repl") ||
    m.includes("repl not ready") ||
    m.includes("repl exited") ||
    m.includes("failed to execute code in browser session")
  );
}

/**
 * Per-URL mutex: two viewports (PC/MO) of the SAME url must not hold Firecrawl
 * browser sessions at the same time, or one gets evicted mid-pipeline. Items
 * for different URLs still run in parallel up to the pool concurrency.
 */
const urlLocks = new Map<string, Promise<void>>();

async function withUrlLock<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const key = url.trim();
  const prev = urlLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate);
  urlLocks.set(key, chained);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (urlLocks.get(key) === chained) urlLocks.delete(key);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hostKey(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./i, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function groupItemsByHost(items: BatchAnalyzeItem[]): BatchAnalyzeItem[][] {
  const map = new Map<string, BatchAnalyzeItem[]>();
  for (const item of items) {
    const key = hostKey(item.url);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return [...map.values()];
}

interface PostCollectWork {
  item: BatchAnalyzeItem;
  jobId: string;
  url: string;
  viewport: ViewportMode;
  artifacts: CollectArtifacts;
}

export async function startBatchAnalyze(
  sessionId: string,
  urls: Array<{ url: string; alias?: string; viewport?: ViewportMode }>,
  defaultViewport: ViewportMode,
  hooks?: BatchAnalyzeHooks
): Promise<BatchAnalyzeState> {
  const batchId = randomUUID();
  const fcConcurrency = firecrawlQueueConcurrency();
  const llmConcurrency = llmQueueConcurrency();
  const captureConcurrency = captureQueueConcurrency();

  const batch: BatchAnalyzeState = {
    batch_id: batchId,
    session_id: sessionId,
    status: "running",
    concurrency: fcConcurrency,
    done_count: 0,
    total: urls.length,
    items: urls.map((u) => ({
      url: u.url,
      alias: u.alias,
      viewport: u.viewport ?? defaultViewport,
      status: "queued" as const,
    })),
    started_at: new Date().toISOString(),
  };
  batches.set(batchId, batch);

  const control: BatchControl = { cancelled: false, activeScrapeIds: new Set() };
  batchControls.set(batchId, control);

  console.log(
    `[batch] start id=${batchId.slice(0, 8)} total=${batch.total} ` +
      `fc=${fcConcurrency} llm=${llmConcurrency} capture=${captureConcurrency}`
  );

  const markBatchDoneIfComplete = () => {
    if (batch.cancelled) return;
    if (batch.done_count >= batch.total && batch.status !== "done") {
      batch.status = "done";
      batch.finished_at = new Date().toISOString();
    }
  };

  const markItemCancelled = (item: BatchAnalyzeItem): void => {
    if (
      item.status !== "queued" &&
      item.status !== "running" &&
      item.status !== "collecting" &&
      item.status !== "naming"
    ) {
      return;
    }
    item.status = "error";
    item.error = "중단됨";
    batch.done_count += 1;
    markBatchDoneIfComplete();
  };

  const markItemError = (item: BatchAnalyzeItem, message: string): void => {
    if (item.status === "done" || item.status === "error" || item.status === "login_required") {
      return;
    }
    // Login redirect must never look like a generic Firecrawl session death.
    if (isLoginRequiredError(message)) {
      markItemLoginRequired(item, message);
      return;
    }
    const classified = classifyAnalyzeFailure(message, item.url);
    if (classified.kind === "login_required") {
      markItemLoginRequired(item, message.startsWith("LOGIN_REQUIRED|") ? message : undefined);
      // Prefer the clearer classified label when we remapped member+REPL → login.
      if (!isLoginRequiredError(message)) {
        item.error = classified.label;
      }
      return;
    }
    item.status = "error";
    item.error_kind = classified.kind;
    item.error_current_url = undefined;
    item.error = classified.label;
    batch.done_count += 1;
    markBatchDoneIfComplete();
  };

  const markItemLoginRequired = (item: BatchAnalyzeItem, rawMessage?: string): void => {
    const parsed = parseLoginRequiredError(rawMessage);
    item.status = "login_required";
    item.error_kind = "login_required";
    item.error = parsed
      ? formatLoginRequiredMessage(parsed.expectedUrl, parsed.currentUrl)
      : "로그인 필요 · 회원 페이지에 접근하려면 로그인이 필요합니다";
    item.error_current_url = parsed?.currentUrl;
    batch.done_count += 1;
    markBatchDoneIfComplete();
  };

  const markItemDone = async (item: BatchAnalyzeItem, jobId: string, viewport: ViewportMode) => {
    const job = getJob(jobId);
    item.status = "done";
    item.error = undefined;
    item.candidate_count = job?.candidates?.length ?? 0;
    item.progress_pct = 100;
    batch.done_count += 1;
    markBatchDoneIfComplete();
    syncJobToSession(sessionId, jobId, item.url, viewport, item.alias);
    await hooks?.onItemDone?.({
      sessionId,
      jobId,
      url: item.url,
      viewport,
    });
  };

  const captureQueue = new WorkerQueue<PostCollectWork>(captureConcurrency, async (work) => {
    if (control.cancelled) {
      cancelJob(work.jobId);
      return;
    }
    incPendingCapture(batchId);
    let lastCaptureSig = -1;
    const captureSyncTimer = setInterval(() => {
      if (control.cancelled) return;
      const j = getJob(work.jobId);
      if (!j) return;
      const sig = (j.candidates ?? []).reduce(
        (n, c) => n + (c.capture_status === "done" || c.capture_status === "failed" ? 1 : 0),
        0
      );
      if (sig === lastCaptureSig) return;
      lastCaptureSig = sig;
      try {
        syncJobToSession(sessionId, work.jobId, work.url, work.viewport, work.item.alias);
      } catch {
        /* ignore */
      }
    }, 4000);
    try {
      await captureFromArtifacts(work.jobId, work.url, work.viewport, work.artifacts);
      if (!control.cancelled) {
        syncJobToSession(sessionId, work.jobId, work.url, work.viewport, work.item.alias);
      }
    } catch (err) {
      console.warn(
        `[batch] capture failed job=${work.jobId.slice(0, 8)}:`,
        err instanceof Error ? err.message : err
      );
    } finally {
      clearInterval(captureSyncTimer);
      decPendingCapture(batchId);
      clearJobCancel(work.jobId);
    }
  });

  const llmQueue = new WorkerQueue<PostCollectWork>(llmConcurrency, async (work) => {
    if (control.cancelled) {
      markItemCancelled(work.item);
      cancelJob(work.jobId);
      return;
    }
    work.item.status = "naming";
    try {
      await withTimeout(
        nameWithLlm(work.jobId, work.url, work.viewport, work.artifacts),
        itemPhase1TimeoutMs(),
        `llm ${work.url} (${work.viewport})`
      );
      if (control.cancelled) {
        markItemCancelled(work.item);
        cancelJob(work.jobId);
        return;
      }
      await markItemDone(work.item, work.jobId, work.viewport);
      // Capture can run once candidates exist (after naming).
      captureQueue.enqueue(work);
    } catch (e) {
      const lastError = e instanceof Error ? e.message : String(e);
      cancelJob(work.jobId);
      clearJobCancel(work.jobId);
      if (isLoginRequiredError(lastError)) {
        markItemLoginRequired(work.item, lastError);
        return;
      }
      if (
        control.cancelled ||
        lastError === "cancelled_by_user" ||
        lastError.includes("cancelled_by_user")
      ) {
        markItemCancelled(work.item);
        return;
      }
      markItemError(work.item, lastError);
    }
  });

  const MAX_ITEM_ATTEMPTS = 2;

  /**
   * Bootstrap (or reuse) a Firecrawl session and collect artifacts for one item.
   * Must run inside the host-group `withAcquiredFirecrawlKey` so the API key
   * stays bound for navigate reuse across URLs.
   */
  const collectOne = async (
    item: BatchAnalyzeItem,
    itemViewport: ViewportMode,
    reuseSession: FirecrawlSession | null
  ): Promise<{ artifacts: CollectArtifacts; session: FirecrawlSession }> => {
    if (control.cancelled) throw new Error("cancelled_by_user");

    const { job_id } = startDevAnalyzeJob(item.url);
    item.job_id = job_id;
    if (item.alias?.trim()) {
      updateJob(job_id, { page_alias: item.alias.trim() });
    }

    let scrapeId: string | null = null;
    const stopStallWatch = watchJobStall(
      job_id,
      `${item.url} (${itemViewport})`,
      () => scrapeId
    );

    try {
      const analysisSession = getAnalysisSession(sessionId);
      const authUserId = analysisSession?.owner_user_id ?? null;

      if (reuseSession) {
        try {
          const artifacts = await withTimeout(
            collectWithSessionReuse(job_id, reuseSession, item.url, itemViewport, {
              auth_owner_user_id: authUserId,
            }),
            itemPhase1TimeoutMs(),
            `collect-reuse ${item.url} (${itemViewport})`
          );
          scrapeId = reuseSession.scrapeId;
          if (scrapeId) control.activeScrapeIds.add(scrapeId);
          return { artifacts, session: reuseSession };
        } catch (navErr) {
          console.warn(
            `[batch] navigate_reuse failed url=${item.url} — falling back to bootstrap: ${
              navErr instanceof Error ? navErr.message : navErr
            }`
          );
          await releaseFirecrawlSession(reuseSession).catch(() => {});
          if (reuseSession.scrapeId) control.activeScrapeIds.delete(reuseSession.scrapeId);
        }
      }

      updateJobProgressSafe(job_id);
      const session = await bootstrapSession(item.url, { preserveOtherSessions: true });
      scrapeId = session.scrapeId;
      if (scrapeId) control.activeScrapeIds.add(scrapeId);

      updateJob(job_id, {
        scrape_id: session.scrapeId,
        cdp_url: session.cdpUrl ?? null,
        step: "page_ready",
      });

      await ensureLiveViewport(session, itemViewport);
      const auth = await injectAuthCookiesForUrl(session, item.url, authUserId);
      if (auth.error) {
        console.warn(`[batch] auth cookie inject warning: ${auth.error}`);
      } else if (auth.injected) {
        console.log(
          `[batch] auth cookies applied label=${auth.label} count=${auth.cookie_count}`
        );
      }
      // Login check via CDP first — REPL often dies after auth redirect on /myshop.
      await assertAnalysisUrl(session, item.url);
      try {
        await waitForPageReady(session.scrapeId);
      } catch (readyErr) {
        await assertAnalysisUrlResilient(session, item.url, readyErr);
        throw readyErr;
      }
      await assertAnalysisUrl(session, item.url);

      const artifacts = await withTimeout(
        collectWithFirecrawl(job_id, session, item.url, itemViewport, {
          skipViewportSet: true,
          nav_reuse: false,
        }),
        itemPhase1TimeoutMs(),
        `collect ${item.url} (${itemViewport})`
      );

      return { artifacts, session };
    } finally {
      stopStallWatch();
    }
  };

  /** Process one host group on a single FC worker — navigate reuse between URLs. */
  const processHostGroup = async (group: BatchAnalyzeItem[]): Promise<void> => {
    const groupKeyId = `fc-group-${batchId.slice(0, 8)}-${hostKey(group[0]!.url)}`;
    let heldSession: FirecrawlSession | null = null;

    await withAcquiredFirecrawlKey(groupKeyId, async () => {
      try {
        for (const item of group) {
          if (control.cancelled) {
            markItemCancelled(item);
            continue;
          }

          const itemViewport = item.viewport ?? defaultViewport;
          item.status = "collecting";

          await withUrlLock(item.url, async () => {
            if (control.cancelled) {
              markItemCancelled(item);
              return;
            }

            let lastError = "";
            for (let attempt = 1; attempt <= MAX_ITEM_ATTEMPTS; attempt++) {
              if (control.cancelled) {
                markItemCancelled(item);
                return;
              }
              try {
                const reuse = attempt === 1 ? heldSession : null;
                const { artifacts, session } = await collectOne(item, itemViewport, reuse);

                // Hand off to LLM immediately — do not hold FC through naming.
                // Keep session only for the next URL in this host group.
                const isLastInGroup = item === group[group.length - 1];
                if (isLastInGroup) {
                  await releaseFirecrawlSession(session);
                  if (session.scrapeId) control.activeScrapeIds.delete(session.scrapeId);
                  heldSession = null;
                } else {
                  heldSession = session;
                }

                if (!item.job_id) throw new Error("job_id missing after collect");
                llmQueue.enqueue({
                  item,
                  jobId: item.job_id,
                  url: item.url,
                  viewport: itemViewport,
                  artifacts,
                });
                return;
              } catch (e) {
                lastError = e instanceof Error ? e.message : String(e);
                heldSession = null;
                if (item.job_id) {
                  cancelJob(item.job_id);
                  clearJobCancel(item.job_id);
                  const job = getJob(item.job_id);
                  if (job?.scrape_id) {
                    control.activeScrapeIds.delete(job.scrape_id);
                    await releaseScrapeSession(job.scrape_id);
                  }
                }
                if (isLoginRequiredError(lastError)) {
                  markItemLoginRequired(item, lastError);
                  return;
                }
                // Member URL + REPL death ⇒ login (do not burn retries as "session_dead").
                if (
                  isMemberAreaUrl(item.url) &&
                  classifyAnalyzeFailure(lastError, item.url).kind === "login_required"
                ) {
                  markItemError(item, lastError);
                  return;
                }
                if (
                  control.cancelled ||
                  lastError === "cancelled_by_user" ||
                  lastError.includes("cancelled_by_user") ||
                  lastError.includes("cancelled")
                ) {
                  markItemCancelled(item);
                  return;
                }
                const transient = isTransientAnalyzeError(lastError);
                if (transient && attempt < MAX_ITEM_ATTEMPTS) {
                  item.status = "collecting";
                  item.error = undefined;
                  console.warn(
                    `[batch] transient failure url=${item.url} vp=${itemViewport} ` +
                      `attempt=${attempt}/${MAX_ITEM_ATTEMPTS} — retrying: ${lastError}`
                  );
                  await cleanupRegisteredSessions().catch(() => {});
                  await sleep(attempt * 4000);
                  continue;
                }
                break;
              }
            }
            markItemError(item, lastError || "analyze failed");
          });
        }
      } finally {
        if (heldSession) {
          await releaseFirecrawlSession(heldSession);
          if (heldSession.scrapeId) control.activeScrapeIds.delete(heldSession.scrapeId);
          heldSession = null;
        }
        releaseFirecrawlKey(groupKeyId);
      }
    });
  };

  void (async () => {
    try {
      const hostGroups = groupItemsByHost(batch.items);
      await runPool(hostGroups, fcConcurrency, async (group) => {
        if (control.cancelled) {
          for (const item of group) markItemCancelled(item);
          return;
        }
        await processHostGroup(group);
      });
      // Wait until LLM + capture queues finish (FC already done).
      await llmQueue.drain();
      llmQueue.close();
      await captureQueue.drain();
      captureQueue.close();
    } finally {
      if (!batch.cancelled) markBatchDoneIfComplete();
      else settleCancelledItems(batch);
      batchControls.delete(batchId);
      await hooks?.onBatchComplete?.(batch);
    }
  })();

  return batch;
}

function updateJobProgressSafe(jobId: string): void {
  updateJobProgress(jobId, {
    status: "crawling",
    step: "bootstrap",
    stage: "crawling",
    progress: { current: 0, total: 1 },
  });
}

/** Same CDP/interact viewport logic as the orchestrator (kept local to avoid export churn). */
async function ensureLiveViewport(
  session: FirecrawlSession,
  mode: ViewportMode
): Promise<void> {
  const target = resolveCdpDeviceMetrics(mode);

  if (mode === "mo") {
    if (session.cdpUrl) {
      try {
        await setCdpViewport(mode, { cdpUrl: session.cdpUrl });
        return;
      } catch {
        /* fall through */
      }
    }
    await setViewportAndReload(session.scrapeId, mode, [], target);
    return;
  }

  if (session.cdpUrl) {
    const cdpResult = await applyCdpLiveViewViewport(mode, { cdpUrl: session.cdpUrl });
    if (cdpResult.ok) return;
  }
  await setViewport(session.scrapeId, mode, target);
}
