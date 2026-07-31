/**
 * Edit candidate category/action/label and regroup.
 * Merge rule: same normalized (page_category|area|label) key → join that group.
 */
import {
  applyCanonicalTaggingFields,
  EVENT_PARAM,
  pageContextFromUrl,
  taggingActionKeyOf,
  taggingAreaOf,
  taggingPageCategoryOf,
  type PageNode,
  type Platform,
  type RecommendedTagCandidate,
  type ViewportMode,
} from "@autotag/shared";
import { groupCandidates } from "./candidate-grouper.js";
import {
  getAnalysisSession,
  initSessionSelection,
  type AnalysisSession,
} from "./job-store.js";

function normalizeKeyPart(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Canonical group key used for merge / overwrite. */
export function candidateGroupKey(c: RecommendedTagCandidate): string {
  const pageCat = normalizeKeyPart(taggingPageCategoryOf(c));
  const area = normalizeKeyPart(taggingAreaOf(c));
  const label = normalizeKeyPart((c.merge_label || c.label || c.text || "").trim());
  return `${pageCat}|${area}|${label}`;
}

export type CandidateEditPatch = {
  page_category?: string;
  action?: string;
  label?: string;
  merge_label?: string;
  event_name?: string;
  link_url?: string | null;
  direction?: string | null;
};

function applyEditToCandidate(
  c: RecommendedTagCandidate,
  patch: CandidateEditPatch,
  pageUrl: string,
  pageName: string
): RecommendedTagCandidate {
  const page_category = (patch.page_category ?? taggingPageCategoryOf(c)).trim() || "기타";
  const area = (patch.action ?? taggingAreaOf(c)).trim() || "기타";
  const label = (patch.label ?? c.label ?? c.text ?? "").trim() || "버튼";
  const merge_label = (patch.merge_label ?? label).trim() || label;
  const event_name = (patch.event_name ?? c.event_name ?? `${label}_클릭`).trim() || "클릭";
  const pageCtx = pageContextFromUrl(pageUrl, pageName);
  const existingLink =
    c.parameters?.find((p) => p.name === EVENT_PARAM.LINK_URL)?.value_hint ?? null;
  const existingDirection =
    c.parameters?.find((p) => p.name === EVENT_PARAM.DIRECTION)?.value_hint ?? null;
  const direction = patch.direction === undefined ? existingDirection : patch.direction;

  const platform = (c.platform || "All") as Platform;
  return applyCanonicalTaggingFields(
    {
      ...c,
      text: c.text || label,
      event_name,
    },
    {
      page_category,
      area_raw: area,
      label,
      merge_label,
      event_name,
      action_key: taggingActionKeyOf(c),
      platform,
      pageContext: pageCtx,
      link_url: patch.link_url === undefined ? existingLink : patch.link_url,
      llmExtras: direction
        ? [{ name: EVENT_PARAM.DIRECTION, value_hint: direction }]
        : [],
    }
  );
}

/**
 * Patch one or more candidates on a page, regroup tree, return updated page.
 */
export function editPageCandidates(
  page: PageNode,
  tagIds: number[],
  patch: CandidateEditPatch
): PageNode {
  const idSet = new Set(tagIds.filter((id) => id !== 0));
  if (!idSet.size) {
    throw new Error("no_tag_ids");
  }

  const nextCandidates = (page.candidates || []).map((c) => {
    if (!idSet.has(c.tag_id)) return c;
    return applyEditToCandidate(c, patch, page.page_url, page.page_name);
  });

  const grouped = groupCandidates(nextCandidates);
  return {
    ...page,
    candidates: nextCandidates,
    groups: grouped.groups,
    tree: grouped.tree,
    candidate_count: nextCandidates.length,
    group_count: grouped.groups.length,
    analyzed_at: page.analyzed_at || new Date().toISOString(),
  };
}

export function replaceSessionPage(
  sessionId: string,
  page: PageNode
): AnalysisSession {
  const session = getAnalysisSession(sessionId);
  if (!session) throw new Error("session_not_found");
  const vp = (page.active_viewport ?? "pc") as ViewportMode;
  const idx = session.pages.findIndex(
    (p) =>
      p.page_url === page.page_url && (p.active_viewport ?? "pc") === vp
  );
  if (idx < 0) throw new Error("page_not_found");
  session.pages[idx] = page;
  session.updated_at = new Date().toISOString();
  session.active_page_url = page.page_url;
  initSessionSelection(session);
  return session;
}
