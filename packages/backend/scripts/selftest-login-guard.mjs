import assert from "node:assert/strict";
import { checkAnalysisUrl } from "../src/crawl/analysis-url-guard.ts";

const allowed = [
  ["http://example.com/products", "https://example.com/products"],
  ["https://www.example.com/products", "https://example.com/products"],
  ["https://example.com/products", "https://example.com/products/42"],
  ["https://example.com/products?a=1", "https://example.com/products?a=2"],
];

for (const [expected, current] of allowed) {
  assert.equal(
    checkAnalysisUrl(expected, current).ok,
    true,
    `expected navigation to be allowed: ${expected} -> ${current}`
  );
}

const blocked = [
  ["https://example.com/products", "https://example.com/login?next=%2Fproducts"],
  ["https://example.com/products", "https://auth.example.com/oauth/start"],
  ["https://example.com/products", "https://accounts.microsoftonline.com/login"],
];

for (const [expected, current] of blocked) {
  assert.equal(
    checkAnalysisUrl(expected, current).ok,
    false,
    `expected navigation to require login: ${expected} -> ${current}`
  );
}

console.log(`[selftest-login-guard] passed ${allowed.length + blocked.length} cases`);
