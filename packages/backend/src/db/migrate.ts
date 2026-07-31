import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSql, getDbMode, getPgPool, query } from "./pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function migrationsDir(): string {
  return join(__dirname, "../../migrations");
}

export async function runMigrations(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const dir = migrationsDir();
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch (err) {
    console.warn("[db] migrations dir missing:", dir, err);
    return;
  }

  for (const file of files) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM schema_migrations WHERE id = $1`,
      [file]
    );
    if (rows.length) continue;

    const sql = readFileSync(join(dir, file), "utf8");
    const dbMode = getDbMode();

    if (dbMode === "pg") {
      const pool = getPgPool();
      if (!pool) throw new Error("pg pool missing");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } else {
      await execSql(sql);
      await query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [file]);
    }
    console.log(`[db] migrated ${file} (${dbMode})`);
  }
}
