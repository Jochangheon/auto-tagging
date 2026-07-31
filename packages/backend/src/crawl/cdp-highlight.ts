import type { Page } from "playwright";
import {
  loadHighlightBrowserScript,
  type HighlightOverlayInput,
  type HighlightOverlayResult,
  type OverlayBbox,
} from "./overlay-script.js";
import { revealForHighlight, type RevealForHighlightInput } from "./reveal-for-highlight.js";

export type { HighlightOverlayInput, HighlightOverlayResult, OverlayBbox, RevealForHighlightInput };

/**
 * String-only page.evaluate — no Node-side function serialization (avoids tsx __name).
 * Clears any existing highlight, reveals hidden targets, scrolls, remeasures, then draws overlay.
 */
export async function highlightOnPage(
  targetPage: Page,
  input: HighlightOverlayInput & RevealForHighlightInput
): Promise<HighlightOverlayResult> {
  await clearHighlightOnPage(targetPage);
  await revealForHighlight(targetPage, input);

  const browserScript = loadHighlightBrowserScript();
  const inputJson = JSON.stringify(input);
  const expression = `(function () {
${browserScript}
return __autotagHighlight(${inputJson});
})()`;

  return targetPage.evaluate(expression);
}

export async function clearHighlightOnPage(targetPage: Page): Promise<void> {
  await targetPage.evaluate(`
    (function () {
      if (window.__autotagHighlightCleanup) {
        try { window.__autotagHighlightCleanup(); } catch (e) {}
        window.__autotagHighlightCleanup = null;
      }
      var layer = document.getElementById("__autotag_live_highlight__");
      if (layer) layer.remove();
    })()
  `);
}
