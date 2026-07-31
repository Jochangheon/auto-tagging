// 캡처 파이프라인 공통 타입 — extension ↔ backend ↔ host

import type { Confidence, DomSignals, UiTarget } from "./schema.js";

/** DOM 직렬화·스냅샷 업로드 강도 */
export type CaptureProfile = "full" | "light";

/** 가상 화면(Stage) 종류 */
export type StageType = "base" | "modal" | "overlay" | "drawer";

/**
 * 현재 DOM 상태에서 추출한 Stage 지문.
 * URL(route) + stage 지문 → 가상 화면 ID(stageId)로 결합된다.
 */
export interface StageFingerprint {
  /** stage 해시 ID (stg_xxxxxxxx) */
  id: string;
  type: StageType;
  /** UI 표시용 제목 (H1~H4 또는 모달 라벨) */
  title: string;
  /** 감지에 매칭된 셀렉터 목록 */
  matchedSelectors: string[];
  /** 라우트 기준 base screen_id (scr_xxxxxxxx) */
  routeScreenId: string;
  /** 본문 텍스트 밀도 힌트 (0~1 근사) */
  textDensity: number;
}

/** 익스텐션 → background AT_SCAN_RESULT 확장 메타 */
export interface ScanCaptureMeta {
  stageId: string;
  stageTitle: string;
  captureProfile: CaptureProfile;
  stage: StageFingerprint;
}

/**
 * Snapshot pipeline 분류 규칙 (PoC):
 * - local_clear: button, a, cursor:pointer → 즉시 high confidence
 * - ambiguous: div/span+onclick, non-standard role, GNB hidden, hidden_in_dom → 서버 LLM
 * @see docs/SNAPSHOT-POC-ARCHITECTURE.md
 */
export type { CandidateClassification, SnapshotCandidate } from "./snapshot-pipeline.js";

/** 접근성 역파싱으로 추출한 클릭 후보 (스캐너 중간 표현) */
export interface ExtractedEvent {
  stable_key: string;
  event_type: "click";
  accessible_name: string;
  ui_target: UiTarget;
  dom_signals: DomSignals;
  /** 마크업상 display:none 등으로 화면에 안 보이는 후보 */
  hidden_in_dom: boolean;
  confidence: Confidence;
}
