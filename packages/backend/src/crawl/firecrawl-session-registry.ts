import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getFirecrawlKeyContext, registerJobScrapeSession } from "./firecrawl-key-pool.js";
import { stopInteraction } from "./firecrawl-interact.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, "../../.firecrawl-open-sessions.json");

export interface ScrapeSessionMeta {
  scrapeId: string;
  apiKey?: string;
  jobId?: string;
}

interface RegistryFile {
  sessions?: ScrapeSessionMeta[];
  scrapeIds?: string[];
}

function readRegistry(): ScrapeSessionMeta[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as RegistryFile;
    if (Array.isArray(parsed.sessions)) {
      return parsed.sessions.filter(
        (s): s is ScrapeSessionMeta =>
          typeof s?.scrapeId === "string" && s.scrapeId.trim().length > 0
      );
    }
    if (Array.isArray(parsed.scrapeIds)) {
      return parsed.scrapeIds
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((scrapeId) => ({ scrapeId }));
    }
    return [];
  } catch {
    return [];
  }
}

function writeRegistry(sessions: ScrapeSessionMeta[]): void {
  const dir = dirname(REGISTRY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    REGISTRY_PATH,
    JSON.stringify(
      {
        sessions: sessions.map((s) => ({
          scrapeId: s.scrapeId,
          ...(s.apiKey ? { apiKey: s.apiKey } : {}),
          ...(s.jobId ? { jobId: s.jobId } : {}),
        })),
      },
      null,
      2
    ),
    "utf8"
  );
}

export function getScrapeSessionMeta(scrapeId: string): ScrapeSessionMeta | undefined {
  return readRegistry().find((s) => s.scrapeId === scrapeId);
}

export function registerOpenScrapeId(scrapeId: string): void {
  if (!scrapeId?.trim()) return;
  const ctx = getFirecrawlKeyContext();
  const sessions = readRegistry();
  if (!sessions.some((s) => s.scrapeId === scrapeId)) {
    sessions.push({
      scrapeId,
      apiKey: ctx?.apiKey,
      jobId: ctx?.jobId,
    });
    writeRegistry(sessions);
  }
  if (ctx?.jobId) {
    registerJobScrapeSession(ctx.jobId, scrapeId);
  }
}

export function unregisterOpenScrapeId(scrapeId: string): void {
  if (!scrapeId?.trim()) return;
  writeRegistry(readRegistry().filter((s) => s.scrapeId !== scrapeId));
}

/** Stop all scrape interact sessions tracked on disk (survives dev-server restarts). */
export async function cleanupRegisteredSessions(): Promise<number> {
  const sessions = readRegistry();
  if (!sessions.length) return 0;

  let stopped = 0;
  for (const session of sessions) {
    await stopInteraction(session.scrapeId, session.apiKey);
    stopped++;
  }
  writeRegistry([]);
  if (stopped > 0) {
    console.log(`[firecrawl] cleaned up ${stopped} registered interact session(s)`);
  }
  return stopped;
}
