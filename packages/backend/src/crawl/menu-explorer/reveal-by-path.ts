import type { Page } from "playwright";
import type { MenuPathStep, TriggerCandidate } from "./types.js";
import { logRevealPathFailed } from "./menu-explorer-log.js";
import { closeOpenMenus, scrollTagIntoView, tryClickTrigger } from "./open-trigger.js";

function stepToTrigger(step: MenuPathStep): TriggerCandidate {
  return {
    key: step.key,
    label: step.label,
    tag_id: step.key.startsWith("tag:") ? Number.parseInt(step.key.slice(4), 10) : null,
    selector_hint: step.selector_hint,
    method: "click",
    depth: 0,
    score: 100,
    signals: ["replay"],
  };
}

/** Replay stored click path for highlight (MO menus). */
export async function revealByPath(
  page: Page,
  path: MenuPathStep[],
  targetTagId?: number | null
): Promise<{ ok: boolean; reason?: string }> {
  if (!path.length) {
    if (targetTagId != null && Number.isFinite(targetTagId)) {
      const ok = await scrollTagIntoView(page, targetTagId);
      return ok ? { ok: true } : { ok: false, reason: "target_hidden" };
    }
    return { ok: true };
  }

  await closeOpenMenus(page);

  for (let i = 0; i < path.length; i++) {
    const step = path[i]!;
    const opened = await tryClickTrigger(page, stepToTrigger(step));
    if (!opened.ok) {
      logRevealPathFailed(i, step.key, opened.reason ?? "open_failed");
      return { ok: false, reason: `step_${i}:${opened.reason}` };
    }
  }

  if (targetTagId != null && Number.isFinite(targetTagId)) {
    const ok = await scrollTagIntoView(page, targetTagId);
    if (!ok) {
      logRevealPathFailed(path.length, String(targetTagId), "target_hidden");
      return { ok: false, reason: "target_hidden" };
    }
  }

  return { ok: true };
}
