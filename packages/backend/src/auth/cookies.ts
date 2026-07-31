import type { Request, Response } from "express";

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export function setCookie(
  res: Response,
  name: string,
  value: string,
  opts: { maxAgeSec?: number; httpOnly?: boolean; path?: string } = {}
): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path || "/"}`,
    "SameSite=Lax",
  ];
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.maxAgeSec != null) parts.push(`Max-Age=${opts.maxAgeSec}`);
  if (process.env.COOKIE_SECURE === "1" || process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  res.append("Set-Cookie", parts.join("; "));
}

export function clearCookie(res: Response, name: string): void {
  // Match both Secure and non-Secure variants so logout always sticks.
  const base = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  res.append("Set-Cookie", `${base}; HttpOnly`);
  res.append("Set-Cookie", `${base}; HttpOnly; Secure`);
  res.append("Set-Cookie", base);
  res.append("Set-Cookie", `${base}; Secure`);
}
