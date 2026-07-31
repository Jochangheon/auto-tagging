/**
 * Interactive login — local Playwright browser.
 *
 * SNS (Kakao / Naver / Google …) must be allowed to open real popup windows.
 * Only clearly non-OAuth stray popups (ads) are closed after URL settles.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Cookie,
  type CDPSession,
  type Page,
} from "playwright";
import {
  pickSessionForSite,
  upsertAuthSessionState,
  type AuthStorageOrigin,
} from "./auth-cookie-store.js";
import { normalizeHost } from "./site-domain.js";

interface LoginSnapshot {
  cookies: Cookie[];
  origins: AuthStorageOrigin[];
}

interface InteractiveLoginSession {
  id: string;
  siteUrl: string;
  targetHost: string;
  label?: string;
  ownerUserId: string | null;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  mainTargetId: string | null;
  browserCdp: CDPSession | null;
  lastState: LoginSnapshot;
  lastUrl: string;
  windowClosed: boolean;
  createdAt: number;
}

const sessions = new Map<string, InteractiveLoginSession>();
const SESSION_TTL_MS = 15 * 60 * 1000;
const execFileAsync = promisify(execFile);

/** SNS / OAuth hosts — popups for these MUST stay open. */
const OAUTH_ALLOW_HOSTS = [
  "kakao.com",
  "kauth.kakao.com",
  "accounts.kakao.com",
  "kapi.kakao.com",
  "naver.com",
  "nid.naver.com",
  "nid.naver.net",
  "accounts.google.com",
  "appleid.apple.com",
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "login.microsoftonline.com",
] as const;

function hostOfUrl(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isOauthHost(host: string): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^www\./, "");
  return OAUTH_ALLOW_HOSTS.some((a) => {
    const n = a.toLowerCase().replace(/^www\./, "");
    return h === n || h.endsWith("." + n);
  });
}

function resolveLoginEntryUrl(siteUrl: string): string {
  const parsed = new URL(siteUrl.includes("://") ? siteUrl : `https://${siteUrl}`);
  const host = normalizeHost(parsed.hostname);
  if (host === "naver.com" || host.endsWith(".naver.com")) {
    return "https://nid.naver.com/nidlogin.login";
  }
  return parsed.href;
}

/**
 * Allow Kakao/Naver (etc.) popups. Close only settled non-OAuth popups (ads).
 * Previous "close every new page" policy broke SNS — the OAuth window never stayed open.
 */
function attachOauthPopupPolicy(session: InteractiveLoginSession): void {
  session.context.on("page", (newPage) => {
    if (session.windowClosed || newPage === session.page) return;

    void (async () => {
      try {
        // Kakao/Naver often open about:blank first, then navigate — never kill blank early.
        await newPage.bringToFront().catch(() => {});
        newPage.on("close", () => {
          void refreshState(session).catch(() => {});
        });

        // Wait for a real URL (OAuth redirect), up to ~15s.
        const deadline = Date.now() + 15_000;
        while (!session.windowClosed && !newPage.isClosed() && Date.now() < deadline) {
          const url = newPage.url();
          const host = hostOfUrl(url);
          if (url && url !== "about:blank" && !url.startsWith("chrome-error://")) {
            if (isOauthHost(host)) {
              console.log(`[interactive-login] keep SNS popup host=${host}`);
              await newPage.bringToFront().catch(() => {});
              void refreshState(session).catch(() => {});
              return;
            }
            const mainHost = normalizeHost(session.targetHost);
            if (host === mainHost || host.endsWith("." + mainHost)) {
              console.log(`[interactive-login] keep same-site popup host=${host}`);
              void refreshState(session).catch(() => {});
              return;
            }
            // Foreign non-OAuth popup (ads) — close.
            console.log(`[interactive-login] close non-SNS popup url=${url.slice(0, 120)}`);
            await newPage.close({ runBeforeUnload: false }).catch(() => {});
            return;
          }
          await newPage.waitForTimeout(300).catch(() => {});
        }

        // Still blank after 15s — leave it (user may still be mid-OAuth); do not force-close.
        if (!newPage.isClosed()) {
          console.log("[interactive-login] popup still blank/settling — leaving open");
        }
      } catch {
        /* ignore */
      }
    })();
  });
}

async function captureBrowserState(session: InteractiveLoginSession): Promise<LoginSnapshot> {
  let cookies: Cookie[] = [];
  try {
    cookies = await session.context.cookies();
  } catch {
    cookies = [];
  }

  let origins: AuthStorageOrigin[] = [];
  try {
    const storage = await session.context.storageState();
    origins = storage.origins as AuthStorageOrigin[];
    if (!cookies.length && storage.cookies.length) cookies = storage.cookies;
  } catch {
    /* keep cookies() */
  }

  return { cookies, origins };
}

async function refreshState(session: InteractiveLoginSession): Promise<void> {
  try {
    session.lastState = await captureBrowserState(session);
    if (!session.page.isClosed()) session.lastUrl = session.page.url();
  } catch {
    session.windowClosed = true;
  }
}

async function closeSession(session: InteractiveLoginSession): Promise<void> {
  sessions.delete(session.id);
  session.windowClosed = true;

  const hardClose = async () => {
    await session.browserCdp?.detach().catch(() => {});
    await session.context.close().catch(() => {});
    await session.browser.close().catch(() => {});
  };

  await Promise.race([
    hardClose(),
    new Promise<void>((resolve) => setTimeout(resolve, 700)),
  ]);

  try {
    const proc = (
      session.browser as unknown as { process?: () => { pid?: number } | null }
    ).process?.();
    const pid = proc?.pid;
    if (pid && process.platform === "win32") {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 2_000,
      }).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

function pruneExpired(): void {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (now - session.createdAt <= SESSION_TTL_MS) continue;
    void closeSession(session);
  }
}

export async function startInteractiveLogin(input: {
  siteUrl: string;
  label?: string;
  ownerUserId: string | null;
}): Promise<{
  login_session_id: string;
  browser_mode: "local";
  live_view_url: null;
  expires_in_seconds: number;
  raised: false;
  entry_url: string;
  page_count: number;
}> {
  pruneExpired();

  const parsed = new URL(
    input.siteUrl.includes("://") ? input.siteUrl : `https://${input.siteUrl}`
  );
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("invalid site_url");

  const siteUrl = parsed.href;
  const entryUrl = resolveLoginEntryUrl(siteUrl);

  for (const existing of [...sessions.values()]) {
    if (existing.ownerUserId === input.ownerUserId) await closeSession(existing);
  }

  const browser = await chromium.launch({
    headless: false,
    args: [
      "--window-size=1200,860",
      "--window-position=120,80",
      "--disable-features=TranslateUI",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-notifications",
      "--disable-popup-blocking", // required for Kakao/Naver SNS popups
    ],
  });

  const context = await browser.newContext({
    viewport: null,
    acceptDownloads: false,
  });

  const page = await context.newPage();
  const record: InteractiveLoginSession = {
    id: randomUUID(),
    siteUrl,
    targetHost: parsed.hostname,
    label: input.label?.trim() || undefined,
    ownerUserId: input.ownerUserId,
    browser,
    context,
    page,
    mainTargetId: null,
    browserCdp: null,
    lastState: { cookies: [], origins: [] },
    lastUrl: entryUrl,
    windowClosed: false,
    createdAt: Date.now(),
  };
  sessions.set(record.id, record);

  attachOauthPopupPolicy(record);

  await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => {});
  if (page.isClosed() || !browser.isConnected()) {
    await closeSession(record);
    throw new Error("login_browser_closed_unexpectedly");
  }

  try {
    record.lastState = await captureBrowserState(record);
  } catch {
    record.lastState = { cookies: [], origins: [] };
  }
  record.lastUrl = page.isClosed() ? entryUrl : page.url();

  browser.on("disconnected", () => {
    record.windowClosed = true;
  });
  context.on("close", () => {
    record.windowClosed = true;
  });

  return {
    login_session_id: record.id,
    browser_mode: "local",
    live_view_url: null,
    expires_in_seconds: Math.floor(SESSION_TTL_MS / 1000),
    raised: false,
    entry_url: entryUrl,
    page_count: context.pages().filter((p) => !p.isClosed()).length,
  };
}

export async function getInteractiveLoginStatus(
  id: string,
  ownerUserId: string | null
): Promise<{
  status: "open" | "closed";
  current_url: string;
  page_count: number;
}> {
  pruneExpired();
  const session = sessions.get(id);
  if (!session || session.ownerUserId !== ownerUserId) throw new Error("login_session_not_found");

  // Lightweight cookie refresh so 「창 닫힘 → 자동 저장」에도 최신 세션이 남는다.
  try {
    if (!session.windowClosed && !session.page.isClosed()) {
      session.lastUrl = session.page.url();
      const cookies = await session.context.cookies();
      if (cookies.length) {
        session.lastState = {
          cookies,
          origins: session.lastState.origins,
        };
      }
    }
  } catch {
    session.windowClosed = true;
  }

  return {
    status: session.windowClosed ? "closed" : "open",
    current_url: session.lastUrl,
    page_count: session.context.pages().filter((p) => !p.isClosed()).length,
  };
}

export async function completeInteractiveLogin(
  id: string,
  ownerUserId: string | null
): Promise<Record<string, unknown>> {
  pruneExpired();
  const session = sessions.get(id);
  if (!session || session.ownerUserId !== ownerUserId) throw new Error("login_session_not_found");

  let snapshot: LoginSnapshot = session.lastState;
  if (!session.windowClosed) {
    try {
      snapshot = await captureBrowserState(session);
      session.lastState = snapshot;
    } catch {
      /* use lastState */
    }
  }

  const picked = pickSessionForSite(session.siteUrl, snapshot.cookies, snapshot.origins);
  const cookies = picked.cookies.length ? picked.cookies : snapshot.cookies;
  const origins = picked.origins.length ? picked.origins : snapshot.origins;
  const localStorageCount = origins.reduce(
    (sum, origin) => sum + (origin.localStorage?.length ?? 0),
    0
  );

  if (cookies.length === 0 && localStorageCount === 0) {
    throw new Error("login_state_not_found");
  }

  console.log(
    `[interactive-login] save host=${session.targetHost} root=${picked.root_domain} ` +
      `cookies=${cookies.length}/${snapshot.cookies.length} localStorage=${localStorageCount}`
  );

  const result = upsertAuthSessionState({
    site_url: session.siteUrl,
    label: session.label,
    cookies,
    origins,
    owner_user_id: session.ownerUserId,
  });
  await closeSession(session);
  return result;
}

export async function cancelInteractiveLogin(
  id: string,
  ownerUserId: string | null
): Promise<boolean> {
  const session = sessions.get(id);
  if (!session || session.ownerUserId !== ownerUserId) return false;
  await closeSession(session);
  return true;
}
