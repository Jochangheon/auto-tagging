import type { Platform, ViewportMode } from "./viewport.js";

/** Same rule as workspace UI `memberMatchesViewport` in workspace-core.js. */
export function candidateVisibleInTaggingViewport(
  c: { tag_id?: number; platform?: Platform },
  viewport: ViewportMode
): boolean {
  if (c.tag_id === 0) return true;
  const p = c.platform ?? "All";
  if (p === "All") return true;
  return viewport === "pc" ? p === "PC" : p === "MO";
}

export function platformAsShownInTagging(c: { platform?: Platform }): string {
  return c.platform ?? "All";
}

/** Same visibility rule as tagging UI `filterTreeByViewport` for one label group. */
export function labelGroupVisibleInTaggingViewport(
  lg: {
    members?: { tag_id?: number; platform?: Platform }[];
    member_tag_ids?: number[];
  },
  viewport: ViewportMode,
  platformOf: (tagId: number) => Platform | undefined
): boolean {
  const members = lg.members ?? [];
  const tagIds = lg.member_tag_ids ?? members.map((m) => m.tag_id);
  const visibleMembers = members.filter((m) => candidateVisibleInTaggingViewport(m, viewport));
  if (visibleMembers.length > 0) return true;
  return tagIds.some((id) =>
    id != null &&
    candidateVisibleInTaggingViewport({ tag_id: id, platform: platformOf(id) }, viewport)
  );
}
