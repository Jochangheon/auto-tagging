// Lightweight MD converter — tag_id를 보존하는 마크다운
// 링크 형식: [text](tag:12) 또는 [text](data-tag-id="12")

import type { HydratedDocument } from "./hydrate.js";

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "path",
  "meta",
  "link",
  "iframe",
]);

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ul",
  "ol",
  "table",
  "tr",
  "td",
  "th",
  "form",
  "button",
  "a",
]);

/** html_snapshot → 마크다운 (인터랙티브 요소는 tag:ID 링크로 표시) */
export function htmlToTaggedMarkdown(doc: HydratedDocument): string {
  const body = doc.$("body");
  const root = body.length ? body : doc.$.root();
  const lines: string[] = [];
  walkNode(doc, root, lines, 0);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function walkNode(
  doc: HydratedDocument,
  node: ReturnType<HydratedDocument["$"]>,
  lines: string[],
  depth: number
): void {
  node.contents().each((_i, child) => {
    if (child.type === "text") {
      const text = (child.data ?? "").replace(/\s+/g, " ").trim();
      if (text) lines.push(text);
      return;
    }

    if (child.type !== "tag") return;

    const tag = child.tagName?.toLowerCase() ?? "";
    if (SKIP_TAGS.has(tag)) return;

    const $el = doc.$(child);
    const tagId = $el.attr("data-tag-id");
    const text = $el.text().replace(/\s+/g, " ").trim();

    if (tagId && text) {
      lines.push(`[${truncate(text)}](tag:${tagId})`);
      return;
    }

    if (tag.match(/^h[1-6]$/)) {
      const level = Number(tag[1]);
      if (text) lines.push(`${"#".repeat(level)} ${text}`);
      return;
    }

    if (tag === "a" && text) {
      if (tagId) {
        lines.push(`[${truncate(text)}](tag:${tagId})`);
      } else {
        lines.push(`[${truncate(text)}](${$el.attr("href") ?? ""})`);
      }
      return;
    }

    if (tag === "button" && text) {
      if (tagId) {
        lines.push(`[${truncate(text)}](tag:${tagId})`);
      } else {
        lines.push(`**${truncate(text)}**`);
      }
      return;
    }

    if (tag === "img") {
      const alt = $el.attr("alt") ?? "";
      if (alt) lines.push(`![${truncate(alt)}]()`);
      return;
    }

    if (BLOCK_TAGS.has(tag)) {
      const before = lines.length;
      walkNode(doc, $el, lines, depth + 1);
      if (lines.length > before) lines.push("");
      return;
    }

    walkNode(doc, $el, lines, depth + 1);
  });
}

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** ambiguous 후보만 요약 MD 블록 생성 (LLM 컨텍스트용) */
export function candidatesToMarkdown(
  candidates: { tag_id: number; accessible_name: string; tag: string; reason?: string }[]
): string {
  const lines = ["## Ambiguous candidates", ""];
  for (const c of candidates) {
    lines.push(
      `- tag:${c.tag_id} — **${c.accessible_name}** (${c.tag}${c.reason ? `, ${c.reason}` : ""})`
    );
  }
  return lines.join("\n");
}
