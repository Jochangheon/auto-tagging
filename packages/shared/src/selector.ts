// Selector cascade + fallback resolution (extension selector.ts + Phase 0 spike)

import type { UiTarget } from "./schema.js";

const DATA_HOOK_ATTRS = ["data-testid", "data-test", "data-qa", "data-cy", "data-id"];
const UNSTABLE_CLASS = /^(css-|sc-|jsx-|_|chakra-|MuiButtonBase|ant-|tw-)/;

export interface SelectorResolveResult {
  selector_hint: string;
  selectors_fallback: string[];
  selector_stability: UiTarget["selector_stability"];
  resolved_selector: string | null;
  resolved_via: "hint" | "fallback" | null;
  hint_match_count: number;
  resolved_match_count: number;
  hint_unique_match: boolean;
  unique_match: boolean;
}

/** Build primary selector package for an element (browser DOM). */
export function buildSelector(el: Element): UiTarget {
  const fallbacks: string[] = [];

  if (el.id && isStableToken(el.id)) {
    const hint = `#${cssEscape(el.id)}`;
    return finalize(el, hint, fallbacks, "high");
  }

  for (const attr of DATA_HOOK_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) {
      const hint = `[${attr}="${cssEscape(v)}"]`;
      pushNth(el, fallbacks);
      return finalize(el, hint, fallbacks, "high");
    }
  }

  const role = el.getAttribute("role");
  const aria = el.getAttribute("aria-label");
  if (aria) {
    const hint = `${el.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`;
    pushNth(el, fallbacks);
    return finalize(el, hint, fallbacks, "medium");
  }

  const stableClasses = [...el.classList].filter((c) => !UNSTABLE_CLASS.test(c));
  if (stableClasses.length > 0) {
    const hint = `${el.tagName.toLowerCase()}.${stableClasses.map(cssEscape).join(".")}`;
    pushNth(el, fallbacks);
    if (role) fallbacks.push(`${el.tagName.toLowerCase()}[role="${cssEscape(role)}"]`);
    return finalize(el, hint, fallbacks, "medium");
  }

  const hint = nthPath(el);
  return finalize(el, hint, fallbacks, "low");
}

/** Resolve a unique CSS selector; tries hint then scoped fallbacks (Phase 0 spike). */
export function resolveUniqueSelector(el: Element, root: Document | Element = el.ownerDocument ?? (el as unknown as Document)): SelectorResolveResult {
  const built = buildSelector(el);
  const hint = built.selector_hint;
  const hintMatches = matchCount(root, hint);
  const candidates = [hint, ...built.selectors_fallback, ...generateScopedFallbacks(el, hint, root)];

  const seen = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    const sel = candidates[i];
    if (!sel || seen.has(sel)) continue;
    seen.add(sel);

    if (testUnique(root, el, sel)) {
      return {
        selector_hint: hint,
        selectors_fallback: built.selectors_fallback,
        selector_stability: built.selector_stability,
        resolved_selector: sel,
        resolved_via: i === 0 ? "hint" : "fallback",
        hint_match_count: hintMatches,
        resolved_match_count: 1,
        hint_unique_match: hintMatches === 1,
        unique_match: true,
      };
    }
  }

  return {
    selector_hint: hint,
    selectors_fallback: built.selectors_fallback,
    selector_stability: built.selector_stability,
    resolved_selector: null,
    resolved_via: null,
    hint_match_count: hintMatches,
    resolved_match_count: 0,
    hint_unique_match: false,
    unique_match: false,
  };
}

function finalize(
  el: Element,
  hint: string,
  fallbacks: string[],
  stability: UiTarget["selector_stability"]
): UiTarget {
  const hasHook = DATA_HOOK_ATTRS.some((a) => el.getAttribute(a));
  const dedupedFallbacks = [...new Set(fallbacks.filter((f) => f && f !== hint))];
  return {
    selector_hint: hint,
    selectors_fallback: dedupedFallbacks,
    selector_stability: stability,
    recommended_data_hook: hasHook || stability === "high" ? null : suggestHook(el),
    overlay_bbox: bbox(el),
  };
}

function suggestHook(el: Element): string {
  const text = (el.textContent ?? "").trim().toLowerCase();
  const slug = text.replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "el";
  return `data-testid="${slug}"`;
}

function pushNth(el: Element, fallbacks: string[]): void {
  fallbacks.push(nthPath(el));
}

function nthPath(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  const sameTag = [...parent.children].filter((c) => c.tagName === el.tagName);
  const idx = sameTag.indexOf(el) + 1;
  return `${tag}:nth-of-type(${idx})`;
}

function segmentFor(el: Element): string {
  if (el.id && isStableToken(el.id)) {
    return `#${cssEscape(el.id)}`;
  }
  const tag = el.tagName.toLowerCase();
  const stableClasses = [...el.classList].filter((c) => !UNSTABLE_CLASS.test(c));
  let seg = tag;
  if (stableClasses.length > 0) {
    seg += `.${stableClasses.slice(0, 3).map(cssEscape).join(".")}`;
  }
  const parent = el.parentElement;
  if (parent) {
    const sameTag = [...parent.children].filter((c) => c.tagName === el.tagName);
    if (sameTag.length > 1) {
      const idx = sameTag.indexOf(el) + 1;
      seg += `:nth-of-type(${idx})`;
    }
  }
  return seg;
}

function documentElementOf(root: Document | Element): Element | null {
  if ("documentElement" in root && root.documentElement) {
    return root.documentElement;
  }
  return root.ownerDocument?.documentElement ?? null;
}

function buildAncestorPath(el: Element, maxDepth: number, root: Document | Element): string {
  const docEl = documentElementOf(root);
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; depth < maxDepth && cur && cur !== docEl; depth++) {
    parts.unshift(segmentFor(cur));
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

function generateScopedFallbacks(el: Element, hint: string, root: Document | Element): string[] {
  const docEl = documentElementOf(root);
  const out: string[] = [];
  let parent = el.parentElement;

  for (let depth = 0; depth < 6 && parent && parent !== docEl; depth++) {
    const parentSeg = segmentFor(parent);
    const childTag = el.tagName.toLowerCase();
    const childIdxAmongSiblings = [...parent.children].indexOf(el) + 1;
    out.push(`${parentSeg} > ${childTag}:nth-child(${childIdxAmongSiblings})`);
    out.push(`${parentSeg} > ${hint}`);

    if (parent.tagName === "LI" && parent.parentElement) {
      const listParent = parent.parentElement;
      const liIdx = [...listParent.children].filter((c) => c.tagName === "LI").indexOf(parent) + 1;
      const listSeg = segmentFor(listParent);
      out.push(`${listSeg} > li:nth-of-type(${liIdx}) > ${hint}`);
      out.push(`${listSeg} > li:nth-of-type(${liIdx}) > ${childTag}`);
    }

    const chain: string[] = [];
    let node: Element | null = el;
    for (let i = 0; i <= depth + 1 && node && node !== docEl; i++) {
      chain.unshift(segmentFor(node));
      node = node.parentElement;
    }
    if (chain.length > 1) {
      out.push(chain.join(" > "));
    }

    parent = parent.parentElement;
  }

  for (const depth of [2, 3, 4, 5, 6]) {
    out.push(buildAncestorPath(el, depth, root));
  }

  return dedupe(out);
}

function dedupe(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))];
}

function testUnique(root: Document | Element, el: Element, selector: string): boolean {
  try {
    const matches = root.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === el;
  } catch {
    return false;
  }
}

function matchCount(root: Document | Element, selector: string): number {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return -1;
  }
}

function bbox(el: Element): UiTarget["overlay_bbox"] {
  const r = (el as HTMLElement).getBoundingClientRect?.();
  if (!r || (r.width === 0 && r.height === 0)) return null;
  const scrollX = typeof window !== "undefined" ? window.scrollX : 0;
  const scrollY = typeof window !== "undefined" ? window.scrollY : 0;
  return {
    x: Math.round(r.x + scrollX),
    y: Math.round(r.y + scrollY),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

function isStableToken(token: string): boolean {
  if (/^[0-9]+$/.test(token)) return false;
  if (/^(ember|react|radix|headlessui|:r)/i.test(token)) return false;
  return token.length <= 64;
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\\]\[#.:>~+*]/g, "\\$&");
}
