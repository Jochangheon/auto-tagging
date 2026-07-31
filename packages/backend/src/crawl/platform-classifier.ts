import type { Platform } from "@autotag/shared";
import type { ViewportMode } from "@autotag/shared";
import type { LiveTagEntry } from "./tag-live-dom.js";

export interface PlatformStats {
  PC: number;
  MO: number;
  All: number;
  total: number;
}

/** Browser-side platform classification (embedded in tag-live-dom eval). */
export const BROWSER_CLASSIFY_PLATFORM_FN = `
function classSignals(className) {
  const cls = className || "";
  const mo = [];
  const pc = [];
  if (/\\bhidden\\b/.test(cls) && /\\bmax-(?:[\\w-]+:)?(?:1024|lg|md|xl|sm):(?:block|flex|inline)/.test(cls)) {
    mo.push("hidden+max-*:block");
  }
  if (/(?:^|\\s)(?:lg|xl|2xl|1024):hidden(?:\\s|$)/.test(cls)) {
    mo.push("lg+:hidden");
  }
  if (/\\bfixed\\b/.test(cls) && /\\bbottom-0\\b/.test(cls)) {
    mo.push("fixed-bottom-nav");
  }
  if (/kanu-mobile/i.test(cls)) {
    mo.push("kanu-mobile");
  }
  if (/\\bmax-(?:1024|lg|md|xl):hidden\\b/.test(cls)) {
    pc.push("max-*:hidden");
  }
  if (/\\bhidden\\b/.test(cls) && /(?:^|\\s)(?:lg|xl|2xl|1024):(?:block|flex)\\b/.test(cls)) {
    pc.push("hidden+lg+:block");
  }
  if (/\\bblock\\b/.test(cls) && /\\bmax-1024:hidden\\b/.test(cls)) {
    pc.push("block+max-1024:hidden");
  }
  return { mo, pc };
}

function classifyPlatform(el, visibility, viewportMode) {
  const isMo = viewportMode === "mo";
  const allMo = [];
  const allPc = [];
  let cur = el;
  while (cur && cur !== document.body) {
    const { mo, pc } = classSignals(String(cur.className || ""));
    for (const s of mo) allMo.push(cur.tagName.toLowerCase() + "." + s);
    for (const s of pc) allPc.push(cur.tagName.toLowerCase() + "." + s);
    cur = cur.parentElement;
  }

  const hr = visibility.hidden_reason;
  const cpClass = visibility.collapsed_parent?.className || "";

  if (hr === "zero_size" || hr === "collapsed_parent") {
    const cpSig = classSignals(cpClass);
    // Do NOT treat bare "fixed" as mobile — PC GNB headers are often fixed,
    // and their closed dropdown children are zero_size under that header.
    // Only bottom bars / explicit mobile markers count as MO here.
    if (
      allMo.length ||
      cpSig.mo.length ||
      /max-1024:block|1024:hidden|kanu-mobile|fixed[^\\s]*bottom|bottom-0/i.test(cpClass)
    ) {
      return {
        platform: "MO",
        reason: allMo[0] || cpSig.mo[0] || "collapsed:" + cpClass.slice(0, 50),
      };
    }
    if (allPc.length || cpSig.pc.length) {
      return {
        platform: "PC",
        reason: allPc[0] || "collapsed-pc:" + cpClass.slice(0, 50),
      };
    }
    if (hr === "zero_size") {
      return {
        platform: isMo ? "MO" : "PC",
        reason: isMo ? "zero_size@mobile-viewport" : "zero_size@desktop-viewport",
      };
    }
    return { platform: isMo ? "MO" : "PC", reason: "collapsed:" + cpClass.slice(0, 50) };
  }

  if (allMo.length && allPc.length) {
    return { platform: "All", reason: allMo[0] + "+" + allPc[0] };
  }
  if (allMo.length) return { platform: "MO", reason: allMo[0] };
  if (allPc.length) return { platform: "PC", reason: allPc[0] };

  if (hr === "visible" || hr === "offscreen") {
    return {
      platform: isMo ? "MO" : "PC",
      reason: isMo ? "visible@mobile-viewport" : "visible@desktop-viewport",
    };
  }

  if (isMo) return { platform: "MO", reason: "ambiguous@mobile-viewport" };
  return { platform: "All", reason: "ambiguous-no-signal" };
}
`.trim();

/** Keep only entries that belong on the analyzed viewport (MO ≠ PC). */
export function entryMatchesViewport(
  entry: { platform?: Platform },
  viewport: ViewportMode
): boolean {
  const p = entry.platform ?? "All";
  if (p === "All") return true;
  if (viewport === "mo") return p === "MO";
  return p === "PC";
}

export function filterEntriesByViewport(
  entries: LiveTagEntry[],
  viewport: ViewportMode
): LiveTagEntry[] {
  const kept = entries.filter((e) => entryMatchesViewport(e, viewport));
  const dropped = entries.length - kept.length;
  if (dropped > 0) {
    console.log(
      `[platform] viewport=${viewport} filtered ${entries.length} → ${kept.length} (dropped ${dropped} wrong-platform)`
    );
  }
  return kept;
}

export function computePlatformStats(entries: LiveTagEntry[]): PlatformStats {
  const stats: PlatformStats = { PC: 0, MO: 0, All: 0, total: entries.length };
  for (const e of entries) {
    const p = e.platform ?? "All";
    stats[p]++;
  }
  return stats;
}

export function computeCandidatePlatformStats(
  candidates: { platform?: Platform }[]
): PlatformStats {
  const stats: PlatformStats = { PC: 0, MO: 0, All: 0, total: candidates.length };
  for (const c of candidates) {
    const p = c.platform ?? "All";
    stats[p]++;
  }
  return stats;
}

export function logPlatformDiagnostics(entries: LiveTagEntry[], label = "platform"): void {
  const stats = computePlatformStats(entries);
  console.log(
    `[${label}] distribution PC=${stats.PC} MO=${stats.MO} All=${stats.All} total=${stats.total}`
  );

  const samples = { MO: 0, PC: 0, All: 0 };
  for (const e of entries) {
    const p = e.platform ?? "All";
    if (samples[p] < 3) {
      console.log(
        `[${label} diag] tag_id=${e.tag_id} platform=${p} reason=${e.platform_reason ?? "-"} ` +
          `hidden=${e.visibility?.hidden_reason ?? "-"} text="${e.text.slice(0, 25)}"`
      );
      samples[p]++;
    }
  }

  console.log(
    `[정합성] ${label} classified=${entries.length} dropped=0 ` +
      `PC+MO+All=${stats.PC + stats.MO + stats.All}`
  );
}
