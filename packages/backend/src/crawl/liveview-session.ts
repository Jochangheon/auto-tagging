import type { FirecrawlInteractResult } from "./firecrawl-interact.js";

/** Firecrawl interact session defaults (https://docs.firecrawl.dev/features/browser). */
export const FIRECRAWL_DEFAULT_TTL_SEC = 1800;
export const FIRECRAWL_DEFAULT_ACTIVITY_TTL_SEC = 600;
export interface LiveViewSessionMeta {
  created_at: string;
  expires_at: string;
  ttl_sec: number;
  activity_ttl_sec: number;
  live_view_url: string | null;
}

function parseExpiresAt(raw: unknown): Date | null {
  if (raw == null || raw === "") return null;
  const d = new Date(String(raw));
  return Number.isFinite(d.getTime()) ? d : null;
}

function pickLiveViewUrlFromInteract(boot: FirecrawlInteractResult): string | null {
  return (
    boot.interactiveLiveViewUrl ??
    boot.interactive_live_view_url ??
    boot.liveViewUrl ??
    boot.live_view_url ??
    null
  );
}

/** Build session timing metadata from an interact bootstrap/refresh response. */
export function buildLiveViewSessionMeta(
  boot: FirecrawlInteractResult,
  fallbackUrl: string | null = null
): LiveViewSessionMeta {
  const created = new Date();
  const expiresFromApi = parseExpiresAt(boot.expiresAt ?? boot.expires_at);
  const ttlFromApi =
    typeof boot.ttl === "number" && boot.ttl > 0 ? boot.ttl : FIRECRAWL_DEFAULT_TTL_SEC;
  const activityTtl =
    typeof boot.activityTtl === "number" && boot.activityTtl > 0
      ? boot.activityTtl
      : typeof boot.activity_ttl === "number" && boot.activity_ttl > 0
        ? boot.activity_ttl
        : FIRECRAWL_DEFAULT_ACTIVITY_TTL_SEC;

  const expires =
    expiresFromApi ??
    new Date(created.getTime() + (ttlFromApi || FIRECRAWL_DEFAULT_TTL_SEC) * 1000);

  const ttlSec = Math.max(
    1,
    Math.round((expires.getTime() - created.getTime()) / 1000) || FIRECRAWL_DEFAULT_TTL_SEC
  );

  return {
    created_at: created.toISOString(),
    expires_at: expires.toISOString(),
    ttl_sec: ttlSec,
    activity_ttl_sec: activityTtl,
    live_view_url: pickLiveViewUrlFromInteract(boot) ?? fallbackUrl,
  };
}

export function liveViewRemainingSec(meta: LiveViewSessionMeta, now = Date.now()): number {
  return Math.max(0, Math.round((new Date(meta.expires_at).getTime() - now) / 1000));
}

export function isLiveViewExpired(meta: LiveViewSessionMeta, now = Date.now()): boolean {
  return liveViewRemainingSec(meta, now) <= 0;
}

export function logLiveViewSession(meta: LiveViewSessionMeta, label = "created"): void {
  const remaining = liveViewRemainingSec(meta);
  console.log(
    `[liveview-session] ${label} created=${meta.created_at} ttl=${meta.ttl_sec}s ` +
      `activity_ttl=${meta.activity_ttl_sec}s now=${new Date().toISOString()} ` +
      `remaining=${remaining}s expires=${meta.expires_at}`
  );
}

/** Server-side probe — detects Unauthorized JSON from live view embed. */
export async function probeLiveViewUrl(url: string): Promise<{
  ok: boolean;
  status: number;
  unauthorized: boolean;
  body_snippet: string;
}> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    const text = (await res.text()).slice(0, 500);
    const unauthorized =
      res.status === 401 ||
      res.status === 403 ||
      /unauthorized/i.test(text) ||
      (text.includes('"error"') && /unauthorized/i.test(text));
    return {
      ok: res.ok && !unauthorized,
      status: res.status,
      unauthorized,
      body_snippet: text.slice(0, 120),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, unauthorized: false, body_snippet: message.slice(0, 120) };
  }
}
