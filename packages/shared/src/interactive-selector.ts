/** Shared interactive element selector — used by cheerio inject and live DOM eval. */
import { BANNER_INTERACTIVE_SELECTOR } from "./banner-detect.js";

export const INTERACTIVE_SELECTOR =
  "button, a[href], a[class*='btn'], a[class*='button'], a[role='button'], [role='button'], [role='link'], [role='menuitem'], input:not([type='hidden']), select, textarea, label, nav a, header button, header a, [onclick], summary, [role='tab'], [role='option'], [role='checkbox'], [role='radio'], [role='switch'], area[href], footer button, footer a, [data-action], " +
  BANNER_INTERACTIVE_SELECTOR;

/** Cheerio-only hint for pointer-styled blocks (no computed style in cheerio). */
export const CURSOR_POINTER_CHEERIO_SELECTOR =
  "div[class*='cursor-pointer'], span[class*='cursor-pointer'], li[class*='cursor-pointer']";

/** Leaf interactive elements — prefer these over wrapper containers. */
export const INTERACTIVE_LEAF_SELECTOR =
  "a[href], button, [role='button'], [role='link'], input:not([type='hidden']), select, textarea, summary, area[href]";

/** Tags that are native interactive leaves when they carry href/type. */
export const INTERACTIVE_LEAF_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "area",
]);

/** Container tags often duplicated when wrapping a leaf interactive child. */
export const WRAPPER_CONTAINER_TAGS = new Set(["div", "span", "li", "nav", "section", "article"]);

/** Standard interactive tags — skip pointer-parent if child already matches. */
export const INTERACTIVE_CHILD_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "label",
]);

const DATA_ATTR_KEYS = [
  "data-label",
  "data-action",
  "data-testid",
  "data-test-id",
  "data-name",
  "data-id",
  "data-type",
  "data-track",
  "data-ga",
  "data-analytics",
] as const;

export interface ElementLabelResult {
  /** Best display label for UI / accessible_name */
  text: string;
  /** All collected identification hints for LLM (may be empty) */
  identification_hints: string;
}

function filenameFromSrc(src: string | undefined): string {
  if (!src) return "";
  const path = src.split("?")[0] ?? "";
  const file = path.split("/").pop() ?? "";
  return file.slice(0, 80);
}

function collectDataHints(attrs: Record<string, string | undefined>): string[] {
  const hints: string[] = [];
  for (const key of DATA_ATTR_KEYS) {
    const val = attrs[key];
    if (val) hints.push(`${key}=${val.slice(0, 60)}`);
  }
  for (const [key, val] of Object.entries(attrs)) {
    if (!key.startsWith("data-") || !val) continue;
    if (DATA_ATTR_KEYS.includes(key as (typeof DATA_ATTR_KEYS)[number])) continue;
    hints.push(`${key}=${val.slice(0, 60)}`);
    if (hints.length >= 8) break;
  }
  return hints;
}

/** Resolve display label + identification hints from cheerio element attributes. */
export function labelFromElement(
  attrs: Record<string, string | undefined>,
  textContent: string,
  tag: string
): ElementLabelResult {
  const text = textContent.trim().replace(/\s+/g, " ").slice(0, 120);
  const hintParts: string[] = [];

  const aria = attrs["aria-label"]?.trim();
  const title = attrs.title?.trim();
  const placeholder = attrs.placeholder?.trim();
  const alt = attrs.alt?.trim();
  const src = attrs.src;
  const imgFile = filenameFromSrc(src);
  const role = attrs.role?.trim();
  const type = attrs.type?.trim();
  const name = attrs.name?.trim();
  const id = attrs.id?.trim();
  const href = attrs.href?.trim();

  if (aria) hintParts.push(`aria-label=${aria.slice(0, 80)}`);
  if (title) hintParts.push(`title=${title.slice(0, 80)}`);
  if (placeholder) hintParts.push(`placeholder=${placeholder.slice(0, 80)}`);
  if (alt) hintParts.push(`alt=${alt.slice(0, 80)}`);
  if (imgFile) hintParts.push(`img=${imgFile}`);
  if (role) hintParts.push(`role=${role}`);
  if (type) hintParts.push(`type=${type}`);
  if (name) hintParts.push(`name=${name.slice(0, 60)}`);
  if (id) hintParts.push(`id=${id.slice(0, 60)}`);
  if (href) hintParts.push(`href=${href.slice(0, 80)}`);
  hintParts.push(...collectDataHints(attrs));

  const direct =
    text ||
    aria ||
    title ||
    placeholder ||
    alt ||
    imgFile ||
    collectDataHints(attrs)[0]?.split("=")[1] ||
    "";

  const display = direct || `[${tag}${type ? ` type=${type}` : ""}]`;

  return {
    text: display.slice(0, 120),
    identification_hints: hintParts.join(" | ").slice(0, 240),
  };
}

/** @deprecated Use labelFromElement — kept for callers migrating gradually. */
export function labelFromAttrs(
  attrs: Record<string, string | undefined>,
  textContent: string
): string {
  return labelFromElement(attrs, textContent, "element").text;
}

/** Browser-side label + hint helpers injected into page.evaluate strings. */
export const BROWSER_LABEL_FN = `
function dataHints(el) {
  const keys = ${JSON.stringify([...DATA_ATTR_KEYS])};
  const hints = [];
  for (const key of keys) {
    const val = el.getAttribute(key);
    if (val) hints.push(key + "=" + val.slice(0, 60));
  }
  for (const attr of el.attributes || []) {
    if (!attr.name.startsWith("data-") || !attr.value) continue;
    if (keys.includes(attr.name)) continue;
    hints.push(attr.name + "=" + attr.value.slice(0, 60));
    if (hints.length >= 8) break;
  }
  return hints;
}

function imgHint(el) {
  const img = el.tagName === "IMG" ? el : el.querySelector("img[src]");
  if (!img) return { alt: "", file: "" };
  const src = img.getAttribute("src") || "";
  const file = src.split("?")[0].split("/").pop() || "";
  return { alt: img.getAttribute("alt") || "", file: file.slice(0, 80) };
}

function svgHint(el) {
  const svg = el.tagName === "SVG" ? el : el.querySelector("svg");
  if (!svg) return "";
  const t = svg.querySelector("title");
  return (t && t.textContent && t.textContent.trim()) || svg.getAttribute("aria-label") || "";
}

function surroundingText(el) {
  const parent = el.parentElement;
  if (!parent) return "";
  const parts = [];
  for (const child of parent.childNodes) {
    if (child.nodeType === 3) {
      const t = (child.textContent || "").trim();
      if (t) parts.push(t);
    }
  }
  return parts.join(" ").replace(/\\s+/g, " ").slice(0, 80);
}

function resolveElementLabel(el) {
  const tag = el.tagName.toLowerCase();
  let text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120);
  const directP = el.querySelector(":scope > p");
  if (directP) {
    const pText = (directP.textContent || "").trim().replace(/\\s+/g, " ");
    if (pText) text = pText.slice(0, 120);
  }
  const aria = el.getAttribute("aria-label") || "";
  const title = el.getAttribute("title") || "";
  const placeholder = el.getAttribute("placeholder") || "";
  const alt = el.getAttribute("alt") || "";
  const img = imgHint(el);
  const svg = svgHint(el);
  const data = dataHints(el);
  const surround = surroundingText(el);
  const role = el.getAttribute("role") || "";
  const type = el.getAttribute("type") || "";
  const name = el.getAttribute("name") || "";
  const id = el.getAttribute("id") || "";
  const href = el.getAttribute("href") || "";

  const hintParts = [];
  if (aria) hintParts.push("aria-label=" + aria.slice(0, 80));
  if (title) hintParts.push("title=" + title.slice(0, 80));
  if (placeholder) hintParts.push("placeholder=" + placeholder.slice(0, 80));
  if (alt) hintParts.push("alt=" + alt.slice(0, 80));
  if (img.file) hintParts.push("img=" + img.file);
  if (img.alt && img.alt !== alt) hintParts.push("img-alt=" + img.alt.slice(0, 80));
  if (svg) hintParts.push("svg=" + svg.slice(0, 80));
  if (surround && surround !== text) hintParts.push("nearby=" + surround);
  if (role) hintParts.push("role=" + role);
  if (type) hintParts.push("type=" + type);
  if (name) hintParts.push("name=" + name.slice(0, 60));
  if (id) hintParts.push("id=" + id.slice(0, 60));
  if (href) hintParts.push("href=" + href.slice(0, 80));
  for (const d of data) hintParts.push(d);

  const direct = text || aria || title || placeholder || alt || img.alt || img.file || svg || (data[0] && data[0].split("=")[1]) || surround || "";
  const display = direct || ("[" + tag + (type ? " type=" + type : "") + "]");

  return {
    text: display.slice(0, 120),
    identification_hints: hintParts.join(" | ").slice(0, 240),
  };
}

function isPointerLike(el) {
  const tag = el.tagName.toLowerCase();
  if (tag !== "div" && tag !== "span" && tag !== "li") return false;
  const role = String(el.getAttribute("role") || "").toLowerCase();
  if (role === "button" || role === "link" || role === "menuitem" || role === "tab" || role === "option") {
    return true;
  }
  if (el.hasAttribute("onclick") || el.getAttribute("data-action")) return true;
  return false;
}

function hasCollectedInteractiveChild(el, interactiveSel) {
  const leafSel = ${JSON.stringify(INTERACTIVE_LEAF_SELECTOR)};
  for (const child of el.querySelectorAll(leafSel)) {
    if (child === el) continue;
    return true;
  }
  return false;
}

function shouldExcludeInteractiveWrapper(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "a") {
    const href = el.getAttribute("href") || "";
    if (href && href !== "#" && !href.toLowerCase().startsWith("javascript:")) return false;
    const cls = String(el.className || "");
    if (/\\bbtn\\b|button|link-button/i.test(cls)) return false;
  }
  if (tag === "button") return false;
  const role = (el.getAttribute("role") || "").toLowerCase();
  if (role === "button" || role === "link") return false;
  return hasCollectedInteractiveChild(el, null);
}

function leafPriority(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "a" && el.getAttribute("href")) return 100;
  if (tag === "button") return 90;
  const role = (el.getAttribute("role") || "").toLowerCase();
  if (role === "button" || role === "link") return 80;
  if (tag === "input" || tag === "select" || tag === "textarea") return 70;
  return 20;
}

function normalizeLinkUrl(el) {
  const tag = el.tagName.toLowerCase();
  let href = tag === "a" ? el.getAttribute("href") : "";
  if (!href) {
    const inner = el.querySelector("a[href]");
    href = inner ? inner.getAttribute("href") : "";
  }
  if (!href || href.startsWith("#") || href.startsWith("javascript:")) return "";
  try {
    return new URL(href, window.location.href).pathname;
  } catch (_) {
    return href.split("?")[0] || "";
  }
}

function dedupeCollectedEntries(entries) {
  const elById = new Map();
  for (const e of entries) {
    const el = document.querySelector('[data-tag-id="' + e.tag_id + '"]');
    if (el) elById.set(e.tag_id, el);
  }
  const loggedPairs = new Set();
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const ea = entries[i];
      const eb = entries[j];
      const elA = elById.get(ea.tag_id);
      const elB = elById.get(eb.tag_id);
      if (!elA || !elB) continue;
      const hrefA = normalizeLinkUrl(elA);
      const hrefB = normalizeLinkUrl(elB);
      const aContainsB = elA !== elB && elA.contains(elB);
      const bContainsA = elB !== elA && elB.contains(elA);
      if (!aContainsB && !bContainsA) continue;
      if (!hrefA || !hrefB || hrefA !== hrefB) continue;
      const drop =
        aContainsB && !bContainsA
          ? ea.tag_id
          : bContainsA && !aContainsB
            ? eb.tag_id
            : leafPriority(elA) >= leafPriority(elB)
              ? eb.tag_id
              : ea.tag_id;
      const kept = drop === ea.tag_id ? eb.tag_id : ea.tag_id;
      const pairKey = kept + ":" + drop;
      if (!loggedPairs.has(pairKey)) {
        loggedPairs.add(pairKey);
        console.log(
          "[dedup] kept=" + kept + " wrapper_pair=" + drop + " reason=ancestor_same_href url=\\"" + hrefA + "\\" tag_ids=preserved"
        );
      }
    }
  }
  return { entries: entries.slice(), removed_wrappers: 0 };
}

function hasMeaningfulLabel(el) {
  const directP = el.querySelector(":scope > p");
  if (directP) {
    const pText = (directP.textContent || "").trim();
    if (pText.length >= 2) return true;
  }
  const img = el.querySelector(":scope > img[alt], img[alt]");
  if (img) {
    const alt = (img.getAttribute("alt") || "").trim();
    if (alt.length >= 2 && !/\\.(jpe?g|png|webp|gif|svg)$/i.test(alt)) return true;
  }
  const labeled = resolveElementLabel(el);
  const t = labeled.text.trim();
  if (!t || t === "[div]" || t === "[span]" || t === "[li]") return false;
  if (/\\.(jpe?g|png|webp|gif|svg)$/i.test(t)) return false;
  if (/^[\\w-]+\\.(jpe?g|png|webp|gif|svg)$/i.test(t)) return false;
  return t.length >= 2;
}

function hasPointerAncestor(el) {
  let cur = el.parentElement;
  while (cur && cur !== document.body) {
    if (cur !== el && isPointerLike(cur)) return true;
    cur = cur.parentElement;
  }
  return false;
}

function collectPointerLikeElements(interactiveSel) {
  const added = [];
  for (const el of document.querySelectorAll("div, span, li")) {
    if (!isPointerLike(el)) continue;
    if (el.getAttribute("data-tag-id")) continue;
    if (hasPointerAncestor(el)) continue;
    if (hasCollectedInteractiveChild(el, interactiveSel)) continue;
    const innerA = el.querySelector("a[href]");
    if (innerA) {
      const h = innerA.getAttribute("href") || "";
      if (h && !h.startsWith("#") && !h.startsWith("javascript:")) continue;
    }
    if (!hasMeaningfulLabel(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) continue;
    added.push(el);
  }
  return added;
}
`.trim();

/** Minimal tag-assignment loop for live DOM (no bbox collection). Tags every matched element. */
export function buildAssignTagsEvalBody(): string {
  return `
${BROWSER_LABEL_FN}
const sel = ${JSON.stringify(INTERACTIVE_SELECTOR)};
let max = 0;
for (const el of document.querySelectorAll("[data-tag-id]")) {
  const id = parseInt(el.getAttribute("data-tag-id") || "", 10);
  if (Number.isFinite(id) && id > max) max = id;
}
let nextId = max + 1;
for (const el of document.querySelectorAll(sel)) {
  if (nextId > 500) break;
  if (el.getAttribute("data-tag-id")) continue;
  el.setAttribute("data-tag-id", String(nextId++));
}
`.trim();
}

