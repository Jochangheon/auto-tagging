// Server-side selector package from hydrated cheerio elements (no browser DOM).

import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import type { DomPathContext, DomLandmark, SelectorStability } from "@autotag/shared";

const DATA_HOOK_ATTRS = ["data-testid", "data-test", "data-qa", "data-cy", "data-id"];
const UNSTABLE_CLASS = /^(css-|sc-|jsx-|_|chakra-|MuiButtonBase|ant-|tw-)/;

export interface CheerioSelectorPackage {
  selector_hint: string;
  selectors_fallback: string[];
  selector_stability: SelectorStability;
  recommended_data_hook: string | null;
}

export function buildSelectorFromCheerio($: CheerioAPI, el: Element): CheerioSelectorPackage {
  const $el = $(el);
  const fallbacks: string[] = [];
  const tag = (el.tagName ?? "").toLowerCase();

  const id = $el.attr("id");
  if (id && isStableToken(id)) {
    return finalize($el, `#${cssEscape(id)}`, fallbacks, "high");
  }

  for (const attr of DATA_HOOK_ATTRS) {
    const v = $el.attr(attr);
    if (v) {
      const hint = `[${attr}="${cssEscape(v)}"]`;
      pushNth($, el, fallbacks);
      return finalize($el, hint, fallbacks, "high");
    }
  }

  const aria = $el.attr("aria-label");
  if (aria) {
    const hint = `${tag}[aria-label="${cssEscape(aria)}"]`;
    pushNth($, el, fallbacks);
    return finalize($el, hint, fallbacks, "medium");
  }

  const role = $el.attr("role");
  const stableClasses = ($el.attr("class") ?? "")
    .split(/\s+/)
    .filter((c) => c && !UNSTABLE_CLASS.test(c));
  if (stableClasses.length > 0) {
    const hint = `${tag}.${stableClasses.map(cssEscape).join(".")}`;
    pushNth($, el, fallbacks);
    if (role) fallbacks.push(`${tag}[role="${cssEscape(role)}"]`);
    return finalize($el, hint, fallbacks, "medium");
  }

  const hint = nthPath($, el);
  return finalize($el, hint, fallbacks, "low");
}

export function parentalContextFromCheerio($: CheerioAPI, el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el.parent && el.parent.type === "tag" ? (el.parent as Element) : null;
  let depth = 0;

  while (cur && depth < 4) {
    const $cur = $(cur);
    const tag = (cur.tagName ?? "").toLowerCase();
    if (["nav", "header", "footer", "main", "section", "form", "aside"].includes(tag)) {
      const aria = $cur.attr("aria-label");
      const id = $cur.attr("id");
      const label = aria || id || tag;
      parts.unshift(label);
    }
    const parentNode = cur.parent as Element | { type?: string } | null | undefined;
    cur = parentNode && parentNode.type === "tag" ? (parentNode as Element) : null;
    depth += 1;
  }

  return parts.join(" > ") || "body";
}

/** Build dom_path context from hydrated cheerio element (HTML snapshot fallback). */
export function domPathContextFromCheerio($: CheerioAPI, el: Element): DomPathContext {
  const chain: string[] = [];
  const labels: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  const MAX_DEPTH = 10;
  const SKIP_TAGS = new Set(["html", "body", "div", "span"]);

  while (cur && depth < MAX_DEPTH) {
    const tag = (cur.tagName ?? "").toLowerCase();
    if (tag === "html") break;
    const $cur = $(cur);
    const isRegion = ["header", "nav", "footer", "main", "section", "aside", "form", "ul", "ol", "li", "menu"].includes(tag);
    const id = $cur.attr("id");
    const hasId = id && isStableToken(id);
    const role = $cur.attr("role");
    if (isRegion || hasId || role || !SKIP_TAGS.has(tag) || depth === 0) {
      chain.unshift(domSegmentFromCheerio($cur, tag));
      const pl = domParentLabelFromCheerio($cur, tag);
      if (pl && !labels.includes(pl)) labels.unshift(pl);
    }
    const parentNode = cur.parent as Element | { type?: string } | null | undefined;
    cur = parentNode && parentNode.type === "tag" ? (parentNode as Element) : null;
    depth += 1;
  }

  return {
    dom_path: chain.join(">"),
    parent_labels: labels.slice(0, 6),
    section_heading: findSectionHeadingFromCheerio($, el),
    landmark: detectLandmarkFromCheerio($, el),
  };
}

function detectLandmarkFromCheerio($: CheerioAPI, el: Element): DomLandmark {
  let inHeader = false;
  let inFooter = false;
  let inMain = false;
  let inNav = false;
  let inMobileNav = false;
  let cur: Element | null = el;
  let depth = 0;
  while (cur && depth < 12) {
    const tag = (cur.tagName ?? "").toLowerCase();
    const $cur = $(cur);
    const role = ($cur.attr("role") ?? "").toLowerCase();
    const cls = ($cur.attr("class") ?? "").toLowerCase();
    const aria = ($cur.attr("aria-label") ?? "").toLowerCase();
    if (tag === "header" || role === "banner") inHeader = true;
    if (tag === "footer" || role === "contentinfo") inFooter = true;
    if (tag === "main") inMain = true;
    if (tag === "nav" || role === "navigation" || role === "menubar") inNav = true;
    if (
      role === "dialog" ||
      role === "menu" ||
      /drawer|side-?menu|offcanvas|mobile-?nav|m-nav|mo-nav|hamburger/.test(`${cls} ${aria}`)
    ) {
      inMobileNav = true;
    }
    const parentNode = cur.parent as Element | { type?: string } | null | undefined;
    cur = parentNode && parentNode.type === "tag" ? (parentNode as Element) : null;
    depth += 1;
  }
  if (inHeader || inMobileNav) return "gnb";
  if (inFooter) return "fnb";
  if (inNav) return "nav";
  if (inMain) return "main";
  return "content";
}

function domSegmentFromCheerio($el: ReturnType<CheerioAPI>, tag: string): string {
  const id = $el.attr("id");
  if (id && isStableToken(id)) return `${tag}#${id.slice(0, 32)}`;
  const aria = $el.attr("aria-label")?.trim();
  if (aria) return `${tag}.${aria.replace(/\s+/g, "").slice(0, 20)}`;
  const role = $el.attr("role");
  if (role && ["navigation", "menu", "menubar", "banner", "contentinfo"].includes(role)) {
    return `${tag}[role=${role}]`;
  }
  const stableClasses = ($el.attr("class") ?? "")
    .split(/\s+/)
    .filter((c) => c && !UNSTABLE_CLASS.test(c));
  if (stableClasses[0] && isStableToken(stableClasses[0])) {
    return `${tag}.${stableClasses[0].slice(0, 24)}`;
  }
  const txt = ($el.text() ?? "").trim().replace(/\s+/g, " ").slice(0, 16);
  if (txt && ["a", "button", "li", "span", "label", "summary"].includes(tag)) {
    return `${tag}.${txt.replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 16)}`;
  }
  return tag;
}

function domParentLabelFromCheerio($el: ReturnType<CheerioAPI>, tag: string): string {
  const aria = $el.attr("aria-label")?.trim();
  if (aria) return aria.slice(0, 40);
  const txt = ($el.text() ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
  if (txt && ["nav", "header", "footer", "li", "button", "a"].includes(tag)) return txt;
  return "";
}

function findSectionHeadingFromCheerio($: CheerioAPI, el: Element): string | null {
  let cur: Element | null = el;
  let depth = 0;
  while (cur && depth < 8) {
    const tag = (cur.tagName ?? "").toLowerCase();
    if (["section", "main", "article", "aside"].includes(tag)) {
      const aria = $(cur).attr("aria-label")?.trim();
      if (aria) return aria.slice(0, 80);
      const h = $(cur).find("h1,h2,h3,h4,h5,h6").first();
      const ht = h.text().trim().replace(/\s+/g, " ");
      if (ht) return ht.slice(0, 80);
    }
    const parentNode = cur.parent as Element | { type?: string } | null | undefined;
    cur = parentNode && parentNode.type === "tag" ? (parentNode as Element) : null;
    depth += 1;
  }
  return null;
}

function finalize(
  $el: ReturnType<CheerioAPI>,
  hint: string,
  fallbacks: string[],
  stability: SelectorStability
): CheerioSelectorPackage {
  const hasHook = DATA_HOOK_ATTRS.some((a) => Boolean($el.attr(a)));
  const deduped = [...new Set(fallbacks.filter((f) => f && f !== hint))];
  return {
    selector_hint: hint,
    selectors_fallback: deduped,
    selector_stability: stability,
    recommended_data_hook: hasHook || stability === "high" ? null : suggestHook($el),
  };
}

function suggestHook($el: ReturnType<CheerioAPI>): string {
  const text = ($el.text() ?? "").trim().toLowerCase();
  const slug =
    text
      .replace(/[^a-z0-9가-힣]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "el";
  return `data-testid="${slug}"`;
}

function pushNth($: CheerioAPI, el: Element, fallbacks: string[]): void {
  fallbacks.push(nthPath($, el));
}

function nthPath($: CheerioAPI, el: Element): string {
  const tag = (el.tagName ?? "").toLowerCase();
  const parent = el.parent;
  if (!parent) return tag;
  const sameTag = parent.children.filter(
    (c) => c.type === "tag" && (c as Element).tagName === el.tagName
  ) as Element[];
  const idx = sameTag.indexOf(el) + 1;
  return `${tag}:nth-of-type(${idx})`;
}

function isStableToken(token: string): boolean {
  if (/^[0-9]+$/.test(token)) return false;
  if (/^(ember|react|radix|headlessui|:r)/i.test(token)) return false;
  return token.length <= 64;
}

export function cssEscape(value: string): string {
  return value.replace(/["\\\]\[#.:>~+*]/g, "\\$&");
}

/** Normalize href from anchor element — keep search; absolute when cross-origin. */
export function linkUrlFromCheerio(
  $: CheerioAPI,
  el: Element,
  baseUrl?: string
): string | null {
  const tag = (el.tagName ?? "").toLowerCase();
  if (tag !== "a") return null;
  const href = $(el).attr("href")?.trim();
  if (!href || href === "#" || href.toLowerCase().startsWith("javascript:")) return null;
  try {
    const resolved = new URL(href, baseUrl || "https://example.local/");
    if (baseUrl) {
      try {
        const base = new URL(baseUrl);
        if (resolved.origin === base.origin) {
          return resolved.pathname + resolved.search;
        }
      } catch {
        /* fall through to absolute */
      }
    }
    // Cross-origin (or unknown base): keep host so destinations stay distinct.
    return resolved.origin + resolved.pathname + resolved.search;
  } catch {
    return href.startsWith("/") ? href : `/${href}`;
  }
}

/**
 * Resolve navigation href for any tagged element: direct <a>, ancestor <a>, or inner <a>.
 * Site-agnostic — used for merge link_url and pre-LLM dedup.
 */
export function resolveNavLinkFromCheerio(
  $: CheerioAPI,
  el: Element,
  baseUrl?: string
): string | null {
  const direct = linkUrlFromCheerio($, el, baseUrl);
  if (direct) return direct;

  let cur: Element | null = el.parent && el.parent.type === "tag" ? (el.parent as Element) : null;
  let depth = 0;
  while (cur && depth < 24) {
    const href = linkUrlFromCheerio($, cur, baseUrl);
    if (href) return href;
    const parentNode = cur.parent as Element | { type?: string } | null | undefined;
    cur = parentNode && parentNode.type === "tag" ? (parentNode as Element) : null;
    depth += 1;
  }

  const inner = $(el).find("a[href]").first();
  if (inner.length) {
    return linkUrlFromCheerio($, inner.get(0)!, baseUrl);
  }

  return null;
}
