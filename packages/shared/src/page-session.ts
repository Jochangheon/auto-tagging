/** Normalize page URL for session dedupe (same page = update, not append). */
export function normalizePageUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    if (u.pathname.endsWith("/") && u.pathname.length > 1) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.href;
  } catch {
    return url.trim();
  }
}

/** Infer display name: og:title → <title> → URL path segment → hostname. */
export function derivePageName(input: {
  title?: string | null;
  ogTitle?: string | null;
  url: string;
}): string {
  const fromMeta = (input.ogTitle || input.title || "").trim();
  if (fromMeta.length >= 2) return fromMeta.slice(0, 80);

  try {
    const u = new URL(input.url);
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length) {
      return decodeURIComponent(segs[segs.length - 1]!).slice(0, 80);
    }
    return u.hostname.replace(/^www\./, "").slice(0, 80);
  } catch {
    return input.url.slice(0, 80);
  }
}
