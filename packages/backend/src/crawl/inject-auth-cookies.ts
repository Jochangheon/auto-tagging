import type { Cookie } from "playwright";
import { connectOverCdp, disconnectCdp } from "./cdp-session.js";
import { interactCode, type FirecrawlSession } from "./firecrawl-interact.js";
import { findAuthCookiesForUrl } from "./auth-cookie-store.js";

function cookiesToJsonLiteral(cookies: Cookie[]): string {
  return JSON.stringify(
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite ?? "Lax",
      ...(typeof c.expires === "number" ? { expires: c.expires } : {}),
    }))
  );
}

/**
 * Inject stored auth cookies into a Firecrawl session, then reload the page
 * so the site sees the logged-in state.
 */
export async function injectAuthCookiesForUrl(
  session: FirecrawlSession,
  pageUrl: string,
  ownerUserId: string | null
): Promise<{ injected: boolean; cookie_count: number; label?: string; error?: string }> {
  const rec = findAuthCookiesForUrl(pageUrl, ownerUserId);
  if (!rec?.cookies.length) {
    return { injected: false, cookie_count: 0 };
  }

  const cookies = rec.cookies;
  const targetOrigin = new URL(pageUrl).origin;
  const localStorageItems =
    rec.origins.find((origin) => origin.origin === targetOrigin)?.localStorage ?? [];
  let injectedVia: "cdp" | "interact" | null = null;

  if (session.cdpUrl) {
    try {
      const page = await connectOverCdp(session.cdpUrl, pageUrl);
      await page.context().addCookies(cookies);
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      if (localStorageItems.length) {
        await page.evaluate((items) => {
          for (const item of items) localStorage.setItem(item.name, item.value);
        }, localStorageItems);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      }
      injectedVia = "cdp";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[auth-cookies] CDP inject failed: ${message}`);
      await disconnectCdp(session.cdpUrl).catch(() => {});
    }
  }

  if (!injectedVia) {
    const literal = cookiesToJsonLiteral(cookies);
    const storageLiteral = JSON.stringify(localStorageItems);
    const code = `
await (async () => {
  const cookies = ${literal};
  const localStorageItems = ${storageLiteral};
  await page.context().addCookies(cookies);
  await page.goto(${JSON.stringify(pageUrl)}, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  if (localStorageItems.length) {
    await page.evaluate((items) => {
      for (const item of items) localStorage.setItem(item.name, item.value);
    }, localStorageItems);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  }
  return { cookies: cookies.length, localStorage: localStorageItems.length };
})();
`.trim();
    const resp = await interactCode(session.scrapeId, code, 60);
    if (resp.success !== true) {
      return {
        injected: false,
        cookie_count: cookies.length,
        label: rec.label,
        error: resp.error ?? "cookie inject failed",
      };
    }
    injectedVia = "interact";
  }

  console.log(
    `[auth-cookies] injected ${cookies.length} cookies for ${rec.host} via ${injectedVia} label=${rec.label}`
  );
  return { injected: true, cookie_count: cookies.length, label: rec.label };
}
