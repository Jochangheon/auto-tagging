/** ThinkingData-style event_name registry — LLM reuses names across sessions. */

export type EventRegistry = Record<string, string>;

export const PAGE_VIEW_EVENT_NAME = "페이지뷰";

/** Seed registry — grows as LLM defines new event names. */
export const DEFAULT_EVENT_REGISTRY: EventRegistry = {
  [PAGE_VIEW_EVENT_NAME]: "페이지 진입 시 발생",
  클릭: "일반 버튼/링크 이동",
  배너이동: "캐러셀·슬라이더 좌우 이동",
  찜하기: "위시리스트(하트) 추가",
};

/** Collapse all whitespace — used to match "찜 하기" ↔ "찜하기". */
export function collapseNameWhitespace(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

/** Collapse runs of whitespace to a single space (labels/categories). */
export function normalizeDisplaySpacing(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Canonical event_name form: no internal spaces.
 * Registry names are space-free (클릭, 배너이동, 찜하기).
 */
export function canonicalizeEventName(raw: string): string {
  return collapseNameWhitespace(raw);
}

/** Find registry key that matches ignoring whitespace differences. */
export function findRegistryEventName(
  raw: string,
  registry: EventRegistry
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (registry[trimmed]) return trimmed;

  const collapsed = collapseNameWhitespace(trimmed);
  if (!collapsed) return null;
  if (registry[collapsed]) return collapsed;

  for (const key of Object.keys(registry)) {
    if (collapseNameWhitespace(key) === collapsed) return key;
  }
  return null;
}

/** Format registry for LLM prompt injection. */
export function formatEventRegistryForPrompt(registry: EventRegistry): string {
  return Object.entries(registry)
    .map(([name, meaning]) => `- "${name}": ${meaning}`)
    .join("\n");
}

/** Reject compound/slug event names (영역명·접두어 금지). */
export function isValidThinkingDataEventName(name: string): boolean {
  const n = canonicalizeEventName(name);
  if (!n || n.length > 24) return false;
  if (/[_/]/.test(n)) return false;
  if (/^(slide|click|hero|banner|page)_/i.test(n)) return false;
  if (/메인|배너|gnb|fnb/i.test(n) && n.length > 6) return false;
  return /[\uAC00-\uD7A3]/.test(n);
}

export function sanitizeThinkingDataEventName(
  raw: string,
  registry: EventRegistry,
  fallback = "클릭"
): string {
  const matched = findRegistryEventName(raw, registry);
  if (matched) return matched;

  const canonical = canonicalizeEventName(raw);
  if (canonical && isValidThinkingDataEventName(canonical)) return canonical;

  return registry[fallback] ? fallback : Object.keys(registry)[0] ?? "클릭";
}

/** Map event_name → internal action for UI tree grouping (not sent as event_name). */
export function actionFromEventName(eventName: string): string {
  switch (eventName) {
    case "배너이동":
      return "slide_nav";
    case "찜하기":
      return "add_wishlist";
    case "클릭":
      return "click";
    case PAGE_VIEW_EVENT_NAME:
      return "page_view";
    default:
      return "interact";
  }
}
