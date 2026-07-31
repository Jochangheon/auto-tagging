// postMessage 계약 (호스트 ↔ 익스텐션). 정본: docs/api-contract-v1.md §4

export const PROTOCOL_VERSION = "1" as const;

export type MessageSource = "autotag-host" | "autotag-extension";

export type HostMessageType =
  | "AUTOTAG_PING"
  | "START_SESSION"
  | "END_SESSION"
  | "TARGET_OPENED"
  | "HIGHLIGHT_ELEMENT"
  | "CLEAR_HIGHLIGHT";

export type ExtensionMessageType =
  | "AUTOTAG_PONG"
  | "SESSION_ACK"
  | "CAPTURE_STATUS"
  | "ERROR";

export type MessageType = HostMessageType | ExtensionMessageType;

// 공통 envelope (§3.2)
export interface Envelope<T extends MessageType, P> {
  source: MessageSource;
  version: typeof PROTOCOL_VERSION;
  type: T;
  request_id: string | null;
  payload: P;
}

// --- Host → Ext ---
export type PingMessage = Envelope<"AUTOTAG_PING", { host_tab_id_hint: number | null }>;

export type StartSessionMessage = Envelope<"START_SESSION", {
  session_id: string;
  host_tab_id: number | null;
  api_base: string;
  project: string;
  /** Selected LLM model id from host UI (e.g. gemini-3.5-flash) */
  llm_model?: string;
}>;

export type EndSessionMessage = Envelope<"END_SESSION", { session_id: string }>;

/** 호스트가 window.open 직후 — background 가 opener 자식 탭에 세션 태깅 */
export type TargetOpenedMessage = Envelope<"TARGET_OPENED", {
  session_id: string;
  target_url: string;
}>;

export type HighlightElementMessage = Envelope<"HIGHLIGHT_ELEMENT", import("./highlight.js").HighlightElementPayload>;

export type ClearHighlightMessage = Envelope<"CLEAR_HIGHLIGHT", import("./highlight.js").ClearHighlightPayload>;

// --- Ext → Host ---
export type PongMessage = Envelope<"AUTOTAG_PONG", {
  extension_version: string;
  capabilities: string[];
}>;

export type SessionAckMessage = Envelope<"SESSION_ACK", {
  session_id: string;
  status: "ready";
}>;

export type CaptureStatusMessage = Envelope<"CAPTURE_STATUS", {
  session_id: string;
  phase: "scanning" | "posting" | "idle" | "error" | "ended";
  screen_id: string | null;
  events_posted: number;
  message: string | null;
}>;

export type ErrorCode = "NO_OPENER_TAB" | "SESSION_NOT_FOUND" | "CAPTURE_FAILED";

export type ErrorMessage = Envelope<"ERROR", {
  code: ErrorCode;
  message: string;
  session_id: string;
}>;

export type AnyMessage =
  | PingMessage | StartSessionMessage | EndSessionMessage | TargetOpenedMessage
  | HighlightElementMessage | ClearHighlightMessage
  | PongMessage | SessionAckMessage | CaptureStatusMessage | ErrorMessage;

// origin/type 검증 헬퍼 (§4: source !== 'autotag-extension'이면 무시)
export function isExtensionMessage(data: unknown): data is AnyMessage {
  return (
    typeof data === "object" && data !== null &&
    (data as AnyMessage).source === "autotag-extension" &&
    (data as AnyMessage).version === PROTOCOL_VERSION
  );
}
