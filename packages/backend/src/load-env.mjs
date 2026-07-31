// Load .env before server modules read process.env (no dotenv dependency).
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BACKEND_ENV = resolve(__dirname, "../.env");
const ROOT_ENV = resolve(__dirname, "../../../.env");

/** Keys that must track packages/backend/.env without requiring a process restart. */
const HOT_RELOAD_KEYS = new Set([
  "FIRECRAWL_API_KEYS",
  "FIRECRAWL_API_KEY",
  "FIRECRAWL_API_URL",
]);

function parseEnvLine(rawLine) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return null;
  const eq = line.indexOf("=");
  if (eq <= 0) return null;
  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function loadEnvFile(filePath, { overwriteKeys = null } = {}) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(rawLine);
    if (!parsed) continue;
    const { key, value } = parsed;
    const force = overwriteKeys?.has(key);
    if (force || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Re-apply hot-reload keys from disk so FIRECRAWL_API_KEYS edits
 * are picked up without restarting the Node process.
 */
export function reloadHotEnvKeys() {
  loadEnvFile(BACKEND_ENV, { overwriteKeys: HOT_RELOAD_KEYS });
  loadEnvFile(ROOT_ENV, { overwriteKeys: HOT_RELOAD_KEYS });
}

// packages/backend/.env then repo root .env (first write wins unless hot-reloaded)
loadEnvFile(BACKEND_ENV);
loadEnvFile(ROOT_ENV);
