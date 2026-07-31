import type { SnapshotCandidate } from "@autotag/shared";
import { mergeExtractorHints } from "./merge-suggestions.js";
import type { ExtractorHint } from "./types.js";
import { scrapegraphExtract, isScrapegraphEnabled } from "./scrapegraph-extract.js";
import { skyvernExtract, isSkyvernEnabled } from "./skyvern-extract.js";
import { stagehandExtract, isStagehandEnabled } from "./stagehand-extract.js";
import type { ExtractorInput, ExtractorResult } from "./types.js";

export interface EnrichmentPipelineResult {
  mergedHints: ExtractorHint[];
  results: ExtractorResult[];
}

export function getExtractorStatus(): Record<string, boolean | string> {
  return {
    stagehand: isStagehandEnabled(),
    scrapegraph: isScrapegraphEnabled(),
    skyvern: isSkyvernEnabled(),
    scrapegraph_url: process.env.SCRAPEGRAPH_URL ?? "",
    skyvern_api_url: process.env.SKYVERN_API_URL ?? "",
  };
}

/** Run optional extractors in parallel; failures are non-fatal */
export async function runEnrichmentExtractors(input: {
  html_snapshot: string;
  candidates: SnapshotCandidate[];
  url?: string;
  stageTitle?: string;
}): Promise<EnrichmentPipelineResult> {
  const extractorInput: ExtractorInput = {
    html_snapshot: input.html_snapshot,
    candidates: input.candidates,
    url: input.url,
    stageTitle: input.stageTitle,
  };

  const tasks: Promise<ExtractorResult>[] = [];
  if (isStagehandEnabled()) tasks.push(stagehandExtract(extractorInput));
  if (isScrapegraphEnabled()) tasks.push(scrapegraphExtract(extractorInput));
  if (isSkyvernEnabled()) tasks.push(skyvernExtract(extractorInput));

  if (tasks.length === 0) {
    return { mergedHints: [], results: [] };
  }

  const results = await Promise.all(tasks);
  const allHints = results.flatMap((r) => r.hints);
  const mergedHints = mergeExtractorHints(allHints);

  if (process.env.AUTOTAG_PIPELINE_DEBUG === "1") {
    for (const r of results) {
      console.debug(
        `[autotag:extractors] ${r.source}: ${r.hints.length} hints${r.error ? ` (error: ${r.error})` : ""} ${r.durationMs ?? 0}ms`
      );
    }
  }

  return { mergedHints, results };
}
