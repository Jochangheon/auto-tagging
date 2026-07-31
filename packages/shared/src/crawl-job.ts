// Agent crawl job — status, state dumps, candidates, v2 API DTOs

import type { SelectorStability } from "./schema.js";
import type { EventType } from "./schema.js";
import type { CandidateGroup, CandidateTree } from "./candidate-group.js";
import type { HiddenReason, Platform, ViewportMode } from "./viewport.js";

export type { CandidateGroup, CandidateTree } from "./candidate-group.js";

/** One step in a menu reveal path (for replay highlight). */
export interface MenuRevealPathStep {
  key: string;
  label: string;
  method: "hover" | "click";
  selector_hint: string;
}

/** Job lifecycle (POST /api/v2/jobs) */
export type JobStatus =
  | "queued"
  | "crawling"
  | "extracting"
  | "awaiting_pick"
  | "completed"
  | "failed"
  | "auth_required";

export type JobFailureReason =
  | "timeout"
  | "budget_exceeded"
  | "firecrawl_error"
  | "extract_error"
  | "unknown";

/** One captured UI state after explore (base, dropdown open, modal, …) */
export interface CrawlStateDump {
  state_id: string;
  title: string;
  /** Raw HTML with data-tag-id injected */
  html: string;
  /** Optional markdown derived from html */
  markdown?: string;
  /** Firecrawl session handles (same browser across states) */
  cdp_url?: string;
  live_view_url?: string;
  captured_at: string;
}

/** LLM + selector assembly — workspace list row */
export interface RecommendedTagCandidate {
  candidate_id: string;
  tag_id: number;
  state_id: string;
  text: string;
  role: string | null;
  parental_context: string;
  selector_hint: string;
  selectors_fallback: string[];
  selector_stability: SelectorStability;
  recommended_data_hook: string | null;
  overlay_bbox: { x: number; y: number; w: number; h: number } | null;
  /** Page tab name (e.g. 메인) — canonical `category` in transmission JSON */
  page_category?: string;
  category: string;
  /** Screen area (e.g. GNB, 배너) — canonical `action` in transmission JSON */
  action: string;
  /** Internal merge/group key (click, slide_nav, page_view, …) */
  action_key?: string;
  label: string;
  /** LLM taxonomy merge key — server groups by exact match only */
  merge_label?: string;
  event_name: string | null;
  /** click (default) | page | … */
  event_type?: EventType;
  parameters: { name: string; value_hint: string | null }[];
  picked: boolean;
  /** Workspace selection before taxonomy confirm */
  selected?: boolean;
  /** @deprecated unused — all candidates default selected */
  uncertain?: boolean;
  /** Responsive platform (PC / MO / All) — code-classified at collection */
  platform?: Platform;
  platform_reason?: string;
  hidden_reason?: HiddenReason;
  /** Path to replay menu expansion before highlight. */
  menu_reveal_path?: MenuRevealPathStep[];
  /** Screenshot preview cannot show this element (hidden / no bbox). */
  no_capture?: boolean;
  /** True when capture-time DOM resample found this tag_id. */
  capture_found?: boolean;
  /** Per-element screenshot with bbox highlight baked in (not page_view). */
  element_capture_url?: string | null;
  /**
   * Phase 2 (background) capture lifecycle — Phase 1 (naming/candidates) resolves
   * before element screenshots exist. `pending`/`capturing` → preview shows
   * "이미지 캡쳐중...". `done`/`failed` → capture settled (see element_capture_url).
   */
  capture_status?: "pending" | "capturing" | "done" | "failed";
}

/** One row in positions.json — canonical element geometry for preview & Phase 2 capture. */
export type { ElementLocation, ElementBbox } from "./element-location.js";
export type ElementPosition = import("./element-location.js").ElementLocation;

export interface CrawlJobProgress {
  job_id: string;
  status: JobStatus;
  source_url: string;
  step?: string;
  progress_pct?: number;
  error_message?: string | null;
  failure_reason?: JobFailureReason | null;
  created_at: string;
  updated_at: string;
}

export interface CreateJobRequest {
  url: string;
  /** Re-use explore profile label (optional) */
  profile?: string;
}

export interface CreateJobResponse {
  job_id: string;
  status: JobStatus;
}

export interface JobResultStateSummary {
  state_id: string;
  title: string;
  candidate_count: number;
}

export interface JobResultResponse {
  job_id: string;
  source_url: string;
  captured_at: string;
  live_view_url: string | null;
  cdp_url: string | null;
  states: JobResultStateSummary[];
  candidates: RecommendedTagCandidate[];
  groups?: CandidateGroup[];
  tree?: CandidateTree;
}

export interface HighlightJobRequest {
  tag_id?: number;
  candidate_id?: string;
}

export interface ConfirmJobRequest {
  picked_candidate_ids: string[];
}

export interface ConfirmJobResponse {
  job_id: string;
  status: JobStatus;
  picked_count: number;
}

/** One analyzed page inside a dev session (page → category → action → label). */
export interface PageNode {
  page_url: string;
  page_name: string;
  analyzed_at: string;
  job_id: string;
  tree: CandidateTree;
  groups: CandidateGroup[];
  candidates: RecommendedTagCandidate[];
  candidate_count: number;
  group_count: number;
  active_viewport?: ViewportMode;
  gnb_hover_opened?: string[];
  /** Static full-page capture for step-3 preview */
  capture_url?: string | null;
  capture_width?: number | null;
  capture_height?: number | null;
  /** Same data as data/captures/{job_id}/positions.json — shared by pick UI & taxonomy. */
  positions?: ElementPosition[];
  positions_url?: string | null;
}

import type { TaxonomyViewModel } from "./taxonomy.js";

/** Dev workspace session — accumulates PageNode[] across analyze runs. */
export interface SessionResult {
  session_id: string;
  project_id?: string | null;
  pages: PageNode[];
  active_page_url: string | null;
  updated_at: string;
  /** pageUrl::tagId → selected */
  selection?: Record<string, boolean>;
  taxonomy?: TaxonomyViewModel | null;
  taxonomy_confirmed_at?: string | null;
}
