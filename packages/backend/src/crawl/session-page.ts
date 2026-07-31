import * as cheerio from "cheerio";
import type {
  CandidateGroup,
  CandidateTree,
  PageNode,
  RecommendedTagCandidate,
  SessionResult,
  ViewportMode,
} from "@autotag/shared";
import { derivePageName } from "@autotag/shared";
import type { StoredJob } from "./job-store.js";
import { applyPositionsToCandidates, hasValidBbox } from "./positions-file.js";
import { syncCandidateTreeBboxes } from "./candidate-capture.js";
import { groupCandidates } from "./candidate-grouper.js";
import { applyPageAliasToCandidates } from "./page-alias.js";

export function derivePageNameFromHtml(html: string, url: string): string {
  try {
    const $ = cheerio.load(html);
    const ogTitle = $("meta[property='og:title']").attr("content")?.trim();
    const title = $("title").first().text()?.trim();
    return derivePageName({ title, ogTitle, url });
  } catch {
    return derivePageName({ url });
  }
}

export function buildPageNodeFromJob(
  job: StoredJob,
  opts: { pageName?: string; viewport?: ViewportMode; forceRegroup?: boolean } = {}
): PageNode {
  const positions = (job.element_positions?.positions ?? []).filter(
    (p) => p.tag_id === 0 || hasValidBbox(p.bbox)
  );
  let rawCandidates = job.candidates ?? [];
  if (job.page_alias?.trim()) {
    rawCandidates = applyPageAliasToCandidates(rawCandidates, job.page_alias);
  }
  const candidates = applyPositionsToCandidates(rawCandidates, positions);

  // Phase 2 capture sync used to re-run groupCandidates on every tick (O(n²) +
  // merge log spam). Reuse the job's existing tree/groups and only patch bboxes.
  const canReuseTree =
    !opts.forceRegroup &&
    job.candidate_tree != null &&
    Array.isArray(job.groups) &&
    job.groups.length > 0;

  let tree: CandidateTree;
  let groups: CandidateGroup[];
  if (canReuseTree) {
    tree = syncCandidateTreeBboxes(job.candidate_tree!, candidates);
    groups = job.groups;
  } else {
    const grouped = groupCandidates(candidates);
    tree = syncCandidateTreeBboxes(grouped.tree, candidates);
    groups = grouped.groups;
  }

  return {
    page_url: job.source_url,
    page_name: opts.pageName ?? derivePageName({ url: job.source_url }),
    analyzed_at: job.updated_at,
    job_id: job.job_id,
    tree,
    groups,
    candidates,
    candidate_count: candidates.length,
    group_count: tree.label_group_count ?? groups.length,
    active_viewport: opts.viewport ?? job.viewport ?? "pc",
    gnb_hover_opened: job.gnb_hover_opened ?? [],
    capture_url: job.capture_url ?? null,
    capture_width: job.capture_width ?? null,
    capture_height: job.capture_height ?? null,
    positions,
    positions_url: positions.length ? `/api/dev/captures/${job.job_id}/positions.json` : null,
  };
}

export function pageNodeFromSnapshot(
  url: string,
  jobId: string,
  pageName: string,
  viewport: ViewportMode,
  data: {
    candidates: RecommendedTagCandidate[];
    groups: CandidateGroup[];
    candidate_tree?: CandidateTree;
    gnb_hover_opened?: string[];
    capture_url?: string | null;
    capture_width?: number | null;
    capture_height?: number | null;
  }
): PageNode {
  const tree = data.candidate_tree ?? {
    categories: [],
    member_total: 0,
    category_count: 0,
    action_count: 0,
    label_group_count: 0,
  };

  return {
    page_url: url,
    page_name: pageName,
    analyzed_at: new Date().toISOString(),
    job_id: jobId,
    tree,
    groups: data.groups,
    candidates: data.candidates,
    candidate_count: data.candidates.length,
    group_count: tree.label_group_count ?? data.groups.length,
    active_viewport: viewport,
    gnb_hover_opened: data.gnb_hover_opened ?? [],
    capture_url: data.capture_url ?? null,
    capture_width: data.capture_width ?? null,
    capture_height: data.capture_height ?? null,
  };
}

export function toSessionResult(
  session: SessionResult & { created_at?: string }
): SessionResult {
  return {
    session_id: session.session_id,
    pages: session.pages,
    active_page_url: session.active_page_url,
    updated_at: session.updated_at,
  };
}
