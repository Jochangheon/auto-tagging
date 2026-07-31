import { Router } from "express";
import type { AnalyzeSnapshotRequest, AnalyzeSnapshotResponse } from "@autotag/shared";
import { hydrateSnapshot } from "../snapshot/hydrate.js";
import { htmlToTaggedMarkdown, candidatesToMarkdown } from "../snapshot/md-converter.js";
import { htmlToMarkdownViaFirecrawl, isFirecrawlMdEnabled } from "../snapshot/firecrawl-md.js";
import { analyzeSnapshotWithLlm } from "../llm/client.js";
import { runEnrichmentExtractors } from "../extractors/pipeline.js";
import { finalizeSuggestions, hintsToMarkdown } from "../extractors/merge-suggestions.js";
import { isAllowedLlmModel } from "@autotag/shared";

export const analyzeSnapshotRouter = Router();

const PIPELINE_DEBUG = process.env.AUTOTAG_PIPELINE_DEBUG === "1";

function debugLog(...args: unknown[]): void {
  if (PIPELINE_DEBUG) console.debug("[autotag:analyze-snapshot]", ...args);
}

/**
 * POST /api/v1/analyze-snapshot
 * Virtual hydration → markdown → optional extractors (Stagehand/Scrapegraph/Skyvern) → LLM
 */
analyzeSnapshotRouter.post("/analyze-snapshot", async (req, res) => {
  const body = req.body as AnalyzeSnapshotRequest;

  if (!body?.version || typeof body.html_snapshot !== "string") {
    return res.status(400).json({ error: "version and html_snapshot required" });
  }

  if (!Array.isArray(body.candidates)) {
    return res.status(400).json({ error: "candidates array required" });
  }

  if (body.llm_model && !isAllowedLlmModel(body.llm_model)) {
    return res.status(400).json({ error: "llm_model_not_allowed" });
  }

  if (body.candidates.length === 0) {
    const empty: AnalyzeSnapshotResponse = {
      version: body.version,
      tag_ids: [],
      suggestions: [],
    };
    return res.status(200).json(empty);
  }

  try {
    const doc = hydrateSnapshot(body.html_snapshot);
    debugLog("hydrated", {
      version: body.version,
      tagIds: doc.byTagId.size,
      candidates: body.candidates.length,
      firecrawl: isFirecrawlMdEnabled(),
    });

    const orphanIds = body.candidates
      .map((c) => c.tag_id)
      .filter((id) => !doc.byTagId.has(id));
    if (orphanIds.length > 0) {
      console.warn("[autotag] analyze-snapshot: orphan candidate tag_ids", orphanIds);
    }

    const ambiguous = body.candidates.filter((c) => c.classification === "ambiguous");

    const [markdownBase, enrichment] = await Promise.all([
      isFirecrawlMdEnabled()
        ? htmlToMarkdownViaFirecrawl(body.html_snapshot, body.candidates, doc)
        : Promise.resolve(
            `${htmlToTaggedMarkdown(doc)}\n\n${candidatesToMarkdown(body.candidates)}`
          ),
      runEnrichmentExtractors({
        html_snapshot: body.html_snapshot,
        candidates: body.candidates,
        url: body.url,
        stageTitle: body.stage?.title,
      }),
    ]);

    const hintsBlock = hintsToMarkdown(enrichment.mergedHints);
    const markdown = hintsBlock ? `${markdownBase}\n\n${hintsBlock}` : markdownBase;

    debugLog("markdown ready", {
      length: markdown.length,
      extractorHints: enrichment.mergedHints.length,
      extractors: enrichment.results.map((r) => ({
        source: r.source,
        hints: r.hints.length,
        error: r.error,
      })),
    });

    const llmCandidates = ambiguous.length > 0 ? ambiguous : body.candidates;
    const allowedTagIds = new Set(llmCandidates.map((c) => c.tag_id));

    const llmSuggestions = await analyzeSnapshotWithLlm({
      version: body.version,
      markdown,
      candidates: llmCandidates,
      stageTitle: body.stage?.title,
      url: body.url,
      extractorHints: enrichment.mergedHints,
      llm_model: body.llm_model,
    });

    const suggestions = finalizeSuggestions(llmSuggestions, enrichment.mergedHints, allowedTagIds);

    const tag_ids = suggestions.map((s) => s.tag_id);

    debugLog("llm suggestions", { count: suggestions.length, tag_ids, llm_model: body.llm_model });

    const response: AnalyzeSnapshotResponse = {
      version: body.version,
      tag_ids,
      suggestions,
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error("[autotag] analyze-snapshot failed", err);
    return res.status(500).json({ error: "analyze_snapshot_failed" });
  }
});
