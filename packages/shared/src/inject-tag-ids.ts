// Server-side data-tag-id injection (cheerio) — pairs with backend hydrateSnapshot

import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import {
  INTERACTIVE_SELECTOR,
  INTERACTIVE_LEAF_SELECTOR,
  WRAPPER_CONTAINER_TAGS,
  labelFromElement,
  CURSOR_POINTER_CHEERIO_SELECTOR,
} from "./interactive-selector.js";
import {
  dedupeBySameHref,
  formatLinkDedupLog,
  normalizeNavLinkPath,
} from "./candidate-link-dedup.js";

export interface InjectedTagEntry {
  tag_id: number;
  tag: string;
  text: string;
  identification_hints: string;
}

export interface InjectTagIdsStats {
  raw_matched: number;
  tagged: number;
}

export interface InjectTagIdsResult {
  html: string;
  entries: InjectedTagEntry[];
  count: number;
  stats: InjectTagIdsStats;
}

function cheerioAttrs($el: cheerio.Cheerio<Element>): Record<string, string | undefined> {
  const raw = $el.attr() ?? {};
  const attrs: Record<string, string | undefined> = { ...raw };
  const img = $el.find("img[src]").first();
  if (img.length) attrs.src = img.attr("src");
  return attrs;
}

function hasInteractiveLeafDescendantCheerio(
  $: cheerio.CheerioAPI,
  $el: cheerio.Cheerio<Element>
): boolean {
  const self = $el.get(0);
  if (!self) return false;
  let found = false;
  $el.find(INTERACTIVE_LEAF_SELECTOR).each((_i, node) => {
    if (node !== self) found = true;
  });
  return found;
}

/** Exclude container wrappers that only wrap a leaf interactive descendant. */
export function shouldExcludeInteractiveWrapper(
  $: cheerio.CheerioAPI,
  $el: cheerio.Cheerio<Element>
): boolean {
  const tag = (($el.prop("tagName") as string) || "").toLowerCase();
  if (tag === "a") {
    const href = ($el.attr("href") || "").trim();
    if (href && href !== "#" && !href.toLowerCase().startsWith("javascript:")) return false;
    const cls = $el.attr("class") || "";
    if (/\bbtn\b|button|link-button/i.test(cls)) return false;
  }
  if (tag === "button") return false;
  const role = ($el.attr("role") || "").toLowerCase();
  if (role === "button" || role === "link") return false;
  if (!WRAPPER_CONTAINER_TAGS.has(tag) && !["label"].includes(tag)) {
    return hasInteractiveLeafDescendantCheerio($, $el);
  }
  return hasInteractiveLeafDescendantCheerio($, $el);
}

function hasInteractiveChild($: cheerio.CheerioAPI, $el: cheerio.Cheerio<Element>): boolean {
  return hasInteractiveLeafDescendantCheerio($, $el);
}

function isFilenameLike(text: string): boolean {
  return /\.(jpe?g|png|webp|gif|svg)$/i.test(text) || /^[\w-]+\.(jpe?g|png)/i.test(text);
}

function pointerLabelText($el: cheerio.Cheerio<Element>): string {
  const p = $el.children("p").first();
  if (p.length) {
    const pText = (p.text() || "").trim();
    if (pText.length >= 2) return pText;
  }
  let img = $el.children("img[alt]").first();
  if (!img.length) img = $el.find("img[alt]").first();
  if (img.length) {
    const alt = (img.attr("alt") || "").trim();
    if (alt.length >= 2 && !isFilenameLike(alt)) return alt;
  }
  return "";
}

function hasPointerAncestor($: cheerio.CheerioAPI, $el: cheerio.Cheerio<Element>): boolean {
  return $el.parents(CURSOR_POINTER_CHEERIO_SELECTOR).length > 0;
}

function leafPriorityCheerio($el: cheerio.Cheerio<Element>): number {
  const tag = (($el.prop("tagName") as string) || "").toLowerCase();
  if (tag === "a" && $el.attr("href")) return 100;
  if (tag === "button") return 90;
  const role = ($el.attr("role") || "").toLowerCase();
  if (role === "button" || role === "link") return 80;
  if (tag === "input" || tag === "select" || tag === "textarea") return 70;
  return 20;
}

function resolveHrefCheerio($: cheerio.CheerioAPI, $el: cheerio.Cheerio<Element>, baseUrl: string): string {
  const tag = (($el.prop("tagName") as string) || "").toLowerCase();
  let href = tag === "a" ? $el.attr("href") : "";
  if (!href) {
    const inner = $el.find("a[href]").first();
    href = inner.attr("href");
  }
  return normalizeNavLinkPath(href ?? "", baseUrl);
}

function dedupeInjectedEntries(
  $: cheerio.CheerioAPI,
  entries: InjectedTagEntry[],
  baseUrl = "https://local/"
): { entries: InjectedTagEntry[]; removed: number; logs: string[] } {
  const { entries: kept, removedTagIds, logs } = dedupeBySameHref(entries, {
    getElement: (tagId) => $(`[data-tag-id="${tagId}"]`).first(),
    contains: (ancestorId, descendantId) => {
      const $a = $(`[data-tag-id="${ancestorId}"]`).first();
      return $a.find(`[data-tag-id="${descendantId}"]`).length > 0;
    },
    resolveHref: (tagId) => {
      const $el = $(`[data-tag-id="${tagId}"]`).first();
      return $el.length ? resolveHrefCheerio($, $el, baseUrl) : "";
    },
    leafPriority: (tagId) => {
      const $el = $(`[data-tag-id="${tagId}"]`).first();
      return $el.length ? leafPriorityCheerio($el) : 0;
    },
    isWrapperToExclude: (tagId) => {
      const $el = $(`[data-tag-id="${tagId}"]`).first();
      return $el.length ? shouldExcludeInteractiveWrapper($, $el) : false;
    },
  });

  for (const id of removedTagIds) {
    $(`[data-tag-id="${id}"]`).removeAttr("data-tag-id");
  }

  return { entries: kept, removed: removedTagIds.length, logs: logs.map(formatLinkDedupLog) };
}

/** Assign sequential data-tag-id to every interactive element in raw HTML. */
export function injectTagIds(html: string, maxElements = 500): InjectTagIdsResult {
  const $ = cheerio.load(html);
  const entries: InjectedTagEntry[] = [];
  let nextId = 1;
  let rawMatched = 0;
  let cursorPointerAdded = 0;

  $(INTERACTIVE_SELECTOR).each((_i, node) => {
    rawMatched++;
    if (nextId > maxElements) return false;
    const $el = $(node) as import("cheerio").Cheerio<import("domhandler").Element>;
    if ($el.attr("data-tag-id")) return;
    if (shouldExcludeInteractiveWrapper($, $el)) return;

    const tag = (node as Element).tagName?.toLowerCase?.() ?? String($el.prop("tagName") ?? "").toLowerCase();
    const labeled = labelFromElement(cheerioAttrs($el), $el.text() || "", tag);

    const tagId = nextId++;
    $el.attr("data-tag-id", String(tagId));
    entries.push({
      tag_id: tagId,
      tag,
      text: labeled.text,
      identification_hints: labeled.identification_hints,
    });
  });

  $(CURSOR_POINTER_CHEERIO_SELECTOR).each((_i, node) => {
    rawMatched++;
    if (nextId > maxElements) return false;
    const $el = $(node) as import("cheerio").Cheerio<import("domhandler").Element>;
    if ($el.attr("data-tag-id")) return;
    if (hasPointerAncestor($, $el)) return;
    if (hasInteractiveChild($, $el)) return;
    const innerA = $el.find("a[href]").first();
    if (innerA.length) {
      const h = innerA.attr("href") || "";
      if (normalizeNavLinkPath(h)) return;
    }
    const labelText = pointerLabelText($el);
    if (!labelText || isFilenameLike(labelText)) return;

    const tag = (node as Element).tagName?.toLowerCase?.() ?? "div";
    const labeled = labelFromElement(cheerioAttrs($el), labelText, tag);
    const tagId = nextId++;
    $el.attr("data-tag-id", String(tagId));
    cursorPointerAdded++;
    entries.push({
      tag_id: tagId,
      tag,
      text: labeled.text,
      identification_hints: labeled.identification_hints,
    });
  });

  if (cursorPointerAdded > 0) {
    console.log(`[cursor-pointer 수집] cheerio added=${cursorPointerAdded}`);
  }

  const beforeDedup = entries.length;
  const deduped = dedupeInjectedEntries($, entries);
  if (deduped.removed > 0) {
    console.log(
      `[dedup] candidates_before=${beforeDedup} after=${deduped.entries.length} removed_wrappers=${deduped.removed} (a/button leaf 우선)`
    );
    for (const line of deduped.logs) console.log(line);
  }

  return {
    html: $.html(),
    entries: deduped.entries,
    count: deduped.entries.length,
    stats: {
      raw_matched: rawMatched,
      tagged: deduped.entries.length,
    },
  };
}

/** Build tag_id → cheerio element map (same contract as hydrateSnapshot.byTagId). */
export function indexByTagId(html: string): Map<number, Element> {
  const $ = cheerio.load(html);
  const byTagId = new Map<number, Element>();

  $("[data-tag-id]").each((_i, el) => {
    const raw = $(el).attr("data-tag-id");
    const id = Number.parseInt(raw ?? "", 10);
    if (Number.isFinite(id)) byTagId.set(id, el);
  });

  return byTagId;
}
