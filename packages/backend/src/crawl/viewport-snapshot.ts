import type { CandidateGroup, CandidateTree, RecommendedTagCandidate, ViewportMode } from "@autotag/shared";
import type { LlmProvider, ExtractLlmBatchMeta } from "../llm/types.js";

/** Cached tagging result for one viewport mode (pc | mo). */
export interface ViewportSnapshot {
  viewport: ViewportMode;
  candidates: RecommendedTagCandidate[];
  groups: CandidateGroup[];
  candidate_tree?: CandidateTree;
  html_length: number;
  gnb_hover_opened: string[];
  llm_source?: LlmProvider;
  extract_meta?: ExtractLlmBatchMeta;
  candidate_count: number;
  group_count: number;
}

export type ViewportCache = Partial<Record<ViewportMode, ViewportSnapshot>>;

export function buildViewportSnapshot(
  viewport: ViewportMode,
  data: {
    candidates: RecommendedTagCandidate[];
    groups: CandidateGroup[];
    candidate_tree?: CandidateTree;
    html_length: number;
    gnb_hover_opened: string[];
    llm_source?: LlmProvider;
    extract_meta?: ExtractLlmBatchMeta;
  }
): ViewportSnapshot {
  return {
    viewport,
    candidates: data.candidates,
    groups: data.groups,
    candidate_tree: data.candidate_tree,
    html_length: data.html_length,
    gnb_hover_opened: data.gnb_hover_opened,
    llm_source: data.llm_source,
    extract_meta: data.extract_meta,
    candidate_count: data.candidates.length,
    group_count: data.groups.length,
  };
}
