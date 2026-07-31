import { refreshLiveViewSession, type FirecrawlSession } from "./firecrawl-interact.js";
import type { LiveViewSessionMeta } from "./liveview-session.js";

type SessionGetter = () => FirecrawlSession | null;
type OnRefreshed = (session: FirecrawlSession) => void;

const timers = new Map<string, ReturnType<typeof setInterval>>();

function keepaliveIntervalSec(meta?: LiveViewSessionMeta | null): number {
  const fromEnv = Number(process.env.FIRECRAWL_KEEPALIVE_INTERVAL_SEC);
  if (Number.isFinite(fromEnv) && fromEnv >= 30) return Math.floor(fromEnv);
  const activity = meta?.activity_ttl_sec ?? 300;
  return Math.max(60, Math.floor(activity / 3));
}

/** Ping interact periodically so Firecrawl activity TTL does not expire the session. */
export function startLiveSessionKeepalive(
  scrapeId: string,
  getSession: SessionGetter,
  onRefreshed?: OnRefreshed
): void {
  stopLiveSessionKeepalive(scrapeId);

  const session = getSession();
  const intervalSec = keepaliveIntervalSec(session?.liveViewMeta);
  const intervalMs = intervalSec * 1000;

  const tick = async (): Promise<void> => {
    const current = getSession();
    if (!current || current.scrapeId !== scrapeId) return;
    try {
      const result = await refreshLiveViewSession(current);
      if (result.ok) {
        onRefreshed?.(result.session);
      } else {
        console.warn(`[keepalive] refresh failed scrapeId=${scrapeId.slice(0, 8)}`, result.error);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[keepalive] ping error scrapeId=${scrapeId.slice(0, 8)}`, message);
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timers.set(scrapeId, timer);
  setTimeout(() => void tick(), Math.floor(intervalMs / 2));
}

export function stopLiveSessionKeepalive(scrapeId?: string): void {
  if (scrapeId) {
    const timer = timers.get(scrapeId);
    if (timer) clearInterval(timer);
    timers.delete(scrapeId);
    return;
  }
  for (const timer of timers.values()) clearInterval(timer);
  timers.clear();
}
