import { readStoredOAuth } from "./oauth-store.js";

export type MicrosoftOAuthConfig = {
  clientId: string;
  /** Optional — public/SPA apps use PKCE without a secret. */
  clientSecret?: string;
  redirectUri: string;
  tenant: string;
  publicClient: boolean;
};

export function isAuthDisabled(): boolean {
  return process.env.AUTH_DISABLED === "1" || process.env.AUTH_DISABLED === "true";
}

export function getMicrosoftOAuthConfig(): MicrosoftOAuthConfig | null {
  const stored = readStoredOAuth();
  const clientId =
    process.env.AZURE_AD_CLIENT_ID?.trim() || stored?.clientId?.trim() || "";
  const clientSecret =
    process.env.AZURE_AD_CLIENT_SECRET?.trim() || stored?.clientSecret?.trim() || "";
  const redirectUri =
    process.env.AZURE_AD_REDIRECT_URI?.trim() ||
    stored?.redirectUri?.trim() ||
    `http://localhost:${process.env.PORT || 8080}/api/auth/microsoft/callback`;
  const tenant =
    process.env.AZURE_AD_TENANT?.trim() || stored?.tenant?.trim() || "common";

  if (!clientId) return null;
  return {
    clientId,
    clientSecret: clientSecret || undefined,
    redirectUri,
    tenant,
    publicClient: !clientSecret,
  };
}

export function isMicrosoftOAuthConfigured(): boolean {
  return getMicrosoftOAuthConfig() != null;
}

export const AUTH_COOKIE = "autotag_sid";
/** Set on logout so AUTH_DISABLED cannot silently re-attach a test user. */
export const AUTH_OPT_OUT_COOKIE = "autotag_auth_opt_out";
export const OAUTH_STATE_COOKIE = "autotag_oauth_state";
export const OAUTH_VERIFIER_COOKIE = "autotag_oauth_verifier";
