import { AsyncLocalStorage } from "node:async_hooks";
// Runtime env loader is intentionally plain ESM because Node imports it before tsx.
// @ts-expect-error The sibling .mjs module has no generated TypeScript declaration.
import { reloadHotEnvKeys } from "../load-env.mjs";

export interface FirecrawlCreditUsage {
  remaining: number | null;
  error?: string;
  raw?: Record<string, unknown>;
}

export interface FirecrawlKeyContext {
  apiKey: string;
  jobId: string;
}

export interface FirecrawlKeyPoolEntry {
  index: number;
  key_hint: string;
  remaining: number | null;
  in_use: boolean;
  active_jobs: number;
  error?: string | null;
}

export interface FirecrawlKeyPoolStatus {
  key_count: number;
  total_remaining: number | null;
  keys: FirecrawlKeyPoolEntry[];
}

const firecrawlKeyContext = new AsyncLocalStorage<FirecrawlKeyContext>();

/** Active job → assigned API key */
const jobKeyMap = new Map<string, string>();
/** API key → number of active jobs */
const keyActiveJobs = new Map<string, number>();
/** jobId → open scrape session ids (key released when all closed) */
const jobScrapeIds = new Map<string, Set<string>>();

const CREDIT_CACHE_MS = 30_000;

function firecrawlApiBase(): string {
  return (process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev").replace(/\/$/, "");
}

function summarizeCreditError(body: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["error", "message", "detail", "_raw_text"]) {
    const val = body[key];
    if (val) parts.push(`${key}=${String(val)}`);
  }
  return parts.length ? parts.join(" | ") : JSON.stringify(body).slice(0, 500);
}

/** GET team credit usage (Firecrawl v2) for a specific API key. */
export async function fetchCreditUsageForKey(apiKey?: string): Promise<FirecrawlCreditUsage> {
  const key = apiKey?.trim() || resolveFirecrawlApiKey();
  try {
    const response = await fetch(`${firecrawlApiBase()}/v2/team/credit-usage`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });

    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      return { remaining: null, error: "invalid JSON from credit-usage" };
    }

    if (response.status >= 400 || body.success === false) {
      return { remaining: null, error: summarizeCreditError(body), raw: body };
    }

    const data = (body.data ?? body) as Record<string, unknown>;
    const remainingCandidates = [
      data.remainingCredits,
      data.remaining_credits,
      data.creditsRemaining,
      data.remaining,
      body.remainingCredits,
      body.remaining_credits,
    ];

    for (const c of remainingCandidates) {
      const n = typeof c === "number" ? c : Number.parseFloat(String(c ?? ""));
      if (Number.isFinite(n)) {
        return { remaining: n, raw: body };
      }
    }

    return { remaining: null, error: "remaining credits field not found", raw: body };
  } catch (err) {
    return { remaining: null, error: err instanceof Error ? err.message : String(err) };
  }
}

let creditCache: { at: number; entries: Map<string, number | null>; keyFingerprint: string } | null =
  null;

function keyFingerprint(keys: string[]): string {
  return keys.join("|");
}

export function getFirecrawlKeyContext(): FirecrawlKeyContext | undefined {
  return firecrawlKeyContext.getStore();
}

export function resolveFirecrawlApiKey(explicit?: string): string {
  const fromContext = firecrawlKeyContext.getStore()?.apiKey?.trim();
  if (fromContext) return fromContext;
  if (explicit?.trim()) return explicit.trim();

  const keys = loadFirecrawlApiKeys();
  if (keys.length) return pickBestFirecrawlKeySync();

  throw new Error("FIRECRAWL_API_KEYS is not set (packages/backend/.env)");
}

export function loadFirecrawlApiKeys(): string[] {
  // Pick up newly added keys from packages/backend/.env without restart
  reloadHotEnvKeys();

  const fromList = (process.env.FIRECRAWL_API_KEYS ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromList.length) return [...new Set(fromList)];

  // Legacy: single-key env (prefer FIRECRAWL_API_KEYS for pools)
  const single = (process.env.FIRECRAWL_API_KEY ?? "").trim();
  if (single) return [single];

  return [];
}

function rankKeysByAvailability(
  keys: string[],
  credits: Map<string, number | null>
): string[] {
  return [...keys].sort((a, b) => {
    const aBusy = activeJobCountForKey(a) > 0 ? 1 : 0;
    const bBusy = activeJobCountForKey(b) > 0 ? 1 : 0;
    if (aBusy !== bBusy) return aBusy - bBusy;

    const aRem = credits.get(a);
    const bRem = credits.get(b);
    const aScore = aRem == null || !Number.isFinite(aRem) ? -1 : aRem;
    const bScore = bRem == null || !Number.isFinite(bRem) ? -1 : bRem;
    return bScore - aScore;
  });
}

/** Best key from cache / idle slots (sync — for calls outside an acquired job). */
export function pickBestFirecrawlKeySync(): string {
  const keys = loadFirecrawlApiKeys();
  if (!keys.length) {
    throw new Error("FIRECRAWL_API_KEYS is not set (packages/backend/.env)");
  }
  if (creditCache) {
    return rankKeysByAvailability(keys, creditCache.entries)[0]!;
  }
  const idle = keys.filter((k) => activeJobCountForKey(k) === 0);
  return idle[0] ?? keys[0]!;
}

/** Best key by remaining credits (async — refreshes pool balances). */
export async function pickBestFirecrawlKey(): Promise<string> {
  const keys = loadFirecrawlApiKeys();
  if (!keys.length) {
    throw new Error("FIRECRAWL_API_KEYS is not set (packages/backend/.env)");
  }
  const credits = await refreshCreditCache(keys);
  return rankKeysByAvailability(keys, credits)[0]!;
}

export function maskFirecrawlApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "****";
  return `…${trimmed.slice(-6)}`;
}

function activeJobCountForKey(key: string): number {
  return keyActiveJobs.get(key) ?? 0;
}

function hasOpenScrapeForJob(jobId: string): boolean {
  const ids = jobScrapeIds.get(jobId);
  return ids != null && ids.size > 0;
}

async function refreshCreditCache(keys: string[]): Promise<Map<string, number | null>> {
  const now = Date.now();
  const fp = keyFingerprint(keys);
  if (
    creditCache &&
    creditCache.keyFingerprint === fp &&
    now - creditCache.at < CREDIT_CACHE_MS
  ) {
    return creditCache.entries;
  }

  const results = await Promise.all(
    keys.map(async (key) => {
      const usage = await fetchCreditUsageForKey(key);
      return [key, usage.remaining] as const;
    })
  );

  const entries = new Map<string, number | null>(results);
  creditCache = { at: now, entries, keyFingerprint: fp };
  return entries;
}

export async function getFirecrawlKeyPoolStatus(): Promise<FirecrawlKeyPoolStatus> {
  const keys = loadFirecrawlApiKeys();
  const credits = await refreshCreditCache(keys);

  const entries: FirecrawlKeyPoolEntry[] = keys.map((key, index) => {
    const remaining = credits.get(key) ?? null;
    const activeJobs = activeJobCountForKey(key);
    return {
      index,
      key_hint: maskFirecrawlApiKey(key),
      remaining,
      in_use: activeJobs > 0,
      active_jobs: activeJobs,
      error: remaining == null ? "remaining credits unavailable" : null,
    };
  });

  const finite = entries
    .map((e) => e.remaining)
    .filter((n): n is number => n != null && Number.isFinite(n));

  return {
    key_count: keys.length,
    total_remaining: finite.length ? finite.reduce((sum, n) => sum + n, 0) : null,
    keys: entries,
  };
}

/** Pick the key with the most remaining credits among keys not currently in use; fallback to highest overall. */
export async function acquireFirecrawlKey(jobId: string): Promise<string> {
  const keys = loadFirecrawlApiKeys();
  if (!keys.length) {
    throw new Error("FIRECRAWL_API_KEYS is not set (packages/backend/.env)");
  }
  if (jobKeyMap.has(jobId)) {
    return jobKeyMap.get(jobId)!;
  }

  const credits = await refreshCreditCache(keys);
  const ranked = rankKeysByAvailability(keys, credits);

  const picked = ranked[0]!;
  jobKeyMap.set(jobId, picked);
  keyActiveJobs.set(picked, activeJobCountForKey(picked) + 1);

  const remaining = credits.get(picked);
  console.log(
    `[firecrawl-pool] job ${jobId.slice(0, 8)} → key ${maskFirecrawlApiKey(picked)}` +
      (remaining != null ? ` (remaining ${remaining})` : "")
  );

  return picked;
}

export function releaseFirecrawlKey(jobId: string): void {
  const key = jobKeyMap.get(jobId);
  if (!key) return;

  jobKeyMap.delete(jobId);
  jobScrapeIds.delete(jobId);

  const next = activeJobCountForKey(key) - 1;
  if (next <= 0) keyActiveJobs.delete(key);
  else keyActiveJobs.set(key, next);

  creditCache = null;
}

export function registerJobScrapeSession(jobId: string, scrapeId: string): void {
  if (!jobId?.trim() || !scrapeId?.trim()) return;
  let set = jobScrapeIds.get(jobId);
  if (!set) {
    set = new Set();
    jobScrapeIds.set(jobId, set);
  }
  set.add(scrapeId);
}

export function releaseJobScrapeSession(jobId: string, scrapeId: string): void {
  if (!jobId?.trim()) return;
  const set = jobScrapeIds.get(jobId);
  if (set) {
    set.delete(scrapeId);
    if (!set.size) jobScrapeIds.delete(jobId);
  }
  if (!hasOpenScrapeForJob(jobId)) {
    releaseFirecrawlKey(jobId);
  }
}

export function getFirecrawlKeyForJob(jobId: string): string | undefined {
  return jobKeyMap.get(jobId);
}

export async function withAcquiredFirecrawlKey<T>(
  jobId: string,
  fn: () => Promise<T>
): Promise<T> {
  const apiKey = await acquireFirecrawlKey(jobId);
  try {
    return await firecrawlKeyContext.run({ apiKey, jobId }, fn);
  } catch (err) {
    if (!hasOpenScrapeForJob(jobId)) {
      releaseFirecrawlKey(jobId);
    }
    throw err;
  }
}

export async function runWithFirecrawlKey<T>(
  apiKey: string,
  jobId: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  return firecrawlKeyContext.run({ apiKey, jobId: jobId ?? "" }, fn);
}
