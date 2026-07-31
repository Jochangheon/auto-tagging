/** Org-allowed OpenRouter chat models for Auto Tagging System. */

export type LlmModelUse = "tagging" | "vision";

export interface LlmModelEntry {
  id: string;
  label: string;
  openrouter_slug: string;
  recommended_for?: LlmModelUse;
}

/** Chat-selectable models only — embedding-only models are excluded. */
export const ALLOWED_LLM_MODELS: LlmModelEntry[] = [
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    openrouter_slug: "google/gemini-3.5-flash",
    recommended_for: "tagging",
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    openrouter_slug: "openai/gpt-5.5",
    recommended_for: "tagging",
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    openrouter_slug: "openai/gpt-5.4",
    recommended_for: "tagging",
  },
  {
    id: "gpt-5.4-image-2",
    label: "GPT-5.4 Image 2",
    openrouter_slug: "openai/gpt-5.4-image-2",
    recommended_for: "vision",
  },
  {
    id: "claude-sonnet-4.6",
    label: "Claude Sonnet 4.6",
    openrouter_slug: "anthropic/claude-sonnet-4.6",
    recommended_for: "tagging",
  },
  {
    id: "claude-opus-4.8",
    label: "Claude Opus 4.8",
    openrouter_slug: "anthropic/claude-opus-4.8",
    recommended_for: "tagging",
  },
  {
    id: "nano-banana-2",
    label: "Nano Banana 2 (Gemini 3.1 Flash Image Preview)",
    openrouter_slug: "google/gemini-3.1-flash-image-preview",
    recommended_for: "vision",
  },
  {
    id: "glm-5.1",
    label: "GLM 5.1",
    openrouter_slug: "z-ai/glm-5.1",
    recommended_for: "tagging",
  },
  {
    id: "kimi-k2.6",
    label: "Kimi K2.6",
    openrouter_slug: "moonshotai/kimi-k2.6",
    recommended_for: "tagging",
  },
  {
    id: "kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    openrouter_slug: "moonshotai/kimi-k2.7-code",
    recommended_for: "tagging",
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    openrouter_slug: "deepseek/deepseek-v4-pro",
    recommended_for: "tagging",
  },
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
    openrouter_slug: "google/gemini-3.1-flash-lite",
    recommended_for: "tagging",
  },
  {
    id: "qwen3.7-max",
    label: "Qwen3.7 Max",
    openrouter_slug: "qwen/qwen3.7-max",
    recommended_for: "tagging",
  },
  {
    id: "qwen3.7-plus",
    label: "Qwen3.7 Plus",
    openrouter_slug: "qwen/qwen3.7-plus",
    recommended_for: "vision",
  },
  {
    id: "minimax-m3",
    label: "MiniMax M3",
    openrouter_slug: "minimax/minimax-m3",
    recommended_for: "tagging",
  },
];

export const DEFAULT_LLM_MODEL_ID = "gemini-3.5-flash";

const MODEL_BY_ID = new Map(ALLOWED_LLM_MODELS.map((m) => [m.id, m]));
const MODEL_BY_SLUG = new Map(ALLOWED_LLM_MODELS.map((m) => [m.openrouter_slug, m]));

export function getDefaultLlmModel(): LlmModelEntry {
  return MODEL_BY_ID.get(DEFAULT_LLM_MODEL_ID) ?? ALLOWED_LLM_MODELS[0]!;
}

/** Resolve UI id, OpenRouter slug, or env default to an OpenRouter slug. */
export function resolveOpenRouterSlug(modelIdOrSlug?: string | null): string {
  const trimmed = modelIdOrSlug?.trim();
  if (trimmed) {
    const byId = MODEL_BY_ID.get(trimmed);
    if (byId) return byId.openrouter_slug;
    const bySlug = MODEL_BY_SLUG.get(trimmed);
    if (bySlug) return bySlug.openrouter_slug;
    return trimmed;
  }

  const envSlug =
    typeof process !== "undefined" ? process.env.LLM_MODEL?.trim() : undefined;
  if (envSlug) {
    const byEnvId = MODEL_BY_ID.get(envSlug);
    if (byEnvId) return byEnvId.openrouter_slug;
    const byEnvSlug = MODEL_BY_SLUG.get(envSlug);
    if (byEnvSlug) return byEnvSlug.openrouter_slug;
    return envSlug;
  }

  return getDefaultLlmModel().openrouter_slug;
}

export function resolveLlmModelId(modelIdOrSlug?: string | null): string {
  const trimmed = modelIdOrSlug?.trim();
  if (trimmed) {
    if (MODEL_BY_ID.has(trimmed)) return trimmed;
    const bySlug = MODEL_BY_SLUG.get(trimmed);
    if (bySlug) return bySlug.id;
  }

  const env =
    typeof process !== "undefined" ? process.env.LLM_MODEL?.trim() : undefined;
  if (env) {
    if (MODEL_BY_ID.has(env)) return env;
    const bySlug = MODEL_BY_SLUG.get(env);
    if (bySlug) return bySlug.id;
  }

  return DEFAULT_LLM_MODEL_ID;
}

export function getLlmModelLabel(modelIdOrSlug?: string | null): string {
  const trimmed = modelIdOrSlug?.trim();
  if (trimmed) {
    const byId = MODEL_BY_ID.get(trimmed);
    if (byId) return byId.label;
    const bySlug = MODEL_BY_SLUG.get(trimmed);
    if (bySlug) return bySlug.label;
  }
  return getDefaultLlmModel().label;
}

export function isAllowedLlmModel(modelIdOrSlug?: string | null): boolean {
  const trimmed = modelIdOrSlug?.trim();
  if (!trimmed) return true;
  return MODEL_BY_ID.has(trimmed) || MODEL_BY_SLUG.has(trimmed);
}
