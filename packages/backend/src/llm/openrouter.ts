import { resolveOpenRouterSlug } from "@autotag/shared";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterOptions {
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** UI model id or OpenRouter slug */
  model?: string;
}

export function getOpenRouterApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY?.trim() || undefined;
}

export interface OpenRouterCallResult {
  text: string;
  finishReason: string | null;
  model: string;
}

export async function callOpenRouter(
  systemPrompt: string,
  userPrompt: string,
  jsonMode = false,
  opts: Omit<OpenRouterOptions, "jsonMode"> = {}
): Promise<string> {
  const result = await callOpenRouterDetailed(systemPrompt, userPrompt, jsonMode, opts);
  return result.text;
}

export async function callOpenRouterDetailed(
  systemPrompt: string,
  userPrompt: string,
  jsonMode = false,
  opts: Omit<OpenRouterOptions, "jsonMode"> = {}
): Promise<OpenRouterCallResult> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY missing");
  }

  const referer = process.env.OPENROUTER_HTTP_REFERER?.trim() || "https://auto-tagging.local";
  const title = process.env.OPENROUTER_X_TITLE?.trim() || "Auto Tagging System";
  const model = resolveOpenRouterSlug(opts.model);

  const bodyBase = {
    messages: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 4096,
    ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": title,
      },
      body: JSON.stringify({ ...bodyBase, model }),
    });

    if (res.status === 429) {
      const waitMs = Math.min(8000, 1000 * 2 ** attempt);
      console.warn(`[autotag] OpenRouter ${model} rate limited — retry in ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    if (res.status === 404) {
      lastError = new Error(`OpenRouter model not found: ${model}`);
      break;
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenRouter ${model} ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };

    const choice = data.choices?.[0];
    const text = choice?.message?.content?.trim() ?? "";
    const finishReason = choice?.finish_reason ?? null;

    if (!text) {
      throw new Error(`OpenRouter ${model} returned empty response`);
    }

    if (attempt === 0) {
      console.log(
        `[autotag] OpenRouter OK model=${model} len=${text.length} finish_reason=${finishReason ?? "unknown"}`
      );
    }

    return { text, finishReason, model };
  }

  throw lastError ?? new Error("OpenRouter request failed after retries");
}

/**
 * Multimodal chat: text + image URL (e.g. annotated screenshot for position QA).
 * Uses OpenAI-compatible content parts on OpenRouter.
 */
export async function callOpenRouterVision(
  systemPrompt: string,
  userText: string,
  imageUrl: string,
  opts: Omit<OpenRouterOptions, "jsonMode"> & { jsonMode?: boolean } = {}
): Promise<OpenRouterCallResult> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY missing");
  }

  const referer = process.env.OPENROUTER_HTTP_REFERER?.trim() || "https://auto-tagging.local";
  const title = process.env.OPENROUTER_X_TITLE?.trim() || "Auto Tagging System";
  const model = resolveOpenRouterSlug(
    opts.model || process.env.VISION_MODEL || "qwen3.7-plus"
  );
  const jsonMode = opts.jsonMode !== false;

  const body = {
    model,
    messages: [
      { role: "system" as const, content: systemPrompt },
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: userText },
          { type: "image_url" as const, image_url: { url: imageUrl } },
        ],
      },
    ],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 4096,
    ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
  };

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": title,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const waitMs = Math.min(8000, 1000 * 2 ** attempt);
      console.warn(`[autotag] OpenRouter vision ${model} 429 — retry in ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const errText = await res.text();
      lastError = new Error(`OpenRouter vision ${model} ${res.status}: ${errText.slice(0, 400)}`);
      if (res.status === 404) break;
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw lastError;
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const choice = data.choices?.[0];
    const text = choice?.message?.content?.trim() ?? "";
    const finishReason = choice?.finish_reason ?? null;
    if (!text) throw new Error(`OpenRouter vision ${model} returned empty response`);
    console.log(
      `[autotag] OpenRouter vision OK model=${model} len=${text.length} finish_reason=${finishReason ?? "unknown"}`
    );
    return { text, finishReason, model };
  }

  throw lastError ?? new Error("OpenRouter vision request failed after retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openRouterAuthHeaders(apiKey: string): Record<string, string> {
  const referer = process.env.OPENROUTER_HTTP_REFERER?.trim() || "https://auto-tagging.local";
  const title = process.env.OPENROUTER_X_TITLE?.trim() || "Auto Tagging System";
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "HTTP-Referer": referer,
    "X-Title": title,
  };
}

export interface OpenRouterCreditUsage {
  remaining: number | null;
  total_credits?: number;
  total_usage?: number;
  limit_remaining?: number | null;
  usage_daily?: number;
  source?: "credits" | "key";
  error?: string;
}

/** Account balance via /credits, falling back to /key limit_remaining. */
export async function fetchOpenRouterCreditUsage(): Promise<OpenRouterCreditUsage> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    return { remaining: null, error: "OPENROUTER_API_KEY missing" };
  }

  const base = (process.env.OPENROUTER_API_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const hdrs = openRouterAuthHeaders(apiKey);

  try {
    const creditsRes = await fetch(`${base}/credits`, {
      method: "GET",
      headers: hdrs,
      signal: AbortSignal.timeout(15_000),
    });

    if (creditsRes.ok) {
      const body = (await creditsRes.json()) as {
        data?: { total_credits?: number; total_usage?: number };
      };
      const total = body.data?.total_credits;
      const used = body.data?.total_usage;
      if (typeof total === "number" && typeof used === "number") {
        return {
          remaining: Math.max(0, total - used),
          total_credits: total,
          total_usage: used,
          source: "credits",
        };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[openrouter] credits fetch failed:", msg.slice(0, 80));
  }

  try {
    const keyRes = await fetch(`${base}/key`, {
      method: "GET",
      headers: hdrs,
      signal: AbortSignal.timeout(15_000),
    });

    if (!keyRes.ok) {
      const text = (await keyRes.text()).slice(0, 200);
      return { remaining: null, error: `key API ${keyRes.status}: ${text}` };
    }

    const body = (await keyRes.json()) as {
      data?: {
        limit_remaining?: number | null;
        limit?: number | null;
        usage?: number;
        usage_daily?: number;
      };
    };
    const d = body.data;
    if (d && d.limit_remaining != null && Number.isFinite(d.limit_remaining)) {
      return {
        remaining: d.limit_remaining,
        limit_remaining: d.limit_remaining,
        total_usage: d.usage,
        usage_daily: d.usage_daily,
        source: "key",
      };
    }

    return {
      remaining: null,
      total_usage: d?.usage,
      usage_daily: d?.usage_daily,
      source: "key",
      error: d?.limit != null ? "limit_remaining unavailable" : "no account balance on key API",
    };
  } catch (err) {
    return { remaining: null, error: err instanceof Error ? err.message : String(err) };
  }
}
