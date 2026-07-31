/** Page-level facts collected by code (not LLM). */
export interface PageContextSnapshot {
  page_location: string;
  page_path: string;
  page_title: string;
  page_referrer: string;
}

/** Derive page context from URL + optional document title (server-side fallback). */
export function pageContextFromUrl(url: string, pageTitle = "", pageReferrer = ""): PageContextSnapshot {
  let page_location = url;
  let page_path = "/";
  try {
    const u = new URL(url);
    page_location = u.href;
    page_path = u.pathname + u.search + u.hash;
  } catch {
    page_path = url.startsWith("/") ? url : `/${url}`;
  }
  return {
    page_location,
    page_path,
    page_title: pageTitle.trim(),
    page_referrer: pageReferrer.trim(),
  };
}

/** Code-side hint for page_category before LLM refinement. */
export function inferPageCategoryHint(ctx: PageContextSnapshot): string {
  const title = ctx.page_title.trim();
  if (title) {
    const cleaned = title
      .replace(/\s*[|\-–—]\s*.+$/, "")
      .replace(/\s*-\s*.+$/, "")
      .trim();
    if (cleaned.length >= 2 && cleaned.length <= 40) return cleaned;
  }

  try {
    const segments = new URL(ctx.page_location).pathname
      .split("/")
      .filter(Boolean)
      .map((s) => decodeURIComponent(s).replace(/[-_]+/g, " "));
    if (segments.length > 0) {
      const last = segments[segments.length - 1]!;
      if (last.length >= 2) return last.slice(0, 40);
    }
  } catch {
    /* ignore */
  }

  return "페이지";
}

/** Browser-side page context — injected into page.evaluate strings. */
export const BROWSER_PAGE_CONTEXT_FN = `
function collectPageContextSnapshot() {
  var loc = window.location;
  return {
    page_location: loc.href,
    page_path: loc.pathname + loc.search + loc.hash,
    page_title: (document.title || "").trim(),
    page_referrer: (document.referrer || "").trim(),
  };
}
`.trim();
