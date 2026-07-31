import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const copies = [
  ["src/crawl/overlay-script.browser.js", "dist/crawl/overlay-script.browser.js"],
  // Runtime .mjs helpers imported by compiled dist/*.js (not emitted by tsc)
  ["src/load-env.mjs", "dist/load-env.mjs"],
  ["src/polyfill.mjs", "dist/polyfill.mjs"],
];

for (const [fromRel, toRel] of copies) {
  const from = join(root, fromRel);
  const to = join(root, toRel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`[backend] copied ${fromRel} → ${toRel}`);
}
