import type { SnapshotCandidate, SnapshotSuggestion } from "@autotag/shared";
import type { ExtractorHint } from "../extractors/types.js";

export type LlmProvider = "openrouter" | "gemini";

export interface SnapshotLlmInput {
  version: string;
  markdown: string;
  candidates: SnapshotCandidate[];
  stageTitle?: string;
  url?: string;
  extractorHints?: ExtractorHint[];
  llm_model?: string;
  /** Code-collected page facts for page_view + page_category hint. */
  pageContext?: import("@autotag/shared").PageContextSnapshot;
  pageCategoryHint?: string;
  /** When true, LLM should return top-level page_category in JSON. */
  includePageCategory?: boolean;
  /** event_name registry injected into prompt */
  eventRegistry?: import("@autotag/shared").EventRegistry;
}

export interface ExtractDroppedCandidate {
  tag_id: number;
  reason: string;
}

export interface PipelineStageCounts {
  /** (a) Selector matches in live DOM */
  raw_dom_matched: number;
  /** (b) tag_id assigned after injectTagIds / tagLiveDom */
  tag_id_assigned: number;
  /** (c) Candidates sent to LLM */
  llm_input: number;
  /** (d) LLM suggestions with event_name */
  llm_named_output: number;
  /** (e) Fallback-synthesized count (not lost candidates) */
  dropped: number;
  dropped_by_reason: Record<string, number>;
}

export interface ExtractLlmBatchMeta {
  candidates_total_input: number;
  candidates_succeeded: number;
  dropped: ExtractDroppedCandidate[];
  llm_calls_made: number;
  splits_occurred: number;
  pipeline_stage_counts?: PipelineStageCounts;
}

export interface ExtractLlmResult {
  suggestions: SnapshotSuggestion[];
  llm_source: LlmProvider;
  meta: ExtractLlmBatchMeta;
  page_category?: string;
}
