import type { NextFunction, Request, Response } from "express";
import { isDatabaseConfigured, ensureMigrated } from "../db/pool.js";
import { getValidAuthSession } from "../db/auth-sessions.js";
import { ensureDevUser } from "../db/users.js";
import { AUTH_COOKIE, AUTH_OPT_OUT_COOKIE, isAuthDisabled } from "./config.js";
import { parseCookies } from "./cookies.js";

export type AuthUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  microsoftOid: string;
};

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser | null;
    }
  }
}

function hasAuthOptOut(req: Request): boolean {
  const cookies = parseCookies(req);
  return cookies[AUTH_OPT_OUT_COOKIE] === "1";
}

async function resolveUser(req: Request): Promise<AuthUser | null> {
  if (!isDatabaseConfigured()) return null;

  await ensureMigrated();

  // AUTH_DISABLED is for scripts only. After explicit logout (opt-out),
  // do NOT force a synthetic user — let the person use Microsoft / test login.
  if (isAuthDisabled() && !hasAuthOptOut(req)) {
    const user = await ensureDevUser();
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      microsoftOid: user.microsoft_oid,
    };
  }

  const cookies = parseCookies(req);
  const sid = cookies[AUTH_COOKIE];
  if (!sid) return null;

  const session = await getValidAuthSession(sid);
  if (!session) return null;

  return {
    id: session.user_id,
    email: session.email,
    displayName: session.display_name,
    microsoftOid: session.microsoft_oid,
  };
}

export async function attachAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    req.authUser = await resolveUser(req);
  } catch (err) {
    console.warn("[auth] attach failed:", err instanceof Error ? err.message : err);
    req.authUser = null;
  }
  next();
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.authUser) {
      req.authUser = await resolveUser(req);
    }

    if (req.authUser) {
      next();
      return;
    }

    if (!isDatabaseConfigured()) {
      next();
      return;
    }

    res.status(401).json({
      ok: false,
      error: "auth_required",
      login_url: "/login.html",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: "auth_error", message: msg });
  }
}

export function getRequestUserId(req: Request): string | null {
  return req.authUser?.id ?? null;
}
