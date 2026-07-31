import { ensureCdpConnected } from "./cdp-session.js";
import type { FirecrawlSession } from "./firecrawl-interact.js";

/** URL path/query that usually means an auth destination. */
const AUTH_URL_SIGNAL =
  /(?:^|[./?&=_-])(login|log-in|signin|sign-in|auth|authenticate|sso|oauth|account\/login|member\/login)(?:$|[./?&=_-])/i;

/**
 * Paths that typically require a logged-in session. If analysis of these URLs
 * ends up on a different path, treat as login-required (Cafe24/Kanu pattern).
 */
const MEMBER_AREA_SIGNAL =
  /(?:^|\/)(myshop|mypage|my-page|cart|order|wishlist|wish|member)(?:\/|$)/i;

/** True for /myshop, /cart, … — login is the usual reason these fail while home works. */
export function isMemberAreaUrl(raw: string): boolean {
  try {
    return MEMBER_AREA_SIGNAL.test(new URL(raw).pathname);
  } catch {
    return MEMBER_AREA_SIGNAL.test(raw);
  }
}

function looksLikeSessionDead(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("deno repl") ||
    lower.includes("repl exited") ||
    lower.includes("repl not ready") ||
    lower.includes("failed to execute code in browser session") ||
    lower.includes("browser session") ||
    lower.includes("has been closed") ||
    lower.includes("target page") ||
    lower.includes("concurrencylimited") ||
    lower.includes("concurrent")
  );
}

function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/^www\./i, "");
}

function normalizePathname(pathname: string): string {
  const p = pathname.replace(/\/+$/, "") || "/";
  return p.toLowerCase();
}

function isHttpUpgrade(expected: URL, current: URL): boolean {
  return expected.protocol === "http:" && current.protocol === "https:";
}

function shortUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.hostname.replace(/^www\./i, "") + (u.pathname || "/");
  } catch {
    return raw;
  }
}

export interface AnalysisUrlCheck {
  ok: boolean;
  expected_url: string;
  current_url: string;
  reason?: "auth_redirect" | "external_redirect" | "member_redirect";
}

/**
 * Detect navigation to a login/authentication destination during analysis.
 * Canonical http→https, www changes, hashes, and ordinary same-site path
 * changes are allowed to avoid stopping legitimate sites.
 *
 * Special case: member areas (/myshop, /cart, …) that redirect to another path
 * are treated as login-required even when the landing URL is not clearly "login".
 */
export function checkAnalysisUrl(expectedRaw: string, currentRaw: string): AnalysisUrlCheck {
  let expected: URL;
  let current: URL;
  try {
    expected = new URL(expectedRaw);
    current = new URL(currentRaw);
  } catch {
    return { ok: true, expected_url: expectedRaw, current_url: currentRaw };
  }

  if (!/^https?:$/.test(current.protocol)) {
    return { ok: true, expected_url: expected.href, current_url: current.href };
  }

  const sameHost = normalizedHost(expected.hostname) === normalizedHost(current.hostname);
  const currentAuthLike = AUTH_URL_SIGNAL.test(
    `${current.hostname}${current.pathname}${current.search}`
  );
  const expectedMember = MEMBER_AREA_SIGNAL.test(expected.pathname);
  const expectedPath = normalizePathname(expected.pathname);
  const currentPath = normalizePathname(current.pathname);

  if (sameHost) {
    if (currentAuthLike && expectedPath !== currentPath) {
      return {
        ok: false,
        expected_url: expected.href,
        current_url: current.href,
        reason: "auth_redirect",
      };
    }
    // /myshop → / (or other non-member page) without login cookie (Cafe24/Kanu).
    if (expectedMember && expectedPath !== currentPath) {
      const stillUnderTarget =
        currentPath === expectedPath || currentPath.startsWith(expectedPath + "/");
      const stillMemberArea = MEMBER_AREA_SIGNAL.test(current.pathname);
      if (!stillUnderTarget && !stillMemberArea) {
        return {
          ok: false,
          expected_url: expected.href,
          current_url: current.href,
          reason: "member_redirect",
        };
      }
    }
    return { ok: true, expected_url: expected.href, current_url: current.href };
  }

  if (isHttpUpgrade(expected, current) && sameHost) {
    return { ok: true, expected_url: expected.href, current_url: current.href };
  }

  return {
    ok: false,
    expected_url: expected.href,
    current_url: current.href,
    reason: currentAuthLike ? "auth_redirect" : "external_redirect",
  };
}

export class LoginRequiredError extends Error {
  readonly code = "LOGIN_REQUIRED";
  readonly expectedUrl: string;
  readonly currentUrl: string;
  readonly reason: NonNullable<AnalysisUrlCheck["reason"]>;

  constructor(
    expectedUrl: string,
    currentUrl: string,
    reason: NonNullable<AnalysisUrlCheck["reason"]> = "auth_redirect"
  ) {
    super(`LOGIN_REQUIRED|${expectedUrl}|${currentUrl}|${reason}`);
    this.name = "LoginRequiredError";
    this.expectedUrl = expectedUrl;
    this.currentUrl = currentUrl;
    this.reason = reason;
  }
}

/** Human-readable Korean line for batch/UI. */
export function formatLoginRequiredMessage(expectedUrl: string, currentUrl: string): string {
  return (
    `로그인 필요 · 요청 주소와 실제 주소가 다릅니다` +
    ` (요청 ${shortUrl(expectedUrl)} → 실제 ${shortUrl(currentUrl)})`
  );
}

export function parseLoginRequiredError(message: string | undefined): {
  expectedUrl: string;
  currentUrl: string;
  reason?: string;
} | null {
  const m = message ?? "";
  if (!m.startsWith("LOGIN_REQUIRED|")) return null;
  const parts = m.split("|");
  if (parts.length < 3) return null;
  return {
    expectedUrl: parts[1] || "",
    currentUrl: parts[2] || "",
    reason: parts[3],
  };
}

/**
 * Probe DOM for a visible login form (password field) — catches login walls
 * that keep the same URL (or soft overlays) on member pages.
 */
async function pageLooksLikeLoginWall(page: import("playwright").Page): Promise<boolean> {
  try {
    return Boolean(
      await page.evaluate(`(() => {
        var pwd = document.querySelector('input[type="password"]');
        if (!pwd) return false;
        var st = window.getComputedStyle(pwd);
        if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
        var rect = pwd.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return false;
        var body = (document.body && document.body.innerText || "").slice(0, 2000);
        if (/로그인|login|sign in|아이디|비밀번호/i.test(body)) return true;
        return rect.top < window.innerHeight && rect.left < window.innerWidth;
      })()`)
    );
  } catch {
    return false;
  }
}

export async function assertAnalysisUrl(
  session: FirecrawlSession,
  expectedUrl: string
): Promise<void> {
  if (!session.cdpUrl) return;
  const page = await ensureCdpConnected(session.cdpUrl, expectedUrl);
  const current = page.url();
  const result = checkAnalysisUrl(expectedUrl, current);
  if (!result.ok) {
    throw new LoginRequiredError(
      result.expected_url,
      result.current_url,
      result.reason ?? "auth_redirect"
    );
  }

  // Same URL but login wall (password form) on a member-area target.
  try {
    const expected = new URL(expectedUrl);
    if (MEMBER_AREA_SIGNAL.test(expected.pathname) && (await pageLooksLikeLoginWall(page))) {
      throw new LoginRequiredError(expectedUrl, current, "auth_redirect");
    }
  } catch (err) {
    if (err instanceof LoginRequiredError) throw err;
  }
}

/**
 * Prefer CDP login check BEFORE Firecrawl REPL waits.
 * If REPL later dies on a member URL (common after auth redirect), re-probe
 * and surface LOGIN_REQUIRED instead of a misleading "session_dead".
 */
export async function assertAnalysisUrlResilient(
  session: FirecrawlSession,
  expectedUrl: string,
  cause?: unknown
): Promise<void> {
  try {
    await assertAnalysisUrl(session, expectedUrl);
    return;
  } catch (err) {
    if (err instanceof LoginRequiredError) throw err;
  }

  if (!isMemberAreaUrl(expectedUrl)) {
    if (cause instanceof Error) throw cause;
    if (cause !== undefined) throw new Error(String(cause));
    return;
  }

  // Member page + CDP unavailable / ambiguous → treat as login (home usually works).
  let currentUrl = expectedUrl;
  try {
    if (session.cdpUrl) {
      const page = await ensureCdpConnected(session.cdpUrl, expectedUrl);
      currentUrl = page.url();
      const result = checkAnalysisUrl(expectedUrl, currentUrl);
      if (!result.ok) {
        throw new LoginRequiredError(
          result.expected_url,
          result.current_url,
          result.reason ?? "member_redirect"
        );
      }
      if (await pageLooksLikeLoginWall(page)) {
        throw new LoginRequiredError(expectedUrl, currentUrl, "auth_redirect");
      }
    }
  } catch (err) {
    if (err instanceof LoginRequiredError) throw err;
  }

  const causeMsg = cause instanceof Error ? cause.message : String(cause ?? "");
  if (causeMsg && looksLikeSessionDead(causeMsg)) {
    throw new LoginRequiredError(expectedUrl, currentUrl, "member_redirect");
  }
}

export function isLoginRequiredError(message: string | undefined): boolean {
  return (message ?? "").startsWith("LOGIN_REQUIRED|");
}

/** Classify analyze failures for UI: login vs session vs other. */
export type AnalyzeFailureKind = "login_required" | "session_dead" | "timeout" | "cancelled" | "other";

export function classifyAnalyzeFailure(
  message: string | undefined,
  failedUrl?: string
): {
  kind: AnalyzeFailureKind;
  label: string;
} {
  const m = message ?? "";
  const lower = m.toLowerCase();
  const login = parseLoginRequiredError(m);
  if (login) {
    return {
      kind: "login_required",
      label: formatLoginRequiredMessage(login.expectedUrl, login.currentUrl),
    };
  }
  if (lower.includes("로그인 필요") || lower.includes("login_required")) {
    return { kind: "login_required", label: m || "로그인 필요" };
  }

  // Bug fix: Firecrawl REPL often dies *because* the member page bounced to login.
  // Home works + /myshop fails ⇒ login, not "session_dead".
  if (failedUrl && isMemberAreaUrl(failedUrl) && looksLikeSessionDead(m)) {
    return {
      kind: "login_required",
      label:
        "로그인 필요 · 회원 페이지(/myshop 등) 접근에 실패했습니다. 로그인 창에서 로그인한 뒤 다시 시도하세요",
    };
  }

  if (looksLikeSessionDead(m) && !lower.includes("concurrent")) {
    return {
      kind: "session_dead",
      label:
        "브라우저 세션이 끊김 (Firecrawl 한도/불안정) — 「다시 시도」하세요",
    };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    // Member timeouts are usually auth walls stalling the page.
    if (failedUrl && isMemberAreaUrl(failedUrl)) {
      return {
        kind: "login_required",
        label:
          "로그인 필요 · 회원 페이지 로딩이 막혔습니다. 사이트 로그인 후 다시 시도하세요",
      };
    }
    return { kind: "timeout", label: "시간 초과 — 「다시 시도」하세요" };
  }
  if (lower.includes("cancelled") || m === "중단됨") {
    return { kind: "cancelled", label: "중단됨" };
  }
  if (lower.includes("concurrencylimited") || lower.includes("concurrent")) {
    return {
      kind: "session_dead",
      label: "동시 브라우저 한도 초과 — 잠시 후 「다시 시도」하세요",
    };
  }
  return { kind: "other", label: m || "분석 실패" };
}
