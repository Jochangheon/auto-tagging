import { Router } from "express";
import { ensureMigrated, isDatabaseConfigured, getDbMode } from "../db/pool.js";
import { createAuthSession, deleteAuthSession } from "../db/auth-sessions.js";
import { upsertMicrosoftUser, ensureDevUser } from "../db/users.js";
import {
  AUTH_COOKIE,
  AUTH_OPT_OUT_COOKIE,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  getMicrosoftOAuthConfig,
  isAuthDisabled,
  isMicrosoftOAuthConfigured,
} from "./config.js";
import { clearCookie, parseCookies, setCookie } from "./cookies.js";
import {
  buildMicrosoftAuthorizeUrl,
  exchangeMicrosoftCode,
  fetchMicrosoftProfile,
  newOAuthState,
  newPkcePair,
} from "./microsoft.js";
import { writeStoredOAuth } from "./oauth-store.js";

export const authRouter = Router();

authRouter.get("/me", async (req, res) => {
  try {
    const oauth = isMicrosoftOAuthConfigured();
    const db = isDatabaseConfigured();
    const disabled = isAuthDisabled();
    const cfg = getMicrosoftOAuthConfig();
    const cookies = parseCookies(req);
    const optedOut = cookies[AUTH_OPT_OUT_COOKIE] === "1";

    // AUTH_DISABLED + no opt-out → synthetic user (scripts).
    // After logout, opt-out is set → treat as logged out so Microsoft works.
    if (disabled && db && !optedOut) {
      await ensureMigrated();
      const user = await ensureDevUser();
      return res.json({
        ok: true,
        authenticated: true,
        auth_disabled: true,
        oauth_configured: oauth,
        database_configured: db,
        db_mode: getDbMode(),
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
        },
      });
    }

    if (req.authUser) {
      return res.json({
        ok: true,
        authenticated: true,
        oauth_configured: oauth,
        database_configured: db,
        db_mode: getDbMode(),
        auth_disabled: false,
        user: {
          id: req.authUser.id,
          email: req.authUser.email,
          display_name: req.authUser.displayName,
        },
      });
    }

    return res.json({
      ok: true,
      authenticated: false,
      oauth_configured: oauth,
      database_configured: db,
      db_mode: db ? getDbMode() : null,
      auth_disabled: false,
      redirect_uri: cfg?.redirectUri ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: msg });
  }
});

/** Save Microsoft app Client ID (and optional secret) then ready for login. */
authRouter.post("/microsoft/setup", async (req, res) => {
  try {
    const clientId = typeof req.body?.client_id === "string" ? req.body.client_id.trim() : "";
    const clientSecret =
      typeof req.body?.client_secret === "string" ? req.body.client_secret.trim() : "";
    if (!clientId) {
      return res.status(400).json({ ok: false, error: "client_id_required" });
    }
    const saved = writeStoredOAuth({
      clientId,
      clientSecret: clientSecret || undefined,
      tenant: "common",
      redirectUri:
        process.env.AZURE_AD_REDIRECT_URI?.trim() ||
        `http://localhost:${process.env.PORT || 8080}/api/auth/microsoft/callback`,
    });
    return res.json({
      ok: true,
      oauth_configured: true,
      client_id: saved.clientId.slice(0, 8) + "…",
      redirect_uri: saved.redirectUri,
      public_client: !saved.clientSecret,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: msg });
  }
});

authRouter.get("/microsoft", async (_req, res) => {
  if (isAuthDisabled()) {
    return res.redirect("/");
  }
  if (!isMicrosoftOAuthConfigured()) {
    return res.redirect("/login.html?need_setup=1");
  }
  if (!isDatabaseConfigured()) {
    return res.status(503).send("데이터베이스를 사용할 수 없습니다.");
  }

  try {
    await ensureMigrated();
    const state = newOAuthState();
    const { verifier, challenge } = newPkcePair();
    setCookie(res, OAUTH_STATE_COOKIE, state, { maxAgeSec: 600, httpOnly: true });
    setCookie(res, OAUTH_VERIFIER_COOKIE, verifier, { maxAgeSec: 600, httpOnly: true });
    const url = buildMicrosoftAuthorizeUrl(state, challenge);
    return res.redirect(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).send(msg);
  }
});

authRouter.get("/microsoft/callback", async (req, res) => {
  try {
    if (!isDatabaseConfigured()) {
      return res.status(503).send("database unavailable");
    }
    await ensureMigrated();

    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const errQ = typeof req.query.error === "string" ? req.query.error : "";
    if (errQ) {
      const desc =
        typeof req.query.error_description === "string"
          ? req.query.error_description
          : errQ;
      return res.redirect(`/login.html?error=${encodeURIComponent(desc.slice(0, 200))}`);
    }
    if (!code) {
      return res.redirect("/login.html?error=missing_code");
    }

    const cookies = parseCookies(req);
    const expected = cookies[OAUTH_STATE_COOKIE];
    const verifier = cookies[OAUTH_VERIFIER_COOKIE];
    if (!expected || expected !== state) {
      return res.redirect("/login.html?error=invalid_state");
    }
    if (!verifier) {
      return res.redirect("/login.html?error=missing_pkce");
    }
    clearCookie(res, OAUTH_STATE_COOKIE);
    clearCookie(res, OAUTH_VERIFIER_COOKIE);

    let tokens;
    try {
      tokens = await exchangeMicrosoftCode(code, verifier);
    } catch (tokenErr) {
      const raw = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
      let hint = raw.slice(0, 220);
      if (raw.includes("AADSTS7000218") || raw.includes("client_secret")) {
        hint =
          "Azure 앱에 클라이언트 비밀(Client Secret)이 필요합니다. Azure Portal → 인증서 및 비밀 → 새 클라이언트 비밀 만들기 후 packages/backend/.env 의 AZURE_AD_CLIENT_SECRET 에 값을 넣으세요.";
      }
      return res.redirect(`/login.html?error=${encodeURIComponent(hint)}`);
    }
    const profile = await fetchMicrosoftProfile(tokens.access_token, tokens.id_token);
    const user = await upsertMicrosoftUser({
      microsoftOid: profile.oid,
      email: profile.email,
      displayName: profile.displayName,
    });
    const session = await createAuthSession(user.id);
    clearCookie(res, AUTH_OPT_OUT_COOKIE);
    setCookie(res, AUTH_COOKIE, session.id, {
      maxAgeSec: 60 * 60 * 24 * 14,
      httpOnly: true,
    });
    return res.redirect("/?login=ok");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[auth] callback failed:", msg);
    return res.redirect(`/login.html?error=${encodeURIComponent(msg.slice(0, 200))}`);
  }
});

authRouter.post("/logout", async (req, res) => {
  const cookies = parseCookies(req);
  const sid = cookies[AUTH_COOKIE];
  if (sid && isDatabaseConfigured()) {
    try {
      await deleteAuthSession(sid);
    } catch {
      /* ignore */
    }
  }
  clearCookie(res, AUTH_COOKIE);
  clearCookie(res, OAUTH_STATE_COOKIE);
  clearCookie(res, OAUTH_VERIFIER_COOKIE);
  // Prevent AUTH_DISABLED from immediately re-logging the user in.
  setCookie(res, AUTH_OPT_OUT_COOKIE, "1", {
    maxAgeSec: 60 * 60 * 24 * 30,
    httpOnly: true,
  });
  return res.json({ ok: true, logged_out: true });
});

/**
 * Local-only helper for scripts (e.g. tutorial screenshot capture).
 * Not exposed in the login UI. Blocked unless Host is localhost.
 */
authRouter.post("/dev-login", async (req, res) => {
  const host = String(req.hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const local =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost");
  if (!local) {
    return res.status(404).json({ ok: false, error: "not_found" });
  }
  if (!isDatabaseConfigured()) {
    return res.status(503).json({ ok: false, error: "database_unavailable" });
  }
  try {
    await ensureMigrated();
    const user = await ensureDevUser();
    const session = await createAuthSession(user.id);
    clearCookie(res, AUTH_OPT_OUT_COOKIE);
    setCookie(res, AUTH_COOKIE, session.id, {
      maxAgeSec: 60 * 60,
      httpOnly: true,
    });
    return res.json({
      ok: true,
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: msg });
  }
});

authRouter.get("/config", (_req, res) => {
  const cfg = getMicrosoftOAuthConfig();
  res.json({
    ok: true,
    oauth_configured: Boolean(cfg),
    database_configured: isDatabaseConfigured(),
    db_mode: isDatabaseConfigured() ? getDbMode() : null,
    auth_disabled: isAuthDisabled(),
    redirect_uri: cfg?.redirectUri ?? null,
    public_client: cfg?.publicClient ?? true,
  });
});
