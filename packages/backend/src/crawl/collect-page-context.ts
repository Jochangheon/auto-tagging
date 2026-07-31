import type { Page } from "playwright";
import type { PageContextSnapshot } from "@autotag/shared";
import { BROWSER_PAGE_CONTEXT_FN, pageContextFromUrl } from "@autotag/shared";
import { load } from "cheerio";

/** Collect page facts from live CDP page. */
export async function collectPageContextFromPage(page: Page): Promise<PageContextSnapshot> {
  return page.evaluate(`(() => { ${BROWSER_PAGE_CONTEXT_FN}; return collectPageContextSnapshot(); })()`) as Promise<PageContextSnapshot>;
}

/** Collect page facts from hydrated HTML + URL (no browser). */
export function collectPageContextFromHtml(html: string, url: string): PageContextSnapshot {
  const $ = load(html);
  const title = $("title").first().text().trim();
  return pageContextFromUrl(url, title);
}
