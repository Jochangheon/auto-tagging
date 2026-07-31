// rrweb-snapshot 직렬화 페이로드 — extension ↔ backend ↔ host 공통 계약

import type { snapshot } from "rrweb-snapshot";

/** rrweb `snapshot(document)` 루트 노드 */
export type DomSnapshotNode = NonNullable<ReturnType<typeof snapshot>>;

export interface DomSnapshotPayload {
  /** 스냅샷 포맷 식별자 */
  format: "rrweb-snapshot-v1";
  /** rrweb-snapshot `snapshot()` 결과 — 인라인 CSS·이미지·canvas 상태 포함 */
  domSnapshot: DomSnapshotNode;
  base_url: string;
  page_width: number;
  page_height: number;
  has_modal: boolean;
  modal_count: number;
}

export interface PutDomSnapshotRequest extends DomSnapshotPayload {
  scroll_x?: number;
  scroll_y?: number;
}
