// REST 계약 (호스트/익스텐션 ↔ 백엔드). 정본: docs/api-contract-v1.md §6
import type { Screen, TaggingEvent, Spec } from "./schema.js";

// POST /sessions (§6.1)
export interface CreateSessionRequest {
  session_id: string;
  project: string;
  created_by: "host" | "extension";
  metadata?: Record<string, unknown>;
}
export interface CreateSessionResponse {
  session_id: string;
  status: "active";
  created_at: string;
}

// PUT /sessions/{sid}/screens/{screen_id} (§6.2)
export type UpsertScreenRequest = Omit<Screen, "events">;
export interface UpsertScreenResponse {
  screen_id: string;
  updated_at: string;
}

// POST /sessions/{sid}/screens/{screen_id}/events (§6.3)
export interface UpsertEventsRequest {
  events: TaggingEvent[];
  scan_meta: { tab_id: number; url: string; scanned_at: string };
}
export interface UpsertEventsResponse {
  accepted: number;
  upserted: number;
  skipped: number;
  events: {
    event_id: string;
    stable_key: string;
    llm_status: "pending" | "complete";
    event_name: string | null;
  }[];
}

// GET /sessions/{sid} (§6.4)
export type GetSpecResponse = Spec;

// PUT /sessions/{sid}/screens/{screenId}/dom-snapshot
export type { DomSnapshotPayload, PutDomSnapshotRequest } from "./snapshot.js";

// GET /llm/models — selectable OpenRouter models for host UI
export type { LlmModelEntry, LlmModelUse } from "./llm-models.js";

export interface LlmModelsResponse {
  default_id: string;
  models: {
    id: string;
    label: string;
    openrouter_slug: string;
    recommended_for?: "tagging" | "vision";
  }[];
}

// POST /analyze-snapshot — Snapshot Shared AI Tagging Pipeline PoC
export type {
  AnalyzeSnapshotRequest,
  AnalyzeSnapshotResponse,
  SnapshotCandidate,
  SnapshotSuggestion,
  CandidateClassification,
} from "./snapshot-pipeline.js";

// PATCH /sessions/{sid}/events/{event_id} (§6.5)
export type PatchEventRequest = Partial<Pick<TaggingEvent, "event_name" | "qa_status" | "source" | "notes">>;

// 에러 (§7.1)
export type HttpErrorCode = 400 | 404 | 409 | 429 | 500 | 503;
