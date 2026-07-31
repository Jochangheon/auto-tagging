// unified-v1 spec 스키마. 정본: docs/v1-unified-schema-and-llm-grounding.md

import type { DomSnapshotPayload } from "./snapshot.js";
import type { StageType } from "./types.js";

export type DetectedBy = "route" | "dom" | "heuristic" | "manual";
export type EventType = "page" | "click" | "impression" | "ecommerce" | "custom";
export type Confidence = "high" | "medium" | "low";
export type SelectorStability = "high" | "medium" | "low";
export type EventSource = "auto" | "human_edited";

export interface UiTarget {
  selector_hint: string;
  selectors_fallback: string[];
  selector_stability: SelectorStability;
  recommended_data_hook: string | null;
  overlay_bbox: { x: number; y: number; w: number; h: number } | null;
}

export interface DomSignals {
  tag: string;
  text: string | null;
  data_link: Record<string, unknown>;
}

export interface TaggingEvent {
  event_id?: string;
  stable_key: string;          // hash(screen_id + selector_hint + event_type)
  event_type: EventType;
  event_name: string | null;   // LLM/사람이 unified-v1로 채움
  trigger: { type: string; description: string };
  ui_target: UiTarget;
  dom_signals: DomSignals;
  parameters?: { name: string; value_hint: string | null }[];
  platform_targets?: string[];
  confidence: Confidence;
  source: EventSource;
  qa_status?: "pass" | "fail" | "pending";
  notes?: string;
}

export interface Screen {
  screen_id: string;
  screen_name: string;
  page_url_pattern: string;
  detected_by: DetectedBy;
  /** P3: 가상 화면(모달·오버레이) 메타 — base 화면이면 생략 */
  stage?: {
    stage_id: string;
    type: StageType;
    title: string;
    matched_selectors: string[];
    parent_screen_id: string;
    text_density: number;
  };
  capture?: {
    screenshot_ref: string | null;
    dom_snapshot_ref?: string | null;
    /** GET /sessions 폴링 시 인라인 포함 (별도 fetch 생략 가능) */
    dom_snapshot_data?: DomSnapshotPayload | null;
    render_mode?: "rrweb" | "dom" | "screenshot";
    captured_at: string;
    viewport?: {
      width: number;
      height: number;
      scroll_x?: number;
      scroll_y?: number;
      has_modal?: boolean;
    };
  };
  events: TaggingEvent[];
}

export interface Spec {
  spec_version: "1.0";
  session_id: string;
  project: string;
  naming_convention: "unified-v1";
  platform_targets_recommended: string[];
  screens: Screen[];
}
