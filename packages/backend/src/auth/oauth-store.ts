/**
 * Persist Microsoft app settings (Client ID) under data/ — so login works without hand-editing .env.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type StoredOAuth = {
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  tenant?: string;
};

function storePath(): string {
  return join(__dirname, "../../data/azure-oauth.json");
}

export function readStoredOAuth(): StoredOAuth | null {
  const p = storePath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as StoredOAuth;
    if (!raw?.clientId?.trim()) return null;
    return {
      clientId: raw.clientId.trim(),
      clientSecret: raw.clientSecret?.trim() || undefined,
      redirectUri: raw.redirectUri?.trim() || undefined,
      tenant: raw.tenant?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

export function writeStoredOAuth(input: StoredOAuth): StoredOAuth {
  const p = storePath();
  mkdirSync(dirname(p), { recursive: true });
  const next: StoredOAuth = {
    clientId: input.clientId.trim(),
    clientSecret: input.clientSecret?.trim() || undefined,
    redirectUri: input.redirectUri?.trim() || undefined,
    tenant: (input.tenant?.trim() || "common") as string,
  };
  writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
