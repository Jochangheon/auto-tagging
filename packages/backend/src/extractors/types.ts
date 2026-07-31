import type { SnapshotCandidate, SnapshotSuggestion } from "@autotag/shared";

export type ExtractorSource = "stagehand" | "scrapegraph" | "skyvern";

/** Partial suggestion from an enrichment extractor (before Gemini final pass) */
export interface ExtractorHint {
  tag_id: number;
  event_name?: string;
  parameters?: SnapshotSuggestion["parameters"];
  confidence?: number;
  source: ExtractorSource;
  note?: string;
}

export interface ExtractorInput {
  html_snapshot: string;
  candidates: SnapshotCandidate[];
  url?: string;
  stageTitle?: string;
}

export interface ExtractorResult {
  source: ExtractorSource;
  hints: ExtractorHint[];
  error?: string;
  durationMs?: number;
}
