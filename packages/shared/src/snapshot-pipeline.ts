// Snapshot Shared AI Tagging Pipeline — extension ↔ backend 계약
// 정본: docs/SNAPSHOT-POC-ARCHITECTURE.md

import type { StageFingerprint } from "./types.js";
import type { DomPathContext } from "./dom-path.js";

/** 후보 분류 — local은 즉시 high confidence, ambiguous는 서버 LLM */
export type CandidateClassification = "local_clear" | "ambiguous";

/** 스냅샷 패키지 내 단일 후보 */
export interface SnapshotCandidate {
  tag_id: number;
  rect: { x: number; y: number; w: number; h: number };
  accessible_name: string;
  tag: string;
  classification: CandidateClassification;
  hidden_in_dom: boolean;
  role: string | null;
  /** 로컬 분류 사유 (디버그·문서용) */
  reason?: string;
  /** DOM parent-chain context for LLM category classification */
  dom_path?: DomPathContext;
  /** Code-collected href (anchors) */
  link_url?: string | null;
}

/** POST /api/v1/analyze-snapshot 요청 */
export interface AnalyzeSnapshotRequest {
  /** stage_version_id — StageDetector + 타임스탬프; 응답 version lock에 사용 */
  version: string;
  html_snapshot: string;
  candidates: SnapshotCandidate[];
  screen_id?: string;
  stage?: StageFingerprint;
  url?: string;
  /** UI model id (e.g. gemini-3.5-flash) or OpenRouter slug — optional per-request override */
  llm_model?: string;
}

/** LLM이 제안한 단일 태깅 */
export interface SnapshotSuggestion {
  tag_id: number;
  /** Page region (e.g. global/gnb, 추천상품) */
  category: string;
  /** Interaction action (e.g. add_to_cart, navigate) */
  action: string;
  /** Visible label text on screen (per-element display name) */
  label: string;
  /** Taxonomy row merge key — server groups by exact match only */
  merge_label: string;
  /** LLM-assigned event name (ThinkingData registry) */
  event_name: string;
  parameters: { name: string; value_hint: string | null }[];
  rationale?: string;
  /** True when LLM returned new_event_name (append to registry). */
  registry_created?: boolean;
  new_event_reason?: string;
}

/** POST /api/v1/analyze-snapshot 응답 */
export interface AnalyzeSnapshotResponse {
  version: string;
  /** LLM이 태깅 대상으로 판단한 tag_id 목록 */
  tag_ids: number[];
  suggestions: SnapshotSuggestion[];
}
