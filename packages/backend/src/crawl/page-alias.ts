import type { PageContextSnapshot, Platform, RecommendedTagCandidate } from "@autotag/shared";
import {
  applyCanonicalTaggingFields,
  buildCanonicalPageViewFields,
  isPageViewCandidate,
  normalizePageCategory,
  resolveTaggingPageCategory,
  taggingAreaOf,
} from "@autotag/shared";
import { paramValueFromCandidate } from "@autotag/shared";
import { EVENT_PARAM } from "@autotag/shared";

/** User-defined URL list alias (e.g. "메인") overrides LLM page_category for taxonomy/transmission. */
export function applyPageAliasToCandidates(
  candidates: RecommendedTagCandidate[],
  alias: string | undefined | null,
  pageContext?: PageContextSnapshot
): RecommendedTagCandidate[] {
  const trimmed = alias?.trim();
  if (!trimmed) return candidates;

  const pageCat = normalizePageCategory(trimmed);

  return candidates.map((c) => {
    if (isPageViewCandidate(c)) {
      const platform = (c.platform === "MO" || c.platform === "PC" ? c.platform : "All") as Platform;
      const canonical = pageContext
        ? buildCanonicalPageViewFields(pageCat, pageContext, platform)
        : null;
      return {
        ...c,
        page_category: pageCat,
        category: pageCat,
        action: "",
        action_key: canonical?.action_key ?? "page_view",
        label: "",
        text: pageCat,
        parameters: canonical?.parameters ?? c.parameters,
      };
    }

    const platform = (c.platform === "MO" || c.platform === "PC" ? c.platform : "All") as Platform;
    const area = taggingAreaOf(c) || c.action || "기타";

    return applyCanonicalTaggingFields(c, {
      page_category: resolveTaggingPageCategory(pageCat, area),
      area_raw: area,
      label: c.label,
      merge_label: c.merge_label || c.label,
      event_name: c.event_name || "클릭",
      action_key: c.action_key || "click",
      platform,
      pageContext,
      link_url: paramValueFromCandidate(c, EVENT_PARAM.LINK_URL),
      llmExtras: c.parameters?.filter(
        (p) => p.name !== EVENT_PARAM.PAGE_CATEGORY && p.name !== EVENT_PARAM.CATEGORY
      ),
    });
  });
}
