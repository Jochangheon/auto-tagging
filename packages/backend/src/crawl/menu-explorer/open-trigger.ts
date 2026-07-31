import type { Locator, Page } from "playwright";
import type { TriggerCandidate } from "./types.js";
import { TRIGGER_ACTION_TIMEOUT_MS } from "./constants.js";

async function resolveLocator(page: Page, trigger: TriggerCandidate): Promise<Locator | null> {
  if (trigger.tag_id != null) {
    const byTag = page.locator(`[data-tag-id="${trigger.tag_id}"]`).first();
    if (await byTag.count()) return byTag;
  }
  try {
    const byHint = page.locator(trigger.selector_hint).first();
    if (await byHint.count()) return byHint;
  } catch {
    /* invalid selector */
  }
  if (trigger.label) {
    const escaped = trigger.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return page
      .locator("button, a, [role='button']")
      .filter({ hasText: new RegExp(`^${escaped}$`) })
      .first();
  }
  return null;
}

export async function closeOpenMenus(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.move(8, 8);
}

export interface ClickTriggerResult {
  ok: boolean;
  reason?: string;
  /** True when the click caused a real page navigation (not a menu expand). */
  navigated_away?: boolean;
}

/** Click-only menu expand (MO drawer / generic sites). */
export async function tryClickTrigger(
  page: Page,
  trigger: TriggerCandidate,
  guardUrl?: string
): Promise<ClickTriggerResult> {
  const locator = await resolveLocator(page, trigger);
  if (!locator || !(await locator.count())) {
    return { ok: false, reason: "not_found" };
  }
  const beforeUrl = page.url();
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: TRIGGER_ACTION_TIMEOUT_MS }).catch(() => {});
    await locator.click({ timeout: TRIGGER_ACTION_TIMEOUT_MS });
    await page.waitForTimeout(30);

    const afterUrl = page.url();
    if (afterUrl !== beforeUrl) {
      // Some GNB tabs carry `aria-expanded="false"` even though they are plain
      // <a href> nav links — clicking them navigates the whole tab away from
      // the analyzed page (e.g. main → /lounge/events). Restore immediately so
      // the rest of exploration + the full-page capture stay on the real URL.
      const restoreUrl = guardUrl || beforeUrl;
      console.warn(
        `[menu-explorer] trigger "${trigger.label}" navigated ${beforeUrl} -> ${afterUrl}, restoring ${restoreUrl}`
      );
      await page
        .goto(restoreUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
        .catch(() => {});
      await page.waitForTimeout(300);
      return { ok: false, reason: "navigated_away", navigated_away: true };
    }

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message.slice(0, 80) };
  }
}

export async function closeTrigger(page: Page, trigger: TriggerCandidate): Promise<void> {
  const locator = await resolveLocator(page, trigger);
  if (!locator || !(await locator.count())) {
    await closeOpenMenus(page);
    return;
  }
  try {
    const expanded = await locator.getAttribute("aria-expanded");
    if (expanded === "true") {
      await locator.click({ timeout: TRIGGER_ACTION_TIMEOUT_MS });
    } else {
      await page.keyboard.press("Escape");
    }
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
  }
  await page.waitForTimeout(20);
}

/** Scroll hidden tagged element into view for highlight. */
export async function scrollTagIntoView(
  page: Page,
  tagId: number
): Promise<boolean> {
  const loc = page.locator(`[data-tag-id="${tagId}"]`).first();
  if (!(await loc.count())) return false;
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
    return await loc.isVisible().catch(() => false);
  } catch {
    return false;
  }
}
