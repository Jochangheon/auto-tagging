import type { SnapshotCandidate, SnapshotSuggestion } from "@autotag/shared";
import {
  normalizeSnapshotSuggestion,
  formatDomPathPromptFields,
  formatEventRegistryForPrompt,
  LLM_CONSISTENT_GROUPING_BLOCK,
  LLM_DEPTH_RULE_BLOCK,
  LLM_LABEL_RULE_BLOCK,
  LLM_MERGE_LABEL_RULE_BLOCK,
  LLM_BANNER_RULE_BLOCK,
  LLM_NAME_STABILITY_BLOCK,
  llmExactCountWithDedupHint,
} from "@autotag/shared";
import type { LlmProvider, SnapshotLlmInput } from "./types.js";
import { generateGeminiText, getGeminiApiKey } from "./gemini.js";
import { callOpenRouterDetailed } from "./openrouter.js";

const EXTRACT_SYSTEM_PROMPT =
  "You are a ThinkingData analytics tagging assistant. Return only valid JSON. event_name must be Korean short action words from the registry when possible, with no internal spaces.";

export interface LlmCallResult {
  text: string;
  finishReason: string | null;
}

export interface ExtractLlmOnceParams {
  baseInput: SnapshotLlmInput;
  provider: LlmProvider;
  candidates: SnapshotCandidate[];
  rangeLabel: string;
  splitDepth: number;
  attempt: number;
  maxOutputTokens: number;
}

export async function callExtractLlmOnce(params: ExtractLlmOnceParams): Promise<LlmCallResult> {
  const userPrompt = buildExtractUserPrompt(params.baseInput, params.candidates, params.rangeLabel);

  if (params.provider === "openrouter") {
    const result = await callOpenRouterDetailed(EXTRACT_SYSTEM_PROMPT, userPrompt, true, {
      maxTokens: params.maxOutputTokens,
      model: params.baseInput.llm_model,
    });
    logExtractLlmRaw({
      rangeLabel: params.rangeLabel,
      splitDepth: params.splitDepth,
      attempt: params.attempt,
      candidateCount: params.candidates.length,
      finishReason: result.finishReason,
      text: result.text,
      model: result.model,
    });
    return { text: result.text, finishReason: result.finishReason };
  }

  if (params.provider === "gemini") {
    const apiKey = getGeminiApiKey();
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");
    const text = await generateGeminiText(apiKey, EXTRACT_SYSTEM_PROMPT, userPrompt, {
      json: true,
      maxOutputTokens: params.maxOutputTokens,
    });
    logExtractLlmRaw({
      rangeLabel: params.rangeLabel,
      splitDepth: params.splitDepth,
      attempt: params.attempt,
      candidateCount: params.candidates.length,
      finishReason: null,
      text,
      model: "gemini",
    });
    return { text, finishReason: null };
  }

  throw new Error("No LLM provider configured");
}

export function buildExtractUserPrompt(
  input: SnapshotLlmInput,
  candidates: SnapshotCandidate[],
  rangeLabel: string
): string {
  const registryBlock = formatEventRegistryForPrompt(input.eventRegistry ?? {});

  const candidateList = candidates
    .map((c) => {
      const hints = c.reason?.includes("hints:") ? c.reason.split("hints:")[1]?.trim() : "";
      const hintPart = hints ? ` hints="${hints}"` : "";
      const domPart = formatDomPathPromptFields(c.dom_path);
      const linkPart = c.link_url ? ` link_url="${c.link_url}"` : "";
      return (
        `tag_id=${c.tag_id} name="${c.accessible_name}" tag=${c.tag} hidden=${c.hidden_in_dom}` +
        `${domPart}${linkPart}${hintPart} reason=${c.reason ?? "ambiguous"}`
      );
    })
    .join("\n");

  const hintBlock =
    input.extractorHints && input.extractorHints.length > 0
      ? `\n## Pre-analysis from enrichment extractors\nUse as hints only — verify against markdown.\n${input.extractorHints
          .map(
            (h) =>
              `- tag:${h.tag_id} source=${h.source}${h.event_name ? ` suggested="${h.event_name}"` : ""}${h.note ? ` (${h.note})` : ""}`
          )
          .join("\n")}\n`
      : "";

  const batchLine =
    candidates.length > 0
      ? `\nBatch tag_id range ${rangeLabel} (${candidates.length} candidates) — classify ONLY the tag_ids listed below.\n`
      : "";

  const pageBlock = buildPageContextPromptBlock(input);

  return `Classify interactive elements for ThinkingData analytics tagging.${batchLine}
${pageBlock}

## event_name registry (MUST reuse when applicable)
Below are event names defined so far. Reuse an existing name when the interaction matches.
${registryBlock}

For each button/link:
1. If an existing event_name matches the interaction, set event_name to that exact string (reuse).
2. Only when NONE match, create a new Korean short action name via new_event_name + new_event_reason.
3. event_name must be Korean, short, action-focused, **no spaces** (예: 클릭, 배너이동, 찜하기). NO prefixes (slide_, click_), NO area names (메인_배너 등), NO spacing variants ("배너 이동" 금지 — 레지스트리의 "배너이동"을 그대로 복사).
4. Put area/label/direction/link details in category, label, parameters — NOT in event_name.
5. If registry already has the same meaning, copy that exact event_name string (character-for-character). Do not invent a near-duplicate that differs only by spaces.

Page: ${input.stageTitle ?? "unknown"} (${input.url ?? ""})
Version: ${input.version}

## Page markdown
Interactive elements appear as [label text](tag:NUMERIC_ID).
Use candidate text/dom_path below as primary evidence; markdown is supporting context only.

${input.markdown.slice(0, 4000)}
${hintBlock}
## Candidates (evaluate ONLY these tag_ids)
${candidateList}

Return ONLY valid JSON (no markdown fences):
{"page_category":"페이지명(예: 메인/정품등록)","suggestions":[{"tag_id":number,"event_name":"기존이름 또는 재사용할 이름","category":"화면 영역명(예: 배너/추천 상품/global/gnb)","label":"개별 표시명(상품명·탭명·버튼 텍스트)","merge_label":"택소노미 묶기 키(반복 버튼·상품상세 등)","parameters":[{"name":"direction","value_hint":"next"}],"new_event_name":"새 이름(선택)","new_event_reason":"이유(새 이름일 때만)","rationale":"brief"}]}

트리 구조: page_category(페이지명) → category(영역명) → label(버튼). page_category와 category를 혼동하지 말 것 — page_category=페이지 자체 이름, category=그 페이지 안의 화면 영역.
page_category: 매 배치마다 최상위에 페이지명(예: 메인, 정품등록)을 반환하라. 위 Page/Page context의 URL·title을 근거로 판단.

category rules — category는 "화면 영역명"이다 (페이지명 아님; 페이지명은 page_category) (code provides landmark, dom_path, parent_labels, section):
- landmark=gnb + site-wide header nav → category="global/gnb", event_name usually "클릭" (candidate에 landmark="gnb(GNB)"처럼 원본 표기가 있어도 절대 그대로 쓰지 말고 반드시 "global/gnb"로 정규화)
- landmark=fnb → category="global/fnb", event_name usually "클릭" (원본 표기 그대로 쓰지 말고 반드시 "global/fnb"로 정규화)
- 콘텐츠 영역 → section 제목·parent_labels 기준 한글 category (예: "배너", "추천 상품")
- 같은 section(코드가 section="..." 으로 제공) 아래 모든 요소는 동일한 category 문자열을 사용 — 공백·"리스트" 등 표현 차이로 갈라지지 말 것
- 공지/FAQ가 GNB 부모(고객지원) 안이면 FNB가 아닌 해당 GNB 하위

event_name hints:
- 일반 링크/버튼 이동 → "클릭"
- 캐러셀/배너 이전·다음/도트 → "배너이동" (도트는 label="도트"로 통일) + parameters direction when prev/next
- 캐러셀/배너 슬라이드 본체(클릭 시 캠페인/상품 페이지로 이동하는 링크) → "클릭" (배너이동과 반드시 별도 suggestion으로 출력, 흡수·생략 금지)
- 찜/하트 → "찜하기"

parameters (ONLY these optional keys from LLM):
- direction: "prev" or "next" (배너이동 only)
Do NOT put category, label, link_url, platform in parameters — server adds those.

${LLM_LABEL_RULE_BLOCK}

${LLM_MERGE_LABEL_RULE_BLOCK}

${LLM_BANNER_RULE_BLOCK}

${LLM_NAME_STABILITY_BLOCK}

${LLM_CONSISTENT_GROUPING_BLOCK}

${LLM_DEPTH_RULE_BLOCK}

CRITICAL:
- Return exactly ${candidates.length} suggestions — one per tag_id.
- Every suggestion MUST include event_name, category(영역명), label, merge_label. 최상위 page_category(페이지명)도 반드시 포함.
- Reuse registry names whenever possible; new_event_name only when truly new.
${llmExactCountWithDedupHint(candidates.length)}`;
}

function buildPageContextPromptBlock(input: SnapshotLlmInput): string {
  const ctx = input.pageContext;
  if (!ctx) return "";

  const hint = input.pageCategoryHint ?? "";
  const lines = [
    "## Page context (code-collected)",
    `page_location="${ctx.page_location}"`,
    `page_path="${ctx.page_path}"`,
    `page_title="${ctx.page_title}"`,
    `page_referrer="${ctx.page_referrer || ""}"`,
  ];
  if (hint) lines.push(`page_category_hint="${hint}"`);
  if (input.includePageCategory !== false) {
    lines.push(
      "Set top-level page_category = 이 페이지의 페이지명 (Korean page name, 예: 메인/정품등록). 영역명(배너/gnb 등)이 아니라 페이지 자체 이름. 매 배치마다 반환."
    );
  }
  return `\n${lines.join("\n")}\n`;
}

export interface ExtractLlmParseResult {
  suggestions: SnapshotSuggestion[];
  page_category?: string;
}

export function parseExtractLlmResponse(
  text: string,
  registry?: import("@autotag/shared").EventRegistry
): ExtractLlmParseResult {
  const stripped = stripJsonFence(text);
  if (!stripped) {
    throw new Error("empty LLM response body");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`JSON parse failed (len=${stripped.length}): ${msg}`);
  }

  let page_category: string | undefined;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.page_category === "string" && obj.page_category.trim()) {
      page_category = obj.page_category.trim();
    }
  }

  return {
    suggestions: filterValidSuggestions(coerceSuggestionArray(parsed), registry),
    page_category,
  };
}

export function parseExtractSuggestionsStrict(text: string): SnapshotSuggestion[] {
  return parseExtractLlmResponse(text).suggestions;
}

export type LlmErrorKind = "TRUNCATED" | "RETRYABLE_ERROR" | "FATAL";

export function classifyLlmCallError(
  error: Error,
  text?: string,
  finishReason?: string | null
): LlmErrorKind {
  const msg = error.message.toLowerCase();

  if (finishReason === "length") return "TRUNCATED";
  if (msg.includes("unexpected end of json input")) return "TRUNCATED";
  if (msg.includes("unterminated string")) return "TRUNCATED";
  if (msg.includes("response truncated")) return "TRUNCATED";
  if (text && looksLikeTruncatedJson(text)) return "TRUNCATED";

  if (
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes(" 500") ||
    msg.includes(" 502") ||
    msg.includes(" 503") ||
    msg.includes(" 504") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up")
  ) {
    return "RETRYABLE_ERROR";
  }

  if (msg.includes("openrouter") && msg.includes("after retries")) return "RETRYABLE_ERROR";

  return "FATAL";
}

function looksLikeTruncatedJson(text: string): boolean {
  const stripped = stripJsonFence(text).trim();
  if (!stripped.startsWith("{") && !stripped.startsWith("[")) return false;
  try {
    JSON.parse(stripped);
    return false;
  } catch {
    const openBraces = (stripped.match(/\{/g) ?? []).length;
    const closeBraces = (stripped.match(/\}/g) ?? []).length;
    const openBrackets = (stripped.match(/\[/g) ?? []).length;
    const closeBrackets = (stripped.match(/\]/g) ?? []).length;
    return openBraces > closeBraces || openBrackets > closeBrackets;
  }
}

function coerceSuggestionArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of ["suggestions", "results", "items", "candidates", "data"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  throw new Error("LLM response is not an array or {suggestions:[...]} object");
}

function filterValidSuggestions(
  rows: unknown[],
  registry?: import("@autotag/shared").EventRegistry
): SnapshotSuggestion[] {
  const out: SnapshotSuggestion[] = [];
  for (const row of rows) {
    const normalized = normalizeSnapshotSuggestion(row, { registry });
    if (normalized) out.push(normalized);
  }
  return out;
}

function logExtractLlmRaw(opts: {
  rangeLabel: string;
  splitDepth: number;
  attempt: number;
  candidateCount: number;
  finishReason: string | null;
  text: string;
  model: string;
}): void {
  const previewHead = opts.text.slice(0, 120).replace(/\s+/g, " ");
  const previewTail = opts.text.slice(-120).replace(/\s+/g, " ");
  const debug = process.env.AUTOTAG_PIPELINE_DEBUG === "1" || process.env.EXTRACT_LLM_DEBUG === "1";

  console.log(
    `[autotag] extract LLM raw range=${opts.rangeLabel} depth=${opts.splitDepth} attempt=${opts.attempt} ` +
      `candidates=${opts.candidateCount} model=${opts.model} len=${opts.text.length} ` +
      `finish_reason=${opts.finishReason ?? "unknown"} head="${previewHead}" tail="${previewTail}"`
  );

  if (debug) {
    console.log("[autotag] extract LLM raw full body:", opts.text);
  }
}

function stripJsonFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}
