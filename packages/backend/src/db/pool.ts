/**
 * DB access: DATABASE_URL → PostgreSQL, else embedded PGlite.
 * Default PGlite dir prefers LOCALAPPDATA on Windows so Korean project paths
 * do not trigger WASM "Aborted()" crashes.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

export type QueryResult<T = Record<string, unknown>> = {
  rows: T[];
  rowCount: number | null;
};

export type DbMode = "pg" | "pglite";

let mode: DbMode | null = null;
let pool: pg.Pool | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pglite: any = null;
let migratePromise: Promise<void> | null = null;
let initPromise: Promise<void> | null = null;

const __dirname = dirname(fileURLToPath(import.meta.url));

export function usesExternalPostgres(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

/** Always on unless DISABLE_DB=1 (PGlite when no DATABASE_URL). */
export function isDatabaseConfigured(): boolean {
  return process.env.DISABLE_DB !== "1";
}

export function getDbMode(): DbMode {
  if (mode) return mode;
  return usesExternalPostgres() ? "pg" : "pglite";
}

function hasNonAscii(s: string): boolean {
  return /[^\x00-\x7F]/.test(s);
}

function pgliteDataDir(): string {
  const custom = process.env.PGLITE_DATA_DIR?.trim();
  if (custom) return custom;
  const localBase =
    process.env.LOCALAPPDATA?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    "";
  const projectDir = join(__dirname, "../../data/pglite");
  // WASM/PGlite often aborts when the data path contains non-ASCII (e.g. 한글).
  if (localBase && hasNonAscii(projectDir)) {
    return join(localBase, "autotag-pglite");
  }
  return projectDir;
}

async function openPglite(dir: string): Promise<void> {
  const { PGlite } = await import("@electric-sql/pglite");
  mkdirSync(dir, { recursive: true });
  pglite = new PGlite(dir);
  await pglite.waitReady;
  mode = "pglite";
  console.log(`[db] using embedded PGlite at ${dir}`);
}

async function initDb(): Promise<void> {
  if (mode) return;
  if (usesExternalPostgres()) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL!.trim(),
      max: Number(process.env.PG_POOL_MAX || 12),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
    });
    pool.on("error", (err) => {
      console.error("[db] pool error:", err.message);
    });
    mode = "pg";
    console.log("[db] using PostgreSQL (DATABASE_URL)");
    return;
  }

  const dir = pgliteDataDir();
  try {
    await openPglite(dir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[db] PGlite open failed (${msg}) — wiping and retrying once`);
    pglite = null;
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    await openPglite(dir);
  }
}

export async function ensureDbReady(): Promise<void> {
  if (!isDatabaseConfigured()) return;
  if (!initPromise) {
    initPromise = initDb().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  await ensureDbReady();
  if (mode === "pg" && pool) {
    const res = await pool.query(text, params);
    return { rows: res.rows as T[], rowCount: res.rowCount };
  }
  if (mode === "pglite" && pglite) {
    const res = await pglite.query(text, params ?? []);
    return {
      rows: (res.rows || []) as T[],
      rowCount:
        typeof res.affectedRows === "number" ? res.affectedRows : (res.rows?.length ?? 0),
    };
  }
  throw new Error("db_not_initialized");
}

/** Multi-statement SQL (migrations). */
export async function execSql(sql: string): Promise<void> {
  await ensureDbReady();
  if (mode === "pg" && pool) {
    await pool.query(sql);
    return;
  }
  if (mode === "pglite" && pglite) {
    await pglite.exec(sql);
    return;
  }
  throw new Error("db_not_initialized");
}

export function getPgPool(): pg.Pool | null {
  return pool;
}

/** Run SQL migrations once per process (idempotent). */
export async function ensureMigrated(): Promise<void> {
  if (!isDatabaseConfigured()) return;
  if (!migratePromise) {
    migratePromise = (async () => {
      await ensureDbReady();
      const { runMigrations } = await import("./migrate.js");
      await runMigrations();
    })().catch((err) => {
      migratePromise = null;
      throw err;
    });
  }
  await migratePromise;
}
