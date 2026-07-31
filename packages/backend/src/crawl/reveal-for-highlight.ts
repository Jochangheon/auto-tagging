import type { Page } from "playwright";
import type { MenuRevealPathStep, ViewportMode } from "@autotag/shared";
import { closeOpenMenus, scrollTagIntoView } from "./menu-explorer/open-trigger.js";

export interface RevealForHighlightInput {
  tagId?: number | null;
  tagIds?: number[];
  label?: string | null;
  text?: string | null;
  hiddenReason?: string | null;
  viewport?: ViewportMode;
  menuRevealPath?: MenuRevealPathStep[] | null;
  pageUrl?: string | null;
}

/** Scroll into view only — never open menus/drawers for highlight. */
export async function revealForHighlight(
  page: Page,
  input: RevealForHighlightInput
): Promise<void> {
  const tagIds =
    input.tagIds?.filter((id) => Number.isFinite(id)) ??
    (input.tagId != null && Number.isFinite(input.tagId) ? [input.tagId] : []);

  for (const id of tagIds) {
    const visible = await scrollTagIntoView(page, id);
    if (visible) return;
  }

  await closeOpenMenus(page).catch(() => {});
}
