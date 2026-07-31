// Node 18 lacks global File; cheerio/undici require it at import time.
import "./load-env.mjs";
import { File } from "node:buffer";

if (typeof globalThis.File === "undefined") {
  Object.defineProperty(globalThis, "File", {
    value: File,
    writable: true,
    configurable: true,
  });
}
