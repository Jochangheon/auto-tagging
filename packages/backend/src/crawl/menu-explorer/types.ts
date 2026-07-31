import type { Page } from "playwright";
import type { ViewportMode } from "@autotag/shared";
import type { LiveTagEntry, TagLiveDomStats } from "../tag-live-dom.js";
import type { PanelCollectHints } from "./site-adapters/panel-collect-hints.js";
import type { OverlayDismissHints } from "./site-adapters/overlay-dismiss-hints.js";

export type { PanelCollectHints } from "./site-adapters/panel-collect-hints.js";
export type { OverlayDismissHints } from "./site-adapters/overlay-dismiss-hints.js";

export type MenuPanelPattern = "shared_overlay_panel" | "adjacent_dropdown" | "unknown";
export type OpenMethod = "click";

export interface SharedPanelTagResult {
  tagged: number;
  activePanels: number;
  linkLabels: string[];
  skippedOpacityZeroP: number;
}

export interface TriggerCandidate {
  key: string;
  label: string;
  tag_id: number | null;
  selector_hint: string;
  method: OpenMethod;
  depth: number;
  score: number;
  signals: string[];
}

export interface MenuPathStep {
  key: string;
  label: string;
  method: OpenMethod;
  selector_hint: string;
}

/** Legacy stored paths may list `hover`; replay uses click only. */
export function normalizeMenuPath(
  steps: ReadonlyArray<{ key: string; label: string; method?: string; selector_hint: string }>
): MenuPathStep[] {
  return steps.map((s) => ({
    key: s.key,
    label: s.label,
    selector_hint: s.selector_hint,
    method: "click",
  }));
}

export interface SiteAdapter {
  matches(url: string, viewport: ViewportMode): boolean;
  menuPanelPattern?: MenuPanelPattern | "auto";
  /** Baseline + panel/hidden collect only — no click DFS (fast PC path). */
  flatPanelCollect?: boolean;
  findExpandTriggers?(
    page: Page,
    containerSelector?: string
  ): Promise<TriggerCandidate[]>;
  excludeTriggerKeys?: (keys: Set<string>) => void;
  maxDepth?: number;
  maxStatesPerPage?: number;
  preparePage?(page: Page, viewport: ViewportMode): Promise<void>;
  closeSiblingMenus?(page: Page): Promise<void>;
  tagPanelContent?(page: Page, ctx?: { triggerLabel?: string }): Promise<SharedPanelTagResult | void>;
  panelCollectHints?: PanelCollectHints;
  overlayDismissHints?: OverlayDismissHints;
}

export interface ExploreMenuTreeOptions {
  maxDepth?: number;
  maxStatesPerPage?: number;
  viewport?: ViewportMode;
  siteAdapter?: SiteAdapter;
  onSnapshot?: (entries: LiveTagEntry[], path: MenuPathStep[]) => Promise<void>;
  /** Original page URL — clicking a trigger that turns out to be a real nav
   * link must restore this URL before exploration continues. */
  pageUrl?: string;
}

export interface MenuExploreState {
  statesExplored: number;
  openedKeys: string[];
  skippedTriggers: number;
  pathByTagId: Map<number, MenuPathStep[]>;
  startedAt: number;
}

export interface RecursiveMenuExploreResult {
  entries: LiveTagEntry[];
  opened_paths: MenuPathStep[][];
  states_explored: number;
  expand_opened: string[];
  skipped: boolean;
  skipped_triggers: number;
  tag_stats: TagLiveDomStats;
  path_by_tag_id: Record<number, MenuPathStep[]>;
  total_elapsed_ms: number;
}
