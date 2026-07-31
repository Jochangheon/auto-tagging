import {
  dedupeBySameHref,
  formatLinkDedupLog,
  normalizeNavLinkPath,
  shouldExcludeInteractiveWrapper,
} from "@autotag/shared";
import type { LiveTagEntry } from "./tag-live-dom.js";
import { findByTagId, hydrateSnapshot } from "../snapshot/hydrate.js";
import { resolveNavLinkFromCheerio } from "./selector-from-cheerio.js";

type HydratedDoc = ReturnType<typeof hydrateSnapshot>;

function leafPriorityFromElement($el: ReturnType<HydratedDoc["$"]>): number {
  const tag = (($el.prop("tagName") as string) || "").toLowerCase();
  if (tag === "a" && $el.attr("href")) return 100;
  if (tag === "button") return 90;
  const role = ($el.attr("role") || "").toLowerCase();
  if (role === "button" || role === "link") return 80;
  if (tag === "input" || tag === "select" || tag === "textarea") return 70;
  return 20;
}

function resolveHrefForTag(
  doc: HydratedDoc,
  tagId: number,
  sourceUrl?: string
): string {
  const $el = findByTagId(doc, tagId);
  if (!$el) return "";
  const resolved = resolveNavLinkFromCheerio(doc.$, $el.get(0)!, sourceUrl);
  if (!resolved) return "";
  return normalizeNavLinkPath(resolved, sourceUrl ?? "https://local/");
}

/** Log wrapper pairs on hydrated HTML before LLM — all tag_ids are kept for merge grouping. */
export function dedupeLiveEntriesBeforeExtract(
  doc: HydratedDoc,
  entries: LiveTagEntry[],
  sourceUrl?: string
): { entries: LiveTagEntry[]; logs: string[] } {
  const { entries: kept, logs } = dedupeBySameHref(entries, {
    getElement: (tagId) => findByTagId(doc, tagId)?.get(0) ?? null,
    contains: (ancestorId, descendantId) => {
      const $a = findByTagId(doc, ancestorId);
      if (!$a?.length) return false;
      return $a.find(`[data-tag-id="${descendantId}"]`).length > 0;
    },
    resolveHref: (tagId) => resolveHrefForTag(doc, tagId, sourceUrl),
    leafPriority: (tagId) => {
      const $el = findByTagId(doc, tagId);
      return $el?.length ? leafPriorityFromElement($el) : 0;
    },
    isWrapperToExclude: (tagId) => {
      const $el = findByTagId(doc, tagId);
      if (!$el?.length) return false;
      return shouldExcludeInteractiveWrapper(doc.$, $el);
    },
  });

  const logLines = logs.map(formatLinkDedupLog);
  for (const line of logLines) console.log(line);
  return { entries: kept, logs: logLines };
}

export { resolveHrefForTag };
