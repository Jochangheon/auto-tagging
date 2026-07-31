import { Router } from "express";
import {
  ALLOWED_LLM_MODELS,
  DEFAULT_LLM_MODEL_ID,
  type LlmModelsResponse,
} from "@autotag/shared";

export const llmModelsRouter = Router();

/** GET /api/v1/llm/models — allowed chat models for host UI selector */
llmModelsRouter.get("/llm/models", (_req, res) => {
  const response: LlmModelsResponse = {
    default_id: DEFAULT_LLM_MODEL_ID,
    models: ALLOWED_LLM_MODELS.map(({ id, label, openrouter_slug, recommended_for }) => ({
      id,
      label,
      openrouter_slug,
      recommended_for,
    })),
  };
  res.status(200).json(response);
});
