/**
 *   npx tsx --import ./src/polyfill.mjs scripts/selftest-interactive-login.mjs
 */
import {
  cancelInteractiveLogin,
  selftestOpenLoginWindow,
} from "../src/crawl/interactive-login-session.ts";

const site = process.argv[2] || "https://www.kanu.co.kr/";

console.log(`[selftest] opening for ${site}`);
const result = await selftestOpenLoginWindow(site);
console.log("[selftest]", result);

await cancelInteractiveLogin(result.login_session_id, "__selftest__");

if (!result.ok || result.junk_alive > 0) {
  console.error("[selftest] FAIL — junk tabs still alive:", result.junk_alive);
  process.exit(1);
}
console.log("[selftest] PASS — kakaocdn junk tab was killed");
