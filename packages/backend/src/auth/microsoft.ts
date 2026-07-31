import { createHash, randomBytes } from "node:crypto";
import { getMicrosoftOAuthConfig } from "./config.js";

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function newOAuthState(): string {
  return randomBytes(24).toString("hex");
}

export function newPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildMicrosoftAuthorizeUrl(
  state: string,
  codeChallenge: string
): string {
  const cfg = getMicrosoftOAuthConfig();
  if (!cfg) throw new Error("microsoft_oauth_not_configured");
  const u = new URL(`https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/authorize`);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", "openid profile email User.Read offline_access");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export type MicrosoftTokenResult = {
  access_token: string;
  id_token?: string;
  expires_in?: number;
};

export async function exchangeMicrosoftCode(
  code: string,
  codeVerifier: string
): Promise<MicrosoftTokenResult> {
  const cfg = getMicrosoftOAuthConfig();
  if (!cfg) throw new Error("microsoft_oauth_not_configured");

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    code,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
    scope: "openid profile email User.Read offline_access",
  });
  if (cfg.clientSecret) {
    body.set("client_secret", cfg.clientSecret);
  }

  const res = await fetch(
    `https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`microsoft_token_failed: ${res.status} ${text.slice(0, 280)}`);
  }
  return (await res.json()) as MicrosoftTokenResult;
}

export type MicrosoftProfile = {
  oid: string;
  email: string | null;
  displayName: string | null;
};

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function fetchMicrosoftProfile(
  accessToken: string,
  idToken?: string
): Promise<MicrosoftProfile> {
  const fromId = idToken ? decodeJwtPayload(idToken) : null;
  let oid =
    (typeof fromId?.oid === "string" && fromId.oid) ||
    (typeof fromId?.sub === "string" && fromId.sub) ||
    "";
  let email =
    (typeof fromId?.email === "string" && fromId.email) ||
    (typeof fromId?.preferred_username === "string" && fromId.preferred_username) ||
    null;
  let displayName = typeof fromId?.name === "string" ? fromId.name : null;

  try {
    const res = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const me = (await res.json()) as {
        id?: string;
        mail?: string;
        userPrincipalName?: string;
        displayName?: string;
      };
      if (me.id) oid = me.id;
      email = me.mail || me.userPrincipalName || email;
      displayName = me.displayName || displayName;
    }
  } catch (err) {
    console.warn("[auth] graph /me failed:", err instanceof Error ? err.message : err);
  }

  if (!oid) {
    const seed = email || accessToken.slice(0, 32);
    oid = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  }

  return { oid, email, displayName };
}
