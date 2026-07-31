// postMessage — 호스트 ↔ 익스텐션 라이브 하이라이트 페이로드
// Agent SaaS: CDP highlight also accepts tag_id (1st priority)

/** 호스트 → 익스텐션 / CDP: 대상 탭에서 요소 강조 */
export interface HighlightElementPayload {
  session_id: string;
  stable_key: string;
  /** Primary anchor in crawl session DOM (Phase 1+) */
  tag_id?: number | string | null;
  selector_hint: string;
  selectors_fallback: string[];
  overlay_bbox: { x: number; y: number; w: number; h: number } | null;
  label?: string | null;
}

export interface ClearHighlightPayload {
  session_id: string;
}
