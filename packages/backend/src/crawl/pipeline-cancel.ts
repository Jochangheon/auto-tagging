/**
 * Lightweight per-job cancellation registry.
 *
 * The analyze pipeline (menu explore → capture → HTML → LLM extract → Phase 2)
 * is a long chain that isn't tied to any single AbortController. When the user
 * presses 중단, we flag the job id here and the pipeline checks it at every
 * stage boundary (and inside the LLM batch pool) so work stops promptly instead
 * of running to completion in the background.
 */
const cancelledJobs = new Set<string>();

export function cancelJob(jobId: string | null | undefined): void {
  if (jobId) cancelledJobs.add(jobId);
}

export function clearJobCancel(jobId: string | null | undefined): void {
  if (jobId) cancelledJobs.delete(jobId);
}

export function isJobCancelled(jobId: string | null | undefined): boolean {
  return !!jobId && cancelledJobs.has(jobId);
}

/** Throw a uniform cancellation error when a job has been stopped by the user. */
export function throwIfCancelled(jobId: string | null | undefined): void {
  if (isJobCancelled(jobId)) {
    throw new Error("cancelled_by_user");
  }
}
