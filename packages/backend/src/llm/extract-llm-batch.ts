import type { SnapshotCandidate, SnapshotSuggestion } from "@autotag/shared";
import { actionFromEventName } from "@autotag/shared";
import type { ExtractLlmBatchMeta, ExtractDroppedCandidate, LlmProvider, SnapshotLlmInput } from "./types.js";
import {
  callExtractLlmOnce,
  classifyLlmCallError,
  parseExtractLlmResponse,
  type LlmCallResult,
} from "./extract-llm-call.js";

export type { ExtractLlmBatchMeta, ExtractDroppedCandidate };

export interface ExtractLlmAdaptiveResult {
  suggestions: SnapshotSuggestion[];
  meta: ExtractLlmBatchMeta;
  page_category?: string;
}

export interface ExtractLlmAdaptiveOptions {
  /** Override env batch size (for tests) */
  batchSize?: number;
  maxOutputTokens?: number;
  concurrency?: number;
  maxRetries?: number;
  maxSplitDepth?: number;
  /** Called after each batch completes (current named count, total candidates). */
  onBatchComplete?: (current: number, total: number) => void;
  /** Returns true once the user has stopped the job — aborts pending batches. */
  cancelCheck?: () => boolean;
}

type BatchOutcomeKind = "OK" | "TRUNCATED" | "RETRYABLE_ERROR";

interface BatchTask {
  candidates: SnapshotCandidate[];
  splitDepth: number;
  rangeLabel: string;
}

interface MutableStats {
  llm_calls_made: number;
  splits_occurred: number;
}

function envInt(name: string, fallback: number, min = 1): number {
  const n = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function readExtractLlmConfig(opts: ExtractLlmAdaptiveOptions = {}) {
  return {
    batchSize: opts.batchSize ?? envInt("EXTRACT_LLM_BATCH_SIZE", 35, 1),
    maxOutputTokens: opts.maxOutputTokens ?? envInt("EXTRACT_LLM_MAX_TOKENS", 8192, 256),
    concurrency: opts.concurrency ?? envInt("EXTRACT_LLM_CONCURRENCY", 8, 1),
    maxRetries: opts.maxRetries ?? envInt("EXTRACT_LLM_MAX_RETRIES", 3, 1),
    maxSplitDepth: opts.maxSplitDepth ?? envInt("EXTRACT_LLM_MAX_SPLIT_DEPTH", 5, 0),
  };
}

/** Adaptive split batch processor — lossless invariant enforced. */
export async function runExtractLlmAdaptive(
  input: SnapshotLlmInput,
  provider: LlmProvider,
  opts: ExtractLlmAdaptiveOptions = {}
): Promise<ExtractLlmAdaptiveResult> {
  const config = readExtractLlmConfig(opts);
  const stats: MutableStats = { llm_calls_made: 0, splits_occurred: 0 };
  const pool = new ConcurrencyPool(config.concurrency);

  const inputTagIds = input.candidates.map((c) => c.tag_id);
  const totalCandidates = input.candidates.length;
  let namedCount = 0;
  const onBatchComplete = opts.onBatchComplete;

  const initialBatches = chunkArray(input.candidates, config.batchSize);

  console.log(
    `[autotag] extract adaptive: ${input.candidates.length} candidates → ${initialBatches.length} initial batch(es) ` +
      `(size≤${config.batchSize}, concurrency=${config.concurrency}, max_split_depth=${config.maxSplitDepth})`
  );

  const cancelCheck = opts.cancelCheck;
  const partials = await Promise.all(
    initialBatches.map((batch, index) => {
      const start = index * config.batchSize;
      const end = start + batch.length - 1;
      const rangeLabel = `${start}-${end}`;
      return pool.run(() => {
        // User stopped the job — skip remaining batches instead of calling the LLM.
        if (cancelCheck?.()) throw new Error("cancelled_by_user");
        return processBatchTask(
          input,
          provider,
          { candidates: batch, splitDepth: 0, rangeLabel },
          config,
          stats,
          pool,
          (batchSize) => {
            namedCount += batchSize;
            onBatchComplete?.(namedCount, totalCandidates);
          }
        );
      });
    })
  );

  const suggestions: SnapshotSuggestion[] = [];
  const synthesized: ExtractDroppedCandidate[] = [];
  let page_category: string | undefined;
  for (const part of partials) {
    suggestions.push(...part.suggestions);
    synthesized.push(...part.synthesized);
    if (!page_category && part.page_category) {
      page_category = part.page_category;
    }
  }

  assertLosslessInvariant(inputTagIds, suggestions);

  const meta: ExtractLlmBatchMeta = {
    candidates_total_input: inputTagIds.length,
    candidates_succeeded: suggestions.length,
    dropped: synthesized,
    llm_calls_made: stats.llm_calls_made,
    splits_occurred: stats.splits_occurred,
  };

  if (synthesized.length > 0 || stats.splits_occurred > 0) {
    console.warn(
      `[autotag] extract adaptive summary: succeeded=${meta.candidates_succeeded} synthesized=${synthesized.length} ` +
        `calls=${stats.llm_calls_made} splits=${stats.splits_occurred}`
    );
  }

  return { suggestions, meta, page_category };
}

async function processBatchTask(
  baseInput: SnapshotLlmInput,
  provider: LlmProvider,
  task: BatchTask,
  config: ReturnType<typeof readExtractLlmConfig>,
  stats: MutableStats,
  pool: ConcurrencyPool,
  onBatchDone: (batchSize: number) => void
): Promise<{ suggestions: SnapshotSuggestion[]; synthesized: ExtractDroppedCandidate[]; page_category?: string }> {
  const outcome = await callWithRetryableHandling(
    baseInput,
    provider,
    task,
    config,
    stats
  );

  if (outcome.kind === "OK") {
    onBatchDone(task.candidates.length);
    return { suggestions: outcome.suggestions, synthesized: [], page_category: outcome.page_category };
  }

  if (outcome.kind === "TRUNCATED") {
    stats.splits_occurred++;

    console.warn(
      `[autotag] extract TRUNCATED range=${task.rangeLabel} size=${task.candidates.length} ` +
        `split_depth=${task.splitDepth} — discarding partial, splitting`
    );

    if (task.candidates.length === 1) {
      const reason =
        task.splitDepth >= config.maxSplitDepth ? "max_split_depth" : "truncated_at_size_1";
      const result = ensureFullCoverage(task.candidates, [], reason);
      onBatchDone(task.candidates.length);
      return result;
    }

    if (task.splitDepth >= config.maxSplitDepth) {
      const result = ensureFullCoverage(task.candidates, [], "max_split_depth");
      onBatchDone(task.candidates.length);
      return result;
    }

    const mid = Math.ceil(task.candidates.length / 2);
    const left = task.candidates.slice(0, mid);
    const right = task.candidates.slice(mid);
    const leftStart = task.rangeLabel.split("-")[0] ?? "0";
    const leftEnd = String(Number(leftStart) + left.length - 1);
    const rightStart = String(Number(leftStart) + left.length);
    const rightEnd = task.rangeLabel.split("-")[1] ?? rightStart;

    const [leftResult, rightResult] = await Promise.all([
      processBatchTask(
        baseInput,
        provider,
        {
          candidates: left,
          splitDepth: task.splitDepth + 1,
          rangeLabel: `${leftStart}-${leftEnd}`,
        },
        config,
        stats,
        pool,
        onBatchDone
      ),
      processBatchTask(
        baseInput,
        provider,
        {
          candidates: right,
          splitDepth: task.splitDepth + 1,
          rangeLabel: `${rightStart}-${rightEnd}`,
        },
        config,
        stats,
        pool,
        onBatchDone
      ),
    ]);

    return {
      suggestions: [...leftResult.suggestions, ...rightResult.suggestions],
      synthesized: [...leftResult.synthesized, ...rightResult.synthesized],
      page_category: leftResult.page_category ?? rightResult.page_category,
    };
  }

  // RETRYABLE_ERROR exhausted
  console.error(
    `[autotag] extract RETRYABLE exhausted range=${task.rangeLabel} size=${task.candidates.length}: ${outcome.error.message}`
  );
  const result = ensureFullCoverage(task.candidates, [], "retry_exhausted");
  onBatchDone(task.candidates.length);
  return result;
}

async function callWithRetryableHandling(
  baseInput: SnapshotLlmInput,
  provider: LlmProvider,
  task: BatchTask,
  config: ReturnType<typeof readExtractLlmConfig>,
  stats: MutableStats
): Promise<
  | { kind: "OK"; suggestions: SnapshotSuggestion[]; page_category?: string }
  | { kind: "TRUNCATED" }
  | { kind: "RETRYABLE_ERROR"; error: Error }
> {
  let lastRetryable: Error | undefined;
  const expectedTagIds = task.candidates.map((c) => c.tag_id);

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    stats.llm_calls_made++;

    try {
      const callResult = await callExtractLlmOnce({
        baseInput,
        provider,
        candidates: task.candidates,
        rangeLabel: task.rangeLabel,
        splitDepth: task.splitDepth,
        attempt,
        maxOutputTokens: config.maxOutputTokens,
      });

      const classified = classifyCallResult(callResult, expectedTagIds, baseInput.eventRegistry);
      if (classified.kind === "OK") return classified;
      if (classified.kind === "TRUNCATED") return classified;

      lastRetryable = classified.error;
      if (attempt < config.maxRetries) {
        const waitMs = 1000 * 2 ** (attempt - 1);
        console.warn(
          `[autotag] extract RETRYABLE range=${task.rangeLabel} attempt ${attempt}/${config.maxRetries}: ${lastRetryable.message} — retry in ${waitMs}ms`
        );
        await sleepMs(waitMs);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const kind = classifyLlmCallError(error);
      if (kind === "TRUNCATED") return { kind: "TRUNCATED" };
      if (kind === "RETRYABLE_ERROR") {
        lastRetryable = error;
        if (attempt < config.maxRetries) {
          const waitMs = 1000 * 2 ** (attempt - 1);
          console.warn(
            `[autotag] extract RETRYABLE range=${task.rangeLabel} attempt ${attempt}/${config.maxRetries}: ${error.message} — retry in ${waitMs}ms`
          );
          await sleepMs(waitMs);
          continue;
        }
        return { kind: "RETRYABLE_ERROR", error };
      }
      throw error;
    }
  }

  return { kind: "RETRYABLE_ERROR", error: lastRetryable ?? new Error("retry exhausted") };
}

function classifyCallResult(
  callResult: LlmCallResult,
  expectedTagIds: number[],
  registry?: import("@autotag/shared").EventRegistry
):
  | { kind: "OK"; suggestions: SnapshotSuggestion[]; page_category?: string }
  | { kind: "TRUNCATED" }
  | { kind: "RETRYABLE_ERROR"; error: Error } {
  if (callResult.finishReason === "length") {
    return { kind: "TRUNCATED" };
  }

  try {
    const parsed = parseExtractLlmResponse(callResult.text, registry);
    const suggestions = parsed.suggestions;
    const returned = new Set(suggestions.map((s) => s.tag_id));
    const missing = expectedTagIds.filter((id) => !returned.has(id));
    if (missing.length > 0) {
      return {
        kind: "RETRYABLE_ERROR",
        error: new Error(
          `LLM omitted ${missing.length} tag_id(s): [${missing.slice(0, 8).join(",")}${missing.length > 8 ? "…" : ""}]`
        ),
      };
    }
    return { kind: "OK", suggestions, page_category: parsed.page_category };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const kind = classifyLlmCallError(error, callResult.text, callResult.finishReason);
    if (kind === "TRUNCATED") return { kind: "TRUNCATED" };
    if (kind === "RETRYABLE_ERROR") return { kind: "RETRYABLE_ERROR", error };
    throw error;
  }
}

function ensureFullCoverage(
  batchCandidates: SnapshotCandidate[],
  suggestions: SnapshotSuggestion[],
  reason: string
): { suggestions: SnapshotSuggestion[]; synthesized: ExtractDroppedCandidate[] } {
  const byId = new Map<number, SnapshotSuggestion>();
  for (const s of suggestions) {
    if (!byId.has(s.tag_id)) byId.set(s.tag_id, s);
  }

  const full: SnapshotSuggestion[] = [...suggestions];
  const synthesized: ExtractDroppedCandidate[] = [];

  for (const c of batchCandidates) {
    if (byId.has(c.tag_id)) continue;
    full.push(synthesizeFallback(c, reason));
    synthesized.push({ tag_id: c.tag_id, reason });
  }

  return { suggestions: full, synthesized };
}

function synthesizeFallback(candidate: SnapshotCandidate, reason: string): SnapshotSuggestion {
  const name = candidate.accessible_name.trim();
  const landmark = candidate.dom_path?.landmark;
  const category =
    landmark === "gnb"
      ? "global/gnb"
      : landmark === "fnb"
        ? "global/fnb"
        : candidate.dom_path?.section_heading?.trim() || "unknown";
  const action =
    category === "global/gnb" ? "click_gnb" : category === "global/fnb" ? "click_fnb" : actionFromEventName("클릭");

  return {
    tag_id: candidate.tag_id,
    category,
    action,
    label: name || "[button]",
    merge_label: name || "[button]",
    event_name: "클릭",
    rationale: `ambiguous — manual review (${reason})`,
    parameters: [],
  };
}

function assertLosslessInvariant(inputTagIds: number[], suggestions: SnapshotSuggestion[]): void {
  const suggestionIds = new Set(suggestions.map((s) => s.tag_id));

  const missing = inputTagIds.filter((id) => !suggestionIds.has(id));
  const extra = [...suggestionIds].filter((id) => !inputTagIds.includes(id));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `extract invariant violated: input=${inputTagIds.length} suggestions=${suggestionIds.size} ` +
        `missing=[${missing.join(",")}] extra=[${extra.join(",")}]`
    );
  }
}

class ConcurrencyPool {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            const next = this.queue.shift();
            if (next) next();
          });
      };

      if (this.active < this.limit) start();
      else this.queue.push(start);
    });
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
