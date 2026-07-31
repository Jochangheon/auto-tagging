import { randomUUID } from "node:crypto";
import { normalizePageUrl } from "@autotag/shared";
import type { Cookie } from "playwright";
import {
  hostFromUrl,
  normalizeHost,
  rootDomain,
  rootDomainFromUrl,
  sameSiteFamily,
} from "./site-domain.js";

export interface AuthStorageOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface AuthCookieRecord {
  id: string;
  owner_user_id: string | null;
  site_url: string;
  /** Full host from the URL the user entered (e.g. mail.naver.com). */
  host: string;
  /** Registrable domain used for matching (e.g. naver.com). */
  root_domain: string;
  label: string;
  cookies: Cookie[];
  origins: AuthStorageOrigin[];
  cookie_count: number;
  created_at: string;
  updated_at: string;
}

const byId = new Map<string, AuthCookieRecord>();

function labelFromUrl(raw: string, label?: string): string {
  const trimmed = (label ?? "").trim();
  if (trimmed) return trimmed.slice(0, 80);
  try {
    return hostFromUrl(raw);
  } catch {
    return raw.slice(0, 80);
  }
}

function normalizeCookieDomain(domain: string | undefined, fallbackHost: string): string {
  const d = normalizeHost(domain || fallbackHost);
  return d || fallbackHost;
}

/** Playwright Cookie-compatible objects for addCookies. */
export function parseCookieInput(
  raw: string,
  siteUrl: string
): { cookies: Cookie[]; error?: string } {
  const text = raw.trim();
  if (!text) return { cookies: [], error: "cookies required" };

  let host: string;
  let origin: string;
  try {
    const u = new URL(siteUrl.includes("://") ? siteUrl : `https://${siteUrl}`);
    host = normalizeHost(u.hostname);
    origin = u.origin;
  } catch {
    return { cookies: [], error: "invalid site_url" };
  }

  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { cookies?: unknown }).cookies)
          ? (parsed as { cookies: unknown[] }).cookies
          : null;
      if (!list) return { cookies: [], error: "JSON must be a cookie array or { cookies: [] }" };

      const cookies: Cookie[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const c = item as Record<string, unknown>;
        const name = typeof c.name === "string" ? c.name.trim() : "";
        const value =
          typeof c.value === "string" ? c.value : c.value != null ? String(c.value) : "";
        if (!name) continue;
        const domain = normalizeCookieDomain(
          typeof c.domain === "string" ? c.domain : undefined,
          host
        );
        const path = typeof c.path === "string" && c.path ? c.path : "/";
        cookies.push({
          name,
          value,
          domain: domain.startsWith(".") ? domain : `.${domain}`,
          path,
          expires:
            typeof c.expires === "number" && Number.isFinite(c.expires) ? c.expires : -1,
          secure: c.secure === true || origin.startsWith("https"),
          httpOnly: c.httpOnly === true,
          sameSite:
            c.sameSite === "Lax" || c.sameSite === "Strict" || c.sameSite === "None"
              ? c.sameSite
              : "Lax",
        });
      }
      if (!cookies.length) return { cookies: [], error: "no valid cookies in JSON" };
      return { cookies };
    } catch {
      return { cookies: [], error: "invalid JSON cookies" };
    }
  }

  const cookies: Cookie[] = [];
  for (const part of text.split(";")) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf("=");
    if (eq <= 0) continue;
    const name = seg.slice(0, eq).trim();
    const value = seg.slice(eq + 1).trim();
    if (!name) continue;
    if (/^(path|domain|expires|max-age|secure|httponly|samesite)$/i.test(name)) continue;
    cookies.push({
      name,
      value,
      domain: `.${host}`,
      path: "/",
      expires: -1,
      secure: origin.startsWith("https"),
      httpOnly: false,
      sameSite: "Lax",
    });
  }
  if (!cookies.length) return { cookies: [], error: "no valid name=value cookies" };
  return { cookies };
}

function publicView(rec: AuthCookieRecord): Record<string, unknown> {
  const localStorageCount = rec.origins.reduce(
    (sum, origin) => sum + origin.localStorage.length,
    0
  );
  return {
    id: rec.id,
    site_url: rec.site_url,
    host: rec.host,
    root_domain: rec.root_domain,
    label: rec.label,
    cookie_count: rec.cookie_count,
    local_storage_count: localStorageCount,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    status: "confirmed",
    message: `${rec.label} 로그인 완료 · 세션 유지 중`,
  };
}

export function listAuthCookies(ownerUserId: string | null): Record<string, unknown>[] {
  return [...byId.values()]
    .filter((record) => record.owner_user_id === ownerUserId)
    .map(publicView);
}

export function getAuthCookieRecord(
  id: string,
  ownerUserId: string | null
): AuthCookieRecord | null {
  const record = byId.get(id);
  return record?.owner_user_id === ownerUserId ? record : null;
}

export function deleteAuthCookies(id: string, ownerUserId: string | null): boolean {
  if (!getAuthCookieRecord(id, ownerUserId)) return false;
  return byId.delete(id);
}

export function clearAllAuthCookies(ownerUserId: string | null): void {
  for (const [id, record] of byId) {
    if (record.owner_user_id === ownerUserId) byId.delete(id);
  }
}

export function upsertAuthCookies(input: {
  site_url: string;
  label?: string;
  cookies_raw: string;
  owner_user_id: string | null;
}): { ok: true; record: AuthCookieRecord } | { ok: false; error: string } {
  const siteRaw = input.site_url.trim();
  if (!siteRaw) return { ok: false, error: "site_url required" };

  let host: string;
  let siteUrl: string;
  let root: string;
  try {
    const u = new URL(siteRaw.includes("://") ? siteRaw : `https://${siteRaw}`);
    host = normalizeHost(u.hostname);
    root = rootDomain(host);
    siteUrl = normalizePageUrl(u.href);
  } catch {
    return { ok: false, error: "invalid site_url" };
  }

  const parsed = parseCookieInput(input.cookies_raw, siteUrl);
  if (parsed.error || !parsed.cookies.length) {
    return { ok: false, error: parsed.error ?? "no cookies" };
  }

  for (const [id, rec] of byId) {
    if (rec.root_domain === root && rec.owner_user_id === input.owner_user_id) {
      byId.delete(id);
    }
  }

  const now = new Date().toISOString();
  const record: AuthCookieRecord = {
    id: randomUUID(),
    owner_user_id: input.owner_user_id,
    site_url: siteUrl,
    host,
    root_domain: root,
    label: labelFromUrl(siteUrl, input.label),
    cookies: parsed.cookies,
    origins: [],
    cookie_count: parsed.cookies.length,
    created_at: now,
    updated_at: now,
  };
  byId.set(record.id, record);
  return { ok: true, record };
}

/**
 * Save a full browser storage snapshot from interactive login.
 * Keyed by root domain so mail.naver.com and www.naver.com share one session.
 */
export function upsertAuthSessionState(input: {
  site_url: string;
  label?: string;
  cookies: Cookie[];
  origins?: AuthStorageOrigin[];
  owner_user_id: string | null;
}): Record<string, unknown> {
  const siteRaw = input.site_url.trim();
  if (!siteRaw) throw new Error("site_url required");

  const parsed = new URL(siteRaw.includes("://") ? siteRaw : `https://${siteRaw}`);
  const host = normalizeHost(parsed.hostname);
  const root = rootDomain(host);
  const siteUrl = normalizePageUrl(parsed.href);

  if (!input.cookies.length && !(input.origins?.length)) {
    throw new Error("login_state_not_found");
  }

  for (const [id, rec] of byId) {
    if (rec.root_domain === root && rec.owner_user_id === input.owner_user_id) {
      byId.delete(id);
    }
  }

  const now = new Date().toISOString();
  const record: AuthCookieRecord = {
    id: randomUUID(),
    owner_user_id: input.owner_user_id,
    site_url: siteUrl,
    host,
    root_domain: root,
    label: labelFromUrl(siteUrl, input.label),
    cookies: input.cookies,
    origins: input.origins ?? [],
    cookie_count: input.cookies.length,
    created_at: now,
    updated_at: now,
  };
  byId.set(record.id, record);
  return publicView(record);
}

/** Find stored session that applies to a page URL (root-domain family match). */
export function findAuthCookiesForUrl(
  pageUrl: string,
  ownerUserId: string | null
): AuthCookieRecord | null {
  let pageRoot: string;
  try {
    pageRoot = rootDomainFromUrl(pageUrl);
  } catch {
    return null;
  }

  let best: AuthCookieRecord | null = null;
  for (const rec of byId.values()) {
    if (rec.owner_user_id !== ownerUserId) continue;
    const recRoot = rec.root_domain || rootDomain(rec.host);
    if (recRoot !== pageRoot && !sameSiteFamily(rec.host, pageRoot)) continue;
    if (!best || rec.cookie_count > best.cookie_count) best = rec;
  }
  return best;
}

export function toAuthCookiePublic(rec: AuthCookieRecord): Record<string, unknown> {
  return publicView(rec);
}

/** Filter browser cookies/origins that belong to the site family. */
export function pickSessionForSite(
  siteUrl: string,
  cookies: Cookie[],
  origins: AuthStorageOrigin[]
): { cookies: Cookie[]; origins: AuthStorageOrigin[]; root_domain: string } {
  const root = rootDomainFromUrl(siteUrl);
  const keptCookies = cookies.filter((cookie) => {
    const domain = normalizeHost(cookie.domain || "");
    if (!domain) return false;
    return sameSiteFamily(domain, root) || rootDomain(domain) === root;
  });
  const keptOrigins = origins.filter((origin) => {
    try {
      return sameSiteFamily(new URL(origin.origin).hostname, root);
    } catch {
      return false;
    }
  });
  return { cookies: keptCookies, origins: keptOrigins, root_domain: root };
}
