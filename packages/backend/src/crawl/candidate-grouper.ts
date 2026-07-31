import { randomUUID } from "node:crypto";

import type {

  CandidateGroup,

  CandidateLabelGroup,

  CandidateMember,

  CandidateTree,

  CandidateTreeAction,

  CandidateTreeCategory,

  RecommendedTagCandidate,

} from "@autotag/shared";

import {

  EVENT_PARAM,

  clusterCandidatesByMerge,

  formatMergeLog,

  formatSkippedMergeLog,

  formatCategoryDisplay,

  isPageViewCandidate,

  PAGE_VIEW_EVENT_NAME,

  paramValueFromCandidate,

  pickDisplayLabelFromMembers,

  pickPrimaryMember,

  taggingAreaOf,

  taggingPageCategoryOf,

} from "@autotag/shared";



export interface GroupCandidatesResult {

  tree: CandidateTree;

  groups: CandidateGroup[];

  member_total: number;

}



type SortTuple = [number, number, number];



function positionKey(c: RecommendedTagCandidate): SortTuple {

  if (isPageViewCandidate(c)) return [-1, -1, c.tag_id];

  const bbox = c.overlay_bbox;

  const hasRect = bbox && (bbox.w > 0 || bbox.h > 0);

  if (!hasRect) return [999999, 999999, c.tag_id];

  return [bbox.y, bbox.x, c.tag_id];

}



function comparePosition(a: SortTuple, b: SortTuple): number {

  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

}



function minSort(keys: SortTuple[]): [number, number] {

  if (!keys.length) return [999999, 999999];

  const sorted = [...keys].sort(comparePosition);

  const first = sorted[0]!;

  return first[0] >= 999999 ? [999999, 999999] : [first[0], first[1]];

}



function toCandidateMember(c: RecommendedTagCandidate): CandidateMember {

  return {

    tag_id: c.tag_id,

    candidate_id: c.candidate_id,

    label: c.label,

    text: c.text,

    category: c.category,

    action: c.action,

    event_name: c.event_name ?? "",

    selector_hint: c.selector_hint,

    selectors_fallback: c.selectors_fallback,

    overlay_bbox: c.overlay_bbox,

    platform: c.platform,

    hidden_reason: c.hidden_reason,

  };

}



function buildLabelGroupsFromClusters(

  clusters: RecommendedTagCandidate[][]

): CandidateLabelGroup[] {

  const label_groups: CandidateLabelGroup[] = [];



  for (const cluster of clusters) {

    const sorted = [...cluster].sort((a, b) => comparePosition(positionKey(a), positionKey(b)));

    const mapped = sorted.map(toCandidateMember);

    const keys = sorted.map(positionKey);

    const [sy, sx] = minSort(keys);

    const display = pickDisplayLabelFromMembers(sorted);

    const primary = pickPrimaryMember(sorted);



    label_groups.push({

      label_key: `${display.toLowerCase()}::${primary.action}::${sy}:${sx}`,

      label: display,

      display_label: display,

      member_total: mapped.length,

      sort_y: sy,

      sort_x: sx,

      members: mapped,

      member_tag_ids: mapped.map((m) => m.tag_id),

    });

  }



  label_groups.sort((a, b) => a.sort_y - b.sort_y || a.sort_x - b.sort_x || a.label.localeCompare(b.label, "ko"));

  return label_groups;

}



function pageCategoryOf(c: RecommendedTagCandidate, fallback: string | null): string {
  const canonical = taggingPageCategoryOf(c);
  if (canonical !== "기타") return canonical;
  if (fallback?.trim()) return fallback.trim();
  return "기타";
}



function buildPageViewAction(pageView: RecommendedTagCandidate): CandidateTreeAction {

  const member = toCandidateMember(pageView);

  const label = pageView.label || pageView.text || PAGE_VIEW_EVENT_NAME;

  return {

    action_key: "__page_view__",

    action: PAGE_VIEW_EVENT_NAME,

    display_action: PAGE_VIEW_EVENT_NAME,

    member_total: 1,

    sort_y: -1,

    sort_x: -1,

    flattened: false,

    label_groups: [

      {

        label_key: "page_view",

        label,

        display_label: label,

        member_total: 1,

        sort_y: -1,

        sort_x: -1,

        members: [member],

        member_tag_ids: [pageView.tag_id],

      },

    ],

  };

}



function buildAreaAction(

  areaKey: string,

  areaMembers: RecommendedTagCandidate[],

  label_groups: CandidateLabelGroup[]

): CandidateTreeAction {

  const actKeys = areaMembers.map(positionKey);

  const [asy, asx] = minSort(actKeys);

  return {

    action_key: areaKey,

    action: areaKey,

    display_action: formatCategoryDisplay(areaKey),

    member_total: areaMembers.length,

    sort_y: asy,

    sort_x: asx,

    label_groups,

    flattened: false,

  };

}



/**

 * Hierarchy: page_category(tab) → area(action) → label.

 * Internal slide_nav / event buckets are not shown as a tree tier.

 */

export function groupCandidates(candidates: RecommendedTagCandidate[]): GroupCandidatesResult {

  const pageViewCandidates = candidates.filter(isPageViewCandidate);

  const domCandidates = candidates.filter((c) => !isPageViewCandidate(c));



  const pageCategoryFallback =

    pageViewCandidates[0] != null

      ? pageCategoryOf(pageViewCandidates[0], null)

      : null;



  const pageCategoryBuckets = new Map<string, RecommendedTagCandidate[]>();

  for (const c of domCandidates) {

    const pcKey = pageCategoryOf(c, pageCategoryFallback);

    const list = pageCategoryBuckets.get(pcKey) ?? [];

    list.push(c);

    pageCategoryBuckets.set(pcKey, list);

  }



  if (pageViewCandidates.length > 0) {

    const pcKey = pageCategoryOf(pageViewCandidates[0]!, pageCategoryFallback);

    if (!pageCategoryBuckets.has(pcKey)) {

      pageCategoryBuckets.set(pcKey, []);

    }

  }



  const categories: CandidateTreeCategory[] = [];

  let beforeLabelGroups = domCandidates.length;

  let afterLabelGroups = 0;

  let totalMergeLogs = 0;



  for (const [pageCategoryKey, pcMembers] of pageCategoryBuckets) {

    const areaBuckets = new Map<string, RecommendedTagCandidate[]>();

    for (const c of pcMembers) {

      const areaKey = taggingAreaOf(c);

      const list = areaBuckets.get(areaKey) ?? [];

      list.push(c);

      areaBuckets.set(areaKey, list);

    }



    const actions: CandidateTreeAction[] = [];

    const pvForBucket =

      pageViewCandidates.find((pv) => pageCategoryOf(pv, pageCategoryFallback) === pageCategoryKey) ??

      (pageCategoryBuckets.size === 1 ? pageViewCandidates[0] : undefined);

    if (pvForBucket) {

      actions.push(buildPageViewAction(pvForBucket));

    }



    for (const [areaKey, areaMembers] of areaBuckets) {

      const { clusters, mergeLogs, skipLogs } = clusterCandidatesByMerge(areaMembers);

      totalMergeLogs += mergeLogs.length;

      // Per-merge lines freeze the Node console under Phase 2 sync storms.
      // Opt in with DEBUG_MERGE=1 when diagnosing merge rules.
      if (process.env.DEBUG_MERGE === "1") {

        for (const log of mergeLogs) {

          console.log(formatMergeLog(log));

        }

        for (const log of skipLogs) {

          console.log(formatSkippedMergeLog(log));

        }

      }



      beforeLabelGroups += areaMembers.length;

      afterLabelGroups += clusters.length;



      const label_groups = buildLabelGroupsFromClusters(clusters);

      actions.push(buildAreaAction(areaKey, areaMembers, label_groups));

    }



    actions.sort(

      (a, b) => a.sort_y - b.sort_y || a.sort_x - b.sort_x || a.display_action.localeCompare(b.display_action, "ko")

    );



    const catKeys = pcMembers.map(positionKey);

    const [csy, csx] = catKeys.length ? minSort(catKeys) : [-1, -1];



    categories.push({

      category_key: pageCategoryKey,

      category: pageCategoryKey,

      display_category: pageCategoryKey,

      member_total: pcMembers.length + (pvForBucket ? 1 : 0),

      sort_y: csy,

      sort_x: csx,

      actions,

    });

  }



  categories.sort(

    (a, b) => a.sort_y - b.sort_y || a.sort_x - b.sort_x || a.display_category.localeCompare(b.display_category, "ko")

  );



  const action_count = categories.reduce((n, c) => n + c.actions.length, 0);

  const label_group_count = categories.reduce(

    (n, c) => n + c.actions.reduce((m, a) => m + a.label_groups.length, 0),

    0

  );



  const tree: CandidateTree = {

    categories,

    member_total: candidates.length,

    category_count: categories.length,

    action_count,

    label_group_count,

  };



  const memberSum = categories.reduce((n, c) => n + c.member_total, 0);

  const tagIdSet = new Set<number>();

  for (const cat of categories) {

    for (const act of cat.actions) {

      for (const lg of act.label_groups) {

        for (const id of lg.member_tag_ids) tagIdSet.add(id);

      }

    }

  }



  let mergedMembers = 0;

  for (const cat of categories) {

    for (const act of cat.actions) {

      for (const lg of act.label_groups) {

        if (lg.member_total > 1) mergedMembers += lg.member_total - 1;

      }

    }

  }



  console.log(

    `[tree] merge_rules category+action+href before_rows=${beforeLabelGroups} after_rows=${afterLabelGroups} merge_events=${totalMergeLogs}`

  );

  console.log(

    `[tree] page_categories=${tree.category_count} areas=${tree.action_count} labels=${tree.label_group_count} merged=${mergedMembers} page_view=${pageViewCandidates.length > 0}`

  );

  console.log(

    `[tree] members=${tree.member_total} tag_ids=${tagIdSet.size} dropped=${candidates.length - tagIdSet.size}`

  );



  if (memberSum !== candidates.length) {

    console.error(`[tree ERROR] member_sum(${memberSum}) !== candidates(${candidates.length})`);

  }



  const groups = flattenTreeToGroups(tree);



  return { tree, groups, member_total: candidates.length };

}



function flattenTreeToGroups(tree: CandidateTree): CandidateGroup[] {

  const groups: CandidateGroup[] = [];

  for (const cat of tree.categories) {

    for (const act of cat.actions) {

      for (const lg of act.label_groups) {

        groups.push({

          group_id: randomUUID(),

          group_key: `${cat.category_key}::${act.action_key}::${lg.label_key}`,

          category: cat.display_category,

          action: act.display_action,

          event_name: lg.members[0]?.event_name ?? "",

          display_label: lg.display_label,

          display_category: cat.display_category,

          display_action_label: act.display_action,

          member_total: lg.member_total,

          members_visible: lg.members,

          members_hidden_count: 0,

          member_tag_ids: lg.member_tag_ids,

        });

      }

    }

  }

  return groups;

}


