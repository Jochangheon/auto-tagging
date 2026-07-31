import type { TaggingEvent, SnapshotSuggestion } from "@autotag/shared";
import {
  getLlmModelLabel,
  normalizeSnapshotSuggestion,
  resolveLlmModelId,
  resolveOpenRouterSlug,
  formatDomPathPromptFields,
  LLM_CONSISTENT_GROUPING_BLOCK,
  LLM_DEPTH_RULE_BLOCK,
  LLM_LABEL_RULE_BLOCK,
  LLM_BANNER_RULE_BLOCK,
  LLM_NAME_STABILITY_BLOCK,
  llmExactCountWithDedupHint,
} from "@autotag/shared";
import type { ExtractLlmResult, LlmProvider, SnapshotLlmInput } from "./types.js";
import { runExtractLlmAdaptive, type ExtractLlmAdaptiveOptions } from "./extract-llm-batch.js";
import { loadEventRegistry, applySuggestionsToEventRegistry } from "./event-registry-store.js";
import { callOpenRouter, getOpenRouterApiKey, fetchOpenRouterCreditUsage } from "./openrouter.js";
import { generateGeminiText, getGeminiApiKey } from "./gemini.js";

export type { ExtractDroppedCandidate, ExtractLlmBatchMeta, ExtractLlmResult, LlmProvider, PipelineStageCounts, SnapshotLlmInput } from "./types.js";
export { runExtractLlmAdaptive, readExtractLlmConfig, type ExtractLlmAdaptiveOptions } from "./extract-llm-batch.js";

const SNAPSHOT_SYSTEM_PROMPT =
  "You are an analytics tagging assistant for e-commerce and SPA sites. Return only valid JSON arrays for analytics event naming.";

/** Resolve configured LLM provider (requires API key). */
export function resolveLlmProvider(): LlmProvider {
  return resolveLlmProviderStrict();
}

/** Wave 4 strict path — requires configured LLM provider. */
export function resolveLlmProviderStrict(): LlmProvider {
  const forced = process.env.LLM_PROVIDER?.trim().toLowerCase();

  if (forced === "mock") {
    throw new Error(
      "LLM_PROVIDER=mock is no longer supported — set openrouter or gemini with an API key in packages/backend/.env"
    );
  }

  if (forced === "gemini") {
    if (!getGeminiApiKey()) {
      throw new Error("LLM provider gemini requested but GEMINI_API_KEY missing");
    }
    return "gemini";
  }

  if (forced === "openrouter" || !forced) {
    if (!getOpenRouterApiKey()) {
      throw new Error(
        "LLM provider openrouter requested but OPENROUTER_API_KEY missing — set key in packages/backend/.env"
      );
    }
    return "openrouter";
  }

  if (getOpenRouterApiKey()) return "openrouter";
  if (getGeminiApiKey()) return "gemini";

  throw new Error("No LLM provider configured — set LLM_PROVIDER and API key in packages/backend/.env");
}

export interface EventNameResult {
  event_name: string;
  parameters: { name: string; value_hint: string | null }[];
}

export function getLlmHealthStatus(): {
  llm_provider: LlmProvider | "unconfigured";
  llm_model: string;
  llm_model_label: string;
  llm_model_id: string;
  openrouter: boolean;
  gemini: boolean;
} {
  let llm_provider: LlmProvider | "unconfigured" = "unconfigured";
  try {
    llm_provider = resolveLlmProvider();
  } catch {
    llm_provider = "unconfigured";
  }
  const llm_model_id = resolveLlmModelId();
  const llm_model = resolveOpenRouterSlug();
  return {
    llm_provider,
    llm_model,
    llm_model_id,
    llm_model_label: getLlmModelLabel(llm_model_id),
    openrouter: Boolean(getOpenRouterApiKey()),
    gemini: Boolean(getGeminiApiKey()),
  };
}

export interface LlmCreditUsage {
  provider: LlmProvider;
  model_label: string;
  remaining: number | null;
  total_credits?: number;
  total_usage?: number;
  usage_daily?: number;
  source?: "credits" | "key";
  error?: string;
}

/** LLM provider credit / limit snapshot for dev UI. */
export async function fetchLlmCreditUsage(): Promise<LlmCreditUsage> {
  const health = getLlmHealthStatus();

  if (health.llm_provider === "unconfigured") {
    return {
      provider: "openrouter",
      model_label: health.llm_model_label,
      remaining: null,
      error: "LLM API key not configured",
    };
  }

  if (health.llm_provider === "gemini") {
    return {
      provider: "gemini",
      model_label: health.llm_model_label,
      remaining: null,
      error: "gemini balance API not configured",
    };
  }

  const usage = await fetchOpenRouterCreditUsage();
  return {
    provider: "openrouter",
    model_label: health.llm_model_label,
    remaining: usage.remaining,
    total_credits: usage.total_credits,
    total_usage: usage.total_usage,
    usage_daily: usage.usage_daily,
    source: usage.source,
    error: usage.error,
  };
}

interface GenerateLlmTextOptions {
  json?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
}

async function generateLlmText(
  systemPrompt: string,
  userPrompt: string,
  opts: GenerateLlmTextOptions & { llm_model?: string } = {}
): Promise<string> {
  const provider = resolveLlmProvider();

  if (provider === "openrouter") {
    return callOpenRouter(systemPrompt, userPrompt, opts.json ?? false, {
      temperature: opts.temperature,
      maxTokens: opts.maxOutputTokens,
      model: opts.llm_model,
    });
  }

  if (provider === "gemini") {
    const apiKey = getGeminiApiKey();
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");
    return generateGeminiText(apiKey, systemPrompt, userPrompt, opts);
  }

  throw new Error("No LLM provider configured");
}

export async function analyzeSnapshotWithLlm(
  input: SnapshotLlmInput
): Promise<SnapshotSuggestion[]> {
  return callSnapshotLlm(input);
}

/** Wave 4 extract pipeline — strict LLM, surfaces llm_source. */
export async function analyzeExtractWithLlm(
  input: SnapshotLlmInput,
  opts: ExtractLlmAdaptiveOptions = {}
): Promise<ExtractLlmResult> {
  const provider = resolveLlmProviderStrict();

  const registry = loadEventRegistry();

  const { suggestions, meta, page_category } = await runExtractLlmAdaptive(
    { ...input, eventRegistry: registry },
    provider,
    opts
  );
  applySuggestionsToEventRegistry(registry, suggestions);
  return { suggestions, llm_source: provider, meta, page_category };
}

export async function nameEventsWithLlm(
  events: TaggingEvent[],
  model?: string
): Promise<Map<string, EventNameResult>> {
  const result = new Map<string, EventNameResult>();
  const provider = resolveLlmProvider();
  if (events.length === 0) return result;

  const eventList = events
    .map(
      (e) =>
        `stable_key=${e.stable_key} type=${e.event_type} tag=${e.dom_signals.tag} text="${e.dom_signals.text ?? ""}" selector="${e.ui_target.selector_hint}"`
    )
    .join("\n");

  const userPrompt = `You are an analytics tagging assistant. Name these interaction events for GA4/unified-v1.

Return ONLY a valid JSON array (no markdown fences):
[{"stable_key": "...", "event_name": "snake_case", "parameters": [{"name": "param", "value_hint": "hint or null"}]}]

Naming rules:
- lowercase snake_case
- click events: prefix click_ (e.g. click_add_to_cart, click_nav_menu)
- use dom text/selector context for specificity
- skip decorative or duplicate names

Events:
${eventList}`;

  try {
    const text = await generateLlmText(
      "You name analytics events using unified-v1 snake_case conventions. Return JSON only.",
      userPrompt,
      { json: true, llm_model: model }
    );
    const parsed = JSON.parse(stripJsonFence(text)) as (EventNameResult & { stable_key: string })[];

    if (!Array.isArray(parsed)) return result;

    for (const row of parsed) {
      if (
        typeof row.stable_key === "string" &&
        typeof row.event_name === "string" &&
        row.event_name.length > 0
      ) {
        result.set(row.stable_key, {
          event_name: row.event_name,
          parameters: Array.isArray(row.parameters) ? row.parameters : [],
        });
      }
    }
  } catch (err) {
    console.warn(`[autotag] ${provider} event naming failed`, err);
  }

  return result;
}

async function callSnapshotLlm(input: SnapshotLlmInput): Promise<SnapshotSuggestion[]> {
  const text = await callSnapshotLlmRaw(input);
  return parseSnapshotSuggestions(text);
}

async function callSnapshotLlmRaw(
  input: SnapshotLlmInput,
  opts: { extractMode?: boolean } = {}
): Promise<string> {
  return generateLlmText(SNAPSHOT_SYSTEM_PROMPT, await buildSnapshotUserPrompt(input, opts), {
    json: true,
    llm_model: input.llm_model,
  });
}

async function buildSnapshotUserPrompt(
  input: SnapshotLlmInput,
  opts: { extractMode?: boolean; batchNum?: number; batchTotal?: number } = {}
): Promise<string> {
  const candidateList = input.candidates
    .map(
      (c) =>
        `tag_id=${c.tag_id} name="${c.accessible_name}" tag=${c.tag} hidden=${c.hidden_in_dom}${formatDomPathPromptFields(c.dom_path)} reason=${c.reason ?? "ambiguous"}`
    )
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

  const jsonShape = opts.extractMode
    ? `{"suggestions":[{"tag_id":number,"category":"region/path","action":"snake_case_action","label":"visible text","parameters":[{"name":"param_name","value_hint":"hint or null"}],"rationale":"brief reason"}]}`
    : `[{"tag_id": number, "category": "region/path", "action": "snake_case_action", "label": "visible text", "parameters": [{"name": "param_name", "value_hint": "hint or null"}]}]`;

  const batchLine =
    opts.extractMode && opts.batchNum && opts.batchTotal && opts.batchTotal > 1
      ? `\nBatch ${opts.batchNum} of ${opts.batchTotal} — name ONLY the tag_ids listed below.\n`
      : "";

  const candidateHeading = opts.extractMode
    ? "## Candidates (evaluate ONLY these tag_ids)"
    : "## Ambiguous candidates (evaluate ONLY these tag_ids)";

  const jobLine = opts.extractMode
    ? "Your job: pick genuine click/interaction analytics targets from interactive candidates."
    : "Your job: pick genuine click/interaction analytics targets from AMBIGUOUS candidates only.";

  const returnShapeLine = opts.extractMode
    ? "Return ONLY a valid JSON object (no markdown fences, no commentary):"
    : "Return ONLY a valid JSON array (no markdown fences, no commentary):";

  return `${jobLine}${batchLine}

Page: ${input.stageTitle ?? "unknown"} (${input.url ?? ""})
Version: ${input.version}

## Page markdown
Interactive elements appear as [label text](tag:NUMERIC_ID). Use tag_id from these links or the candidate list below.

${input.markdown.slice(0, 4000)}
${hintBlock}
${candidateHeading}
${candidateList}

${returnShapeLine}
${jsonShape}

Naming rules:
- category와 label은 반드시 한글로 작성. 화면 구조상 자연스러운 단어 사용 (예: "배너", "추천 상품").
- category는 dom_path·parent_labels·section 부모 구조와 화면 위치를 근거로 정하라. 단어 의미만으로 추측하지 말 것.
- GNB 상위 메뉴(예: 고객지원) 하위 링크(공지사항/FAQ 등)는 footer가 아니라 global/gnb 하위로 분류.
- category: 화면 영역 (global/gnb, global/fnb는 사이트 전역 네비 — 콘텐츠 캐러셀/슬라이더는 "배너" 또는 "메인 배너")
- GNB/FNB 통일: global/gnb 영역 전부 → category="global/gnb", action="click_gnb". global/fnb 전부 → category="global/fnb", action="click_fnb". label만 항목별로 다르게.
- 배너/슬라이드 이전·다음·도트: 동일 category + action="slide_nav". label만 "이전"/"다음" 등으로 구분. hero_prev 등 개별 action 금지.
- 찜/하트 아이콘: 동일 섹션 category + action="add_wishlist".
- action: snake_case interaction (add_to_cart, navigate, view_detail) — GNB/FNB·slide_nav·add_wishlist는 위 통일 action 사용
- label: 버튼 기능 최우선. 반복 액션은 "기능 (맥락)" 형식 (예: "찜하기 (상품명)", "장바구니 담기 (상품명)"). 텍스트 링크는 화면 텍스트 사용 가능.
- event_name is derived server-side from category + action — do NOT include it
- parameters: optional contextual hints (item_name, category_name, menu_section, link_url)${opts.extractMode ? `
- rationale: one short sentence` : ""}

${LLM_BANNER_RULE_BLOCK}

${LLM_LABEL_RULE_BLOCK}

${LLM_NAME_STABILITY_BLOCK}

${LLM_CONSISTENT_GROUPING_BLOCK}

${LLM_DEPTH_RULE_BLOCK}

${opts.extractMode ? llmExactCountWithDedupHint(input.candidates.length) : "Output tag_ids MUST come from the candidate list. Omit candidates that are not real analytics targets."}`;
}

function parseSnapshotSuggestions(text: string): SnapshotSuggestion[] {
  return filterValidSuggestions(coerceSuggestionArray(parseJsonValue(text)));
}

function parseJsonValue(text: string): unknown {
  const stripped = stripJsonFence(text);
  if (!stripped) throw new Error("empty LLM response body");
  return JSON.parse(stripped);
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

function filterValidSuggestions(rows: unknown[]): SnapshotSuggestion[] {
  const out: SnapshotSuggestion[] = [];
  for (const row of rows) {
    const normalized = normalizeSnapshotSuggestion(row);
    if (normalized) out.push(normalized);
  }
  return out;
}

function stripJsonFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}
