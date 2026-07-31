import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaxonomySnapshotPayload } from "@autotag/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_DIR = join(__dirname, "../../data/snapshots");

export function getSnapshotsDir(): string {
  return SNAPSHOTS_DIR;
}

function snapshotFileName(siteKey: string, timestamp: string): string {
  const safe = siteKey.replace(/[^a-zA-Z0-9.-]/g, "_");
  const ts = timestamp.replace(/[:.]/g, "-");
  return `${safe}-${ts}.json`;
}

export function saveTaxonomySnapshot(payload: TaxonomySnapshotPayload): string {
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const file = join(SNAPSHOTS_DIR, snapshotFileName(payload.site_key, payload.saved_at));
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`[taxonomy-snapshot] saved ${file}`);
  return file;
}

export function loadLatestSnapshot(siteKey: string): TaxonomySnapshotPayload | null {
  if (!existsSync(SNAPSHOTS_DIR)) return null;
  const safe = siteKey.replace(/[^a-zA-Z0-9.-]/g, "_");
  const files = readdirSync(SNAPSHOTS_DIR)
    .filter((f) => f.startsWith(safe + "-") && f.endsWith(".json"))
    .sort()
    .reverse();
  if (!files.length) return null;
  try {
    const raw = readFileSync(join(SNAPSHOTS_DIR, files[0]!), "utf8");
    return JSON.parse(raw) as TaxonomySnapshotPayload;
  } catch {
    return null;
  }
}
