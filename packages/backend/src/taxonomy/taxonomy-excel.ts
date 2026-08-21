import { readFile } from "node:fs/promises";
import type {
  TaxonomyCategoryTab,
  TaxonomyUniqueEventRow,
  TaxonomyViewModel,
} from "@autotag/shared";
import ExcelJS from "exceljs";
import { actionCaptureAbsPath } from "../crawl/element-capture.js";
import { captureAbsPath } from "../crawl/page-capture.js";

function safeSheetName(name: string): string {
  return name.replace(/[\\/?*[\]:]/g, "_").slice(0, 31);
}

function normalizedDisplay(value: string | null | undefined): string {
  const text = value?.trim() ?? "";
  return text.toUpperCase() === "FNB" ? "Footer" : text;
}

function rowViewport(row: TaxonomyUniqueEventRow): "pc" | "mo" {
  const platform = row.platform?.trim().toLowerCase() ?? "";
  return platform.includes("mo") || platform.includes("mobile") ? "mo" : "pc";
}

function cellText(value: string | null | undefined): string {
  const t = value?.trim() ?? "";
  return t || "-";
}

const HEADERS = ["이벤트명", "시점", "카테고리", "액션", "라벨", "설명", "액션 이미지"] as const;

const COL_WIDTHS = [16, 32, 22, 22, 22, 42, 36];

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1E3A5F" },
};
const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: "FFFFFFFF" },
  size: 11,
  name: "맑은 고딕",
};
const BODY_FONT: Partial<ExcelJS.Font> = {
  size: 10,
  name: "맑은 고딕",
};
const ZEBRA_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFF5F8FC" },
};
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFD0D7E2" } },
  left: { style: "thin", color: { argb: "FFD0D7E2" } },
  bottom: { style: "thin", color: { argb: "FFD0D7E2" } },
  right: { style: "thin", color: { argb: "FFD0D7E2" } },
};

function eventRowValues(row: TaxonomyUniqueEventRow): string[] {
  const isPageView = row.event_name === "페이지뷰";
  return [
    cellText(row.event_name),
    cellText(row.trigger),
    cellText(normalizedDisplay(row.category_display ?? row.category)),
    isPageView ? "-" : cellText(normalizedDisplay(row.action_display ?? row.action)),
    isPageView ? "-" : cellText(row.label ?? row.label_example),
    cellText(row.description),
    "",
  ];
}

function parseActionImageRef(
  url: string | null | undefined
): { jobId: string; fileKey: string } | null {
  if (!url) return null;
  const m = /\/captures\/([^/]+)\/actions\/([^/?#]+)\.png/i.exec(url);
  if (!m?.[1] || !m[2]) return null;
  return { jobId: m[1], fileKey: m[2] };
}

function parsePageCaptureRef(
  url: string | null | undefined
): { jobId: string; viewport: "pc" | "mo" } | null {
  if (!url) return null;
  const m = /\/captures\/([^/]+)\/(pc|mo)\.png/i.exec(url);
  if (!m?.[1] || !m[2]) return null;
  return { jobId: m[1], viewport: m[2].toLowerCase() as "pc" | "mo" };
}

async function styleEventSheet(
  wb: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  rows: TaxonomyUniqueEventRow[]
): Promise<void> {
  ws.columns = COL_WIDTHS.map((w) => ({ width: w }));

  const header = ws.addRow([...HEADERS]);
  header.height = 22;
  header.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = THIN_BORDER;
  });

  if (!rows.length) {
    const empty = ws.addRow(["데이터 없음", "", "", "", "", "", ""]);
    empty.eachCell((cell) => {
      cell.font = { ...BODY_FONT, italic: true, color: { argb: "FF6B7280" } };
      cell.border = THIN_BORDER;
    });
  } else {
    for (let idx = 0; idx < rows.length; idx += 1) {
      const row = rows[idx]!;
      const excelRow = ws.addRow(eventRowValues(row));
      excelRow.height = 140;
      excelRow.eachCell((cell, colNumber) => {
        cell.font = BODY_FONT;
        cell.border = THIN_BORDER;
        cell.alignment = {
          vertical: "middle",
          horizontal: colNumber <= 2 || colNumber === 7 ? "center" : "left",
          wrapText: true,
        };
        if (idx % 2 === 1) cell.fill = ZEBRA_FILL;
      });

      const actionRef = parseActionImageRef(row.action_image_url);
      const pageRef = parsePageCaptureRef(row.action_image_url);
      if (!actionRef && !pageRef) continue;
      try {
        const buf = actionRef
          ? await readFile(actionCaptureAbsPath(actionRef.jobId, actionRef.fileKey))
          : await readFile(captureAbsPath(pageRef!.jobId, pageRef!.viewport));
        const imageId = wb.addImage({
          buffer: Buffer.from(buf) as unknown as ExcelJS.Buffer,
          extension: "png",
        });
        const excelRowNumber = idx + 2; // 1-based, header is row 1
        ws.addImage(imageId, {
          tl: { col: 6, row: excelRowNumber - 1 },
          ext: { width: 160, height: 160 },
          editAs: "oneCell",
        });
      } catch {
        // image missing — leave blank cell
      }
    }
  }

  ws.views = [{ state: "frozen", ySplit: 1, activeCell: "A2" }];
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, rows.length + 1), column: HEADERS.length },
  };
}

function styleSimpleSheet(
  ws: ExcelJS.Worksheet,
  headers: string[],
  rows: string[][],
  widths: number[]
): void {
  ws.columns = widths.map((w) => ({ width: w }));
  const header = ws.addRow(headers);
  header.height = 22;
  header.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = THIN_BORDER;
  });
  if (!rows.length) {
    const empty = ws.addRow(headers.map((_, i) => (i === 0 ? "데이터 없음" : "")));
    empty.eachCell((cell) => {
      cell.font = { ...BODY_FONT, italic: true, color: { argb: "FF6B7280" } };
      cell.border = THIN_BORDER;
    });
  } else {
    rows.forEach((values, idx) => {
      const excelRow = ws.addRow(values);
      excelRow.eachCell((cell) => {
        cell.font = BODY_FONT;
        cell.border = THIN_BORDER;
        cell.alignment = { vertical: "middle", wrapText: true };
        if (idx % 2 === 1) cell.fill = ZEBRA_FILL;
      });
    });
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

export async function buildTaxonomyWorkbook(vm: TaxonomyViewModel): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "자동태깅";
  wb.created = new Date();

  const eventTabs = vm.tabs.filter(
    (tab): tab is TaxonomyCategoryTab => tab.kind === "page_category"
  );
  const scopedRows = new Map<string, { label: string; rows: TaxonomyUniqueEventRow[]; order: number }>();

  for (const tab of eventTabs) {
    for (const row of tab.event_rows) {
      const viewport = tab.scope === "mo" || tab.scope === "pc" ? tab.scope : rowViewport(row);
      let label = normalizedDisplay(tab.tab_label) || "기타";
      if (tab.scope === "common" && !/_(PC|MO)$/i.test(label)) {
        label = `공통_${viewport.toUpperCase()}`;
      } else if (!/_(PC|MO)$/i.test(label)) {
        label = `${label}_${viewport.toUpperCase()}`;
      }
      const group = scopedRows.get(label) ?? {
        label,
        rows: [],
        order: scopedRows.size,
      };
      group.rows.push(row);
      scopedRows.set(label, group);
    }
  }

  const ordered = [...scopedRows.values()].sort((a, b) => {
    const aCommon = a.label.startsWith("공통_") ? 0 : 1;
    const bCommon = b.label.startsWith("공통_") ? 0 : 1;
    if (aCommon !== bCommon) return aCommon - bCommon;
    const aMo = a.label.endsWith("_MO") ? 1 : 0;
    const bMo = b.label.endsWith("_MO") ? 1 : 0;
    if (aMo !== bMo) return aMo - bMo;
    return a.order - b.order;
  });
  for (const group of ordered) {
    const ws = wb.addWorksheet(safeSheetName(group.label), {
      properties: { defaultRowHeight: 72 },
    });
    await styleEventSheet(wb, ws, group.rows);
  }

  for (const tab of vm.tabs) {
    if (tab.kind === "common") {
      const ws = wb.addWorksheet(safeSheetName("변수사전"), {
        properties: { defaultRowHeight: 18 },
      });
      styleSimpleSheet(
        ws,
        ["파라미터", "타입", "설명", "비고", "예시값"],
        tab.variable_rows.map((r) => [
          cellText(r.name),
          cellText(r.type),
          cellText(r.description),
          cellText(r.note),
          cellText(normalizedDisplay(r.sample_value)),
        ]),
        [16, 10, 36, 20, 20]
      );
    }
  }

  if (!wb.worksheets.length) {
    const empty = wb.addWorksheet("empty");
    await styleEventSheet(wb, empty, []);
  }

  return wb;
}

export async function taxonomyToXlsxBuffer(vm: TaxonomyViewModel): Promise<Buffer> {
  const wb = await buildTaxonomyWorkbook(vm);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
