// Virtual hydration — cheerio로 html_snapshot 파싱 (Playwright 불필요 PoC)

import * as cheerio from "cheerio";
import type { Element } from "domhandler";

export interface HydratedDocument {
  $: cheerio.CheerioAPI;
  /** data-tag-id → cheerio Element */
  byTagId: Map<number, Element>;
}

/** HTML 문자열을 cheerio 문서로 로드하고 data-tag-id 인덱스 구축 */
export function hydrateSnapshot(html: string): HydratedDocument {
  const $ = cheerio.load(html);
  const byTagId = new Map<number, Element>();

  $("[data-tag-id]").each((_i, el) => {
    const raw = $(el).attr("data-tag-id");
    const id = Number.parseInt(raw ?? "", 10);
    if (Number.isFinite(id)) byTagId.set(id, el);
  });

  return { $, byTagId };
}

/** tag_id로 hydrated DOM에서 요소 조회 */
export function findByTagId(doc: HydratedDocument, tagId: number): cheerio.Cheerio<Element> | null {
  const el = doc.byTagId.get(tagId);
  if (!el) return null;
  return doc.$(el);
}
