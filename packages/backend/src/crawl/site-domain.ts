/**
 * Domain helpers for auth session matching.
 * mail.naver.com / www.naver.com / nid.naver.com → same family (naver.com)
 */
const MULTI_PART_TLDS = new Set([
  "co.kr",
  "or.kr",
  "go.kr",
  "ac.kr",
  "ne.kr",
  "re.kr",
  "pe.kr",
  "com.cn",
  "co.jp",
  "co.uk",
  "com.au",
]);

export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\./, "")
    .replace(/^www\./i, "");
}

/** Approximate eTLD+1 (good enough for cookie family matching). */
export function rootDomain(host: string): string {
  const h = normalizeHost(host);
  if (!h || h === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return h;
  const parts = h.split(".").filter(Boolean);
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(last2) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return last2;
}

/** True when both hosts belong to the same site family (share auth cookies). */
export function sameSiteFamily(a: string, b: string): boolean {
  const ra = rootDomain(a);
  const rb = rootDomain(b);
  if (!ra || !rb) return false;
  return ra === rb;
}

export function hostFromUrl(raw: string): string {
  const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
  return normalizeHost(u.hostname);
}

export function rootDomainFromUrl(raw: string): string {
  return rootDomain(hostFromUrl(raw));
}
