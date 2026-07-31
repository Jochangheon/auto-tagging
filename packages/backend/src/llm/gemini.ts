// Direct Gemini Flash adapter — used when LLM_PROVIDER=gemini or OpenRouter unavailable.

const GEMINI_MODELS = ["gemini-2.0-flash", "gemini-2.0-flash-lite"] as const;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GenerateOptions {
  json?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
}

export function getGeminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY?.trim() || undefined;
}

export async function generateGeminiText(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  opts: GenerateOptions = {}
): Promise<string> {
  const fullPrompt = systemPrompt.trim()
    ? `${systemPrompt.trim()}\n\n${userPrompt}`
    : userPrompt;

  const body = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxOutputTokens ?? 4096,
      ...(opts.json ? { responseMimeType: "application/json" } : {}),
    },
  };

  let lastError: Error | undefined;

  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const url = `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        const waitMs = Math.min(8000, 1000 * 2 ** attempt);
        console.warn(`[autotag] Gemini ${model} rate limited — retry in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (res.status === 404) {
        lastError = new Error(`Gemini model not found: ${model}`);
        break;
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini ${model} ${res.status}: ${errText.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) {
        throw new Error(`Gemini ${model} returned empty response`);
      }

      if (attempt === 0) {
        console.log(`[autotag] Gemini OK model=${model}`);
      }
      return text;
    }
  }

  throw lastError ?? new Error("Gemini request failed after retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
