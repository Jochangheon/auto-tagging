import type { PageNode, TaxonomyDescriptionsRegistry } from "@autotag/shared";
import {
  EVENT_PARAM,
  TAXONOMY_COMMON_VARIABLES,
  buildUniqueEventRowKey,
} from "@autotag/shared";
import { collectTaxonomyRowsForDescribe } from "../taxonomy/taxonomy-builder.js";
import { resolveLlmProviderStrict } from "./client.js";
import { generateGeminiText, getGeminiApiKey } from "./gemini.js";
import { callOpenRouterDetailed } from "./openrouter.js";

export interface DescribeTaxonomyInput {
  pages: PageNode[];
  selection: Record<string, boolean>;
  llm_model?: string;
}

export interface DescribeTaxonomyResult {
  registry: TaxonomyDescriptionsRegistry;
  created_events: number;
  created_properties: number;
}

interface RowDocSpec {
  row_key: string;
  page_category: string;
  event_name: string;
  category: string;
  action: string;
  label: string;
  member_count: number;
}

/** Keep each batch small enough that 8192 output tokens can finish valid JSON. */
const DESCRIBE_BATCH_SIZE = Math.max(
  5,
  Number.parseInt(process.env.TAXONOMY_DESCRIBE_BATCH_SIZE ?? "20", 10) || 20
);
const DESCRIBE_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.TAXONOMY_DESCRIBE_CONCURRENCY ?? "3", 10) || 3
);
const DESCRIBE_MAX_TOKENS = Math.max(
  2048,
  Number.parseInt(process.env.TAXONOMY_DESCRIBE_MAX_TOKENS ?? "8192", 10) || 8192
);

function buildRowSpecs(
  pages: PageNode[],
  selection: Record<string, boolean>
): RowDocSpec[] {
  const rows = collectTaxonomyRowsForDescribe(pages, selection);
  return rows.map((row) => {
    const row_key = buildUniqueEventRowKey(
      row.page_category,
      row.event_name,
      row.category_display,
      row.action_display,
      row.label,
      row.direction
    );

    return {
      row_key,
      page_category: row.page_category,
      event_name: row.event_name,
      category: row.category_display,
      action: row.action_display,
      label: row.label,
      member_count: row.members.length,
    };
  });
}

function paramNamesForDescribe(): string[] {
  return [
    ...TAXONOMY_COMMON_VARIABLES,
    EVENT_PARAM.CATEGORY,
    EVENT_PARAM.ACTION,
    EVENT_PARAM.LABEL,
    EVENT_PARAM.PAGE_NAME,
  ];
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function compactRowSpecs(rowSpecs: RowDocSpec[]): unknown[] {
  // Drop verbose fields from the prompt — LLM only needs identity + context.
  return rowSpecs.map((r) => ({
    row_key: r.row_key,
    page_category: r.page_category,
    event_name: r.event_name,
    category: r.category,
    action: r.action,
    label: r.label,
    member_count: r.member_count,
  }));
}

function buildDescribePrompt(
  rowSpecs: RowDocSpec[],
  paramNames: string[] | null,
  batchLabel: string
): string {
  const rowsJson = JSON.stringify(compactRowSpecs(rowSpecs));
  const paramsBlock =
    paramNames && paramNames.length
      ? `\n## 파라미터 이름 목록\n${JSON.stringify(paramNames)}\n`
      : "";

  const propertiesRule = paramNames?.length
    ? `### properties (파라미터명 → description / note)
- 각 파라미터가 이벤트 payload에서 의미하는 바를 한국어로 설명.
- note에 수집 규칙·형식·예외가 있으면 기재, 없으면 "-".
- 위 파라미터 목록의 **모든** 이름을 properties에 포함.`
    : `### properties
- 이 배치에서는 properties를 빈 객체 {} 로 두세요. (다른 배치에서 작성됨)`;

  return `당신은 디지털 분석 택소노미 문서 작성 전문가입니다.
배치: ${batchLabel} — 아래 태깅 포인트만 문서화하세요 (${rowSpecs.length}건).

## 태깅 포인트 (row_key별 1건)
${rowsJson}
${paramsBlock}
## 작성 규칙 (반드시 준수)

### events (row_key → trigger / description / note)
- **이 배치의 모든 row_key**에 대해 trigger, description, note를 작성하세요. 누락 금지.
- trigger(발생 시점): 해당 UI 요소를 사용자가 **실제로 조작·노출하는 순간**을 한국어로 구체적으로 기술.
  - page_category, category, action, label을 반드시 반영. (페이지뷰는 page_category·page_name만 반영, 카/액/라 없음)
  - 금지: "GNB 등 클릭", "메인에서 클릭 발생 시", "버튼 클릭 시"처럼 상투적 문장.
  - 좋은 예: "메인 페이지 상단 GNB에서 '로그인' 텍스트 링크를 클릭했을 때"
  - 페이지뷰 예: "입사지원 페이지가 로드·노출되었을 때"
- description(설명): 이 이벤트가 측정하는 사용자 행동·노출을 1~2문장으로 설명.
- note(비고): 태깅 시 주의사항. 없으면 "-".
- trigger/description/note는 각각 120자 이내로 짧게 작성 (JSON이 잘리지 않도록).

${propertiesRule}

## 출력 형식
마크다운·코드블록·설명 없이 **순수 JSON만** 출력.

{"descriptions":{"events":{"<row_key>":{"trigger":"...","description":"...","note":"..."}},"properties":{}}}`;
}

/** Best-effort repair when the model hits max_tokens mid-JSON. */
function repairTruncatedJson(raw: string): string | null {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  }
  const start = s.indexOf("{");
  if (start < 0) return null;
  s = s.slice(start);

  try {
    JSON.parse(s);
    return s;
  } catch {
    /* continue */
  }

  // Close open strings / objects / arrays from the truncated tail.
  let inString = false;
  let escape = false;
  const stack: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
    }
  }

  let repaired = s;
  if (inString) repaired += '"';
  // Drop a trailing incomplete key/value fragment after last complete comma/brace.
  repaired = repaired.replace(/,\s*"[^"]*$/, "");
  repaired = repaired.replace(/,\s*$/, "");
  while (stack.length) repaired += stack.pop();

  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  const start = candidate.indexOf("{");
  if (start < 0) {
    throw new Error("taxonomy-describe: LLM 응답에서 JSON을 찾을 수 없습니다");
  }
  const slice = candidate.slice(start);

  try {
    return JSON.parse(slice);
  } catch {
    const repaired = repairTruncatedJson(slice);
    if (repaired) {
      console.warn("[taxonomy-desc] repaired truncated JSON");
      return JSON.parse(repaired);
    }
    throw new Error("taxonomy-describe: LLM 응답 JSON 파싱 실패");
  }
}

function parseDescribeResponse(
  raw: string,
  expectedRowKeys: string[],
  expectedParams: string[] | null,
  opts?: { allowPartial?: boolean }
): TaxonomyDescriptionsRegistry {
  const parsed = extractJsonObject(raw) as { descriptions?: TaxonomyDescriptionsRegistry };
  const descriptions = parsed.descriptions;
  if (!descriptions?.events) {
    throw new Error("taxonomy-describe: descriptions.events 누락");
  }
  if (!descriptions.properties) {
    descriptions.properties = {};
  }

  const missingRows = expectedRowKeys.filter((k) => !descriptions.events[k]?.trigger?.trim());
  const missingParams = (expectedParams ?? []).filter(
    (p) => !descriptions.properties[p]?.description?.trim()
  );

  if (!opts?.allowPartial && (missingRows.length || missingParams.length)) {
    const parts: string[] = [];
    if (missingRows.length) {
      parts.push(`events 누락(${missingRows.length}): ${missingRows.slice(0, 5).join(", ")}`);
    }
    if (missingParams.length) {
      parts.push(`properties 누락: ${missingParams.join(", ")}`);
    }
    throw new Error(`taxonomy-describe: ${parts.join("; ")}`);
  }

  if (opts?.allowPartial && missingRows.length) {
    console.warn(
      `[taxonomy-desc] partial batch missing ${missingRows.length} events — will retry those keys`
    );
  }

  return {
    events: descriptions.events,
    properties: descriptions.properties,
  };
}

async function callDescribeLlm(prompt: string, model?: string): Promise<{ text: string; finishReason: string | null }> {
  const provider = resolveLlmProviderStrict();

  const systemPrompt =
    "당신은 디지털 분석 택소노미 문서 작성 전문가입니다. 반드시 유효한 JSON만 출력하세요. 응답을 중간에 끊지 마세요.";

  if (provider === "openrouter") {
    const result = await callOpenRouterDetailed(systemPrompt, prompt, true, {
      temperature: 0.2,
      maxTokens: DESCRIBE_MAX_TOKENS,
      model,
    });
    return { text: result.text, finishReason: result.finishReason };
  }

  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error("taxonomy-describe: GEMINI_API_KEY 가 설정되지 않았습니다");
  const text = await generateGeminiText(apiKey, systemPrompt, prompt, {
    json: true,
    temperature: 0.2,
    maxOutputTokens: DESCRIBE_MAX_TOKENS,
  });
  return { text, finishReason: null };
}

async function describeBatch(
  rowSpecs: RowDocSpec[],
  paramNames: string[] | null,
  batchLabel: string,
  model?: string
): Promise<TaxonomyDescriptionsRegistry> {
  const expectedKeys = rowSpecs.map((r) => r.row_key);
  const prompt = buildDescribePrompt(rowSpecs, paramNames, batchLabel);

  const runOnce = async (
    extra = ""
  ): Promise<{ registry: TaxonomyDescriptionsRegistry; finishReason: string | null }> => {
    const { text, finishReason } = await callDescribeLlm(prompt + extra, model);
    if (finishReason === "length") {
      console.warn(`[taxonomy-desc] ${batchLabel} finish_reason=length — attempting repair/parse`);
    }
    const registry = parseDescribeResponse(text, expectedKeys, paramNames, {
      allowPartial: true,
    });
    return { registry, finishReason };
  };

  const fillMissing = async (
    base: TaxonomyDescriptionsRegistry
  ): Promise<TaxonomyDescriptionsRegistry> => {
    const missing = expectedKeys.filter((k) => !base.events[k]?.trigger?.trim());
    if (!missing.length) return base;
    console.warn(`[taxonomy-desc] ${batchLabel} retrying ${missing.length} missing keys`);
    const retrySpecs = rowSpecs.filter((r) => missing.includes(r.row_key));
    const retryPrompt = buildDescribePrompt(retrySpecs, null, `${batchLabel}-retry`);
    const { text } = await callDescribeLlm(retryPrompt, model);
    const second = parseDescribeResponse(
      text,
      retrySpecs.map((r) => r.row_key),
      null,
      { allowPartial: true }
    );
    return {
      events: { ...base.events, ...second.events },
      properties: { ...base.properties, ...second.properties },
    };
  };

  try {
    const { registry: first } = await runOnce();
    return await fillMissing(first);
  } catch (err) {
    console.warn(`[taxonomy-desc] ${batchLabel} failed, retrying once:`, err);
    const { registry: second } = await runOnce(
      `\n\n## 재시도\n이전 응답이 잘리거나 형식 오류였습니다. 이 배치 row_key ${expectedKeys.length}개만 짧게 작성하고 완전한 JSON을 닫으세요.`
    );
    return await fillMissing(second);
  }
}

class ConcurrencyPool {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

function mergeRegistries(parts: TaxonomyDescriptionsRegistry[]): TaxonomyDescriptionsRegistry {
  const events: TaxonomyDescriptionsRegistry["events"] = {};
  const properties: TaxonomyDescriptionsRegistry["properties"] = {};
  for (const part of parts) {
    Object.assign(events, part.events);
    Object.assign(properties, part.properties);
  }
  return { events, properties };
}

export async function describeTaxonomyForCandidates(
  input: DescribeTaxonomyInput
): Promise<DescribeTaxonomyResult> {
  const rowSpecs = buildRowSpecs(input.pages, input.selection);
  const paramNames = paramNamesForDescribe();
  const expectedRowKeys = rowSpecs.map((r) => r.row_key);

  const emptyRegistry: TaxonomyDescriptionsRegistry = { events: {}, properties: {} };

  if (!rowSpecs.length) {
    console.log("[taxonomy-desc] no label rows — skip LLM");
    return { registry: emptyRegistry, created_events: 0, created_properties: 0 };
  }

  const batches = chunkArray(rowSpecs, DESCRIBE_BATCH_SIZE);
  console.log(
    `[taxonomy-desc] LLM call rows=${rowSpecs.length} params=${paramNames.length} ` +
      `batches=${batches.length} size≤${DESCRIBE_BATCH_SIZE} concurrency=${DESCRIBE_CONCURRENCY}`
  );

  const pool = new ConcurrencyPool(DESCRIBE_CONCURRENCY);
  const parts = await Promise.all(
    batches.map((batch, i) =>
      pool.run(() =>
        describeBatch(
          batch,
          // Properties only on the first batch — avoids repeating 11 params × N batches.
          i === 0 ? paramNames : null,
          `batch ${i + 1}/${batches.length}`,
          input.llm_model
        )
      )
    )
  );

  let registry = mergeRegistries(parts);

  // Final pass for any still-missing event keys (small leftover batches).
  let stillMissing = expectedRowKeys.filter((k) => !registry.events[k]?.trigger?.trim());
  if (stillMissing.length) {
    console.warn(`[taxonomy-desc] final pass for ${stillMissing.length} missing events`);
    const leftover = rowSpecs.filter((r) => stillMissing.includes(r.row_key));
    for (const chunk of chunkArray(leftover, Math.min(10, DESCRIBE_BATCH_SIZE))) {
      const part = await describeBatch(chunk, null, `final/${chunk.length}`, input.llm_model);
      registry = mergeRegistries([registry, part]);
    }
    stillMissing = expectedRowKeys.filter((k) => !registry.events[k]?.trigger?.trim());
  }

  const missingParams = paramNames.filter((p) => !registry.properties[p]?.description?.trim());
  if (missingParams.length) {
    console.warn(`[taxonomy-desc] properties pass for ${missingParams.length} params`);
    const propPrompt = `당신은 디지털 분석 택소노미 문서 작성 전문가입니다.
아래 파라미터 각각에 대해 description / note를 한국어로 작성하세요.
파라미터: ${JSON.stringify(missingParams)}
규칙: description은 이벤트 payload에서의 의미, note는 수집 규칙(없으면 "-"). 각 필드는 80자 이내.
순수 JSON만 출력:
{"descriptions":{"events":{},"properties":{"<name>":{"description":"...","note":"..."}}}}`;
    const { text } = await callDescribeLlm(propPrompt, input.llm_model);
    const propPart = parseDescribeResponse(text, [], missingParams);
    registry = mergeRegistries([registry, propPart]);
  }

  stillMissing = expectedRowKeys.filter((k) => !registry.events[k]?.trigger?.trim());
  const stillMissingParams = paramNames.filter((p) => !registry.properties[p]?.description?.trim());
  if (stillMissing.length || stillMissingParams.length) {
    const partsMsg: string[] = [];
    if (stillMissing.length) {
      partsMsg.push(`events 누락(${stillMissing.length}): ${stillMissing.slice(0, 8).join(", ")}`);
    }
    if (stillMissingParams.length) {
      partsMsg.push(`properties 누락: ${stillMissingParams.join(", ")}`);
    }
    throw new Error(`taxonomy-describe: ${partsMsg.join("; ")}`);
  }

  console.log(
    `[taxonomy-desc] done events=${Object.keys(registry.events).length} properties=${Object.keys(registry.properties).length}`
  );

  return {
    registry,
    created_events: Object.keys(registry.events).length,
    created_properties: Object.keys(registry.properties).length,
  };
}
