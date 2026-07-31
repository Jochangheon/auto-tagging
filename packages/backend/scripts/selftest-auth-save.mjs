/**
 *   npx tsx --import ./src/polyfill.mjs scripts/selftest-auth-save.mjs
 */
import { pickSessionForSite } from "../src/crawl/auth-cookie-store.ts";
import { rootDomain, sameSiteFamily } from "../src/crawl/site-domain.ts";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(rootDomain("mail.naver.com") === "naver.com", "root mail.naver");
assert(rootDomain("nid.naver.com") === "naver.com", "root nid.naver");
assert(rootDomain("www.naver.com") === "naver.com", "root www.naver");
assert(sameSiteFamily("mail.naver.com", "naver.com"), "family mail↔naver");
assert(sameSiteFamily("mail.naver.com", "nid.naver.com"), "family mail↔nid");
assert(sameSiteFamily("www.kanu.co.kr", "kanu.co.kr"), "family kanu");

const picked = pickSessionForSite(
  "https://mail.naver.com/v2/read/-1/25058",
  [
    { name: "NID_AUT", value: "a", domain: ".naver.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "NID_SES", value: "b", domain: ".naver.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "nid_s", value: "c", domain: "nid.naver.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" },
    { name: "other", value: "x", domain: ".google.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" },
  ],
  [
    { origin: "https://mail.naver.com", localStorage: [{ name: "k", value: "v" }] },
    { origin: "https://www.google.com", localStorage: [{ name: "g", value: "1" }] },
  ]
);

assert(picked.root_domain === "naver.com", "picked root");
assert(picked.cookies.length === 3, `expected 3 naver cookies, got ${picked.cookies.length}`);
assert(picked.origins.length === 1, "only mail.naver origin");
assert(!picked.cookies.some((c) => c.domain.includes("google")), "no google cookie");

console.log("[selftest-auth-save] PASS", {
  root: picked.root_domain,
  cookies: picked.cookies.map((c) => c.name),
  origins: picked.origins.map((o) => o.origin),
});
