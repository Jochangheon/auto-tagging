import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { ElementPosition, ViewportMode } from "@autotag/shared";
import { captureAbsPath } from "../crawl/page-capture.js";
import { callOpenRouterVision } from "./openrouter.js";

export type PositionValidationStatus = "ok" | "suspicious" | "wrong";

export interface PositionValidationIssue {
  tag_id: number;
  status: PositionValidationStatus;
  reason: string;
}

export interface PositionValidationReport {
  ok: boolean;
  model: string;
  checked_count: number;
  summary: string;
  issues: PositionValidationIssue[];
}

const SYSTEM = `You are a strict visual QA reviewer for web analytics element bounding boxes.
The supplied full-page screenshot has every recorded element outlined and labeled with its numeric tag_id.
Check whether each rectangle tightly covers the visible interactive control identified by its label.
Flag boxes that are shifted, cover unrelated content, are implausibly large/small, or do not cover a visible control.
Do not flag a correct box merely because several controls are close together.
Return JSON only:
{
  "summary": "short Korean summary",
  "issues": [
    { "tag_id": 12, "status": "suspicious", "reason": "short Korean reason" }
  ]
}
status must be "suspicious" or "wrong". Omit correct elements from issues.`;

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    }
    throw new Error("position_vision_json_parse_failed");
  }
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    const map: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      "\"": "&quot;",
    };
    return map[char] ?? char;
  });
}

function deterministicIssues(
  positions: ElementPosition[],
  width: number,
  height: number
): PositionValidationIssue[] {
  const issues: PositionValidationIssue[] = [];
  for (const position of positions) {
    const b = position.bbox;
    if (!b) continue;
    if (b.x < 0 || b.y < 0 || b.x + b.w > width + 2 || b.y + b.h > height + 2) {
      issues.push({
        tag_id: position.tag_id,
        status: "wrong",
        reason: "박스가 캡처 이미지 범위를 벗어났습니다.",
      });
    } else if (b.w < 3 || b.h < 3) {
      issues.push({
        tag_id: position.tag_id,
        status: "wrong",
        reason: "박스 크기가 지나치게 작습니다.",
      });
    } else if (b.w * b.h > width * height * 0.8) {
      issues.push({
        tag_id: position.tag_id,
        status: "suspicious",
        reason: "단일 요소 박스가 페이지 대부분을 덮습니다.",
      });
    }
  }
  return issues;
}

function normalizeAiIssues(raw: unknown, validIds: Set<number>): PositionValidationIssue[] {
  if (!Array.isArray(raw)) return [];
  const issues: PositionValidationIssue[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const tagId = Number(row.tag_id);
    if (!Number.isInteger(tagId) || !validIds.has(tagId)) continue;
    const status = row.status === "wrong" ? "wrong" : "suspicious";
    const reason = String(row.reason ?? "AI가 위치를 재확인해야 한다고 판단했습니다.").slice(0, 240);
    issues.push({ tag_id: tagId, status, reason });
  }
  return issues;
}

export async function verifyElementPositionsWithVision(input: {
  jobId: string;
  viewport: ViewportMode;
  positions: ElementPosition[];
}): Promise<PositionValidationReport> {
  const positions = input.positions.filter(
    (position) =>
      position.tag_id > 0 &&
      position.bbox &&
      position.bbox.w > 0 &&
      position.bbox.h > 0
  );
  if (!positions.length) throw new Error("positions_missing");

  const capture = await readFile(captureAbsPath(input.jobId, input.viewport));
  const metadata = await sharp(capture).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) throw new Error("invalid_capture_size");

  const labelSize = Math.max(18, Math.min(34, Math.round(width / 45)));
  const stroke = Math.max(3, Math.round(width / 500));
  const rectangles = positions
    .map((position) => {
      const b = position.bbox!;
      const label = String(position.tag_id);
      const labelWidth = Math.max(labelSize * 1.4, label.length * labelSize * 0.72);
      const labelY = Math.max(0, b.y - labelSize - 6);
      return `<g>
        <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="rgba(14,165,233,0.16)" stroke="#0ea5e9" stroke-width="${stroke}" />
        <rect x="${b.x}" y="${labelY}" width="${labelWidth}" height="${labelSize + 6}" rx="3" fill="#0c4a6e" />
        <text x="${b.x + 5}" y="${labelY + labelSize}" font-family="Arial,sans-serif" font-size="${labelSize}" font-weight="700" fill="#ffffff">${escapeXml(label)}</text>
      </g>`;
    })
    .join("");
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rectangles}</svg>`
  );

  const targetWidth = Math.min(width, 1800);
  const annotated = await sharp(capture)
    .composite([{ input: svg, top: 0, left: 0 }])
    .resize({ width: targetWidth, withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  const imageUrl = `data:image/jpeg;base64,${annotated.toString("base64")}`;

  const rows = positions.map((position) => ({
    tag_id: position.tag_id,
    text: position.text?.slice(0, 100) ?? "",
    bbox: position.bbox,
  }));
  const { text, model } = await callOpenRouterVision(
    SYSTEM,
    `Image size before display scaling: ${width}×${height}px.\nRecorded elements:\n${JSON.stringify(rows)}`,
    imageUrl,
    { jsonMode: true, temperature: 0.1, maxTokens: 4096 }
  );
  const parsed = parseJsonObject(text);
  const validIds = new Set(positions.map((position) => position.tag_id));
  const byId = new Map<number, PositionValidationIssue>();
  for (const issue of deterministicIssues(positions, width, height)) byId.set(issue.tag_id, issue);
  for (const issue of normalizeAiIssues(parsed.issues, validIds)) {
    const current = byId.get(issue.tag_id);
    if (!current || issue.status === "wrong") byId.set(issue.tag_id, issue);
  }
  const issues = [...byId.values()].sort((a, b) => a.tag_id - b.tag_id);
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 500)
      : issues.length
        ? `${issues.length}개 위치를 재확인해야 합니다.`
        : "표시된 위치에서 뚜렷한 이상을 찾지 못했습니다.";

  return {
    ok: issues.length === 0,
    model,
    checked_count: positions.length,
    summary,
    issues,
  };
}
