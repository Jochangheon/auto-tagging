// Candidate grouping — category + action fingerprint

import type { Platform, HiddenReason } from "./viewport.js";

/** Flat candidate row inside a group (all DOM members preserved) */
export interface CandidateMember {
  tag_id: number;
  candidate_id: string;
  label: string;
  text: string;
  category: string;
  action: string;
  event_name: string;
  selector_hint: string;
  selectors_fallback: string[];
  overlay_bbox: { x: number; y: number; w: number; h: number } | null;
  element_capture_url?: string | null;
  /** Phase 2 background capture lifecycle — see RecommendedTagCandidate. */
  capture_status?: "pending" | "capturing" | "done" | "failed";
  platform?: Platform;
  hidden_reason?: HiddenReason;
}

/** Leaf: same label within one action (members may repeat on screen). */
export interface CandidateLabelGroup {
  label_key: string;
  label: string;
  display_label: string;
  member_total: number;
  sort_y: number;
  sort_x: number;
  members: CandidateMember[];
  member_tag_ids: number[];
}

/** 2nd level: action within category. */
export interface CandidateTreeAction {
  action_key: string;
  action: string;
  display_action: string;
  member_total: number;
  sort_y: number;
  sort_x: number;
  label_groups: CandidateLabelGroup[];
  /** When true, UI skips action row — labels sit directly under category. */
  flattened?: boolean;
}

/** 1st level: category (Header/GNB/메인 등). */
export interface CandidateTreeCategory {
  category_key: string;
  category: string;
  display_category: string;
  member_total: number;
  sort_y: number;
  sort_x: number;
  actions: CandidateTreeAction[];
}

/** category → action → label hierarchy for workspace list. */
export interface CandidateTree {
  categories: CandidateTreeCategory[];
  member_total: number;
  category_count: number;
  action_count: number;
  label_group_count: number;
}

/** Grouped workspace list row (flat leaf — backward compat / verify scripts). */
export interface CandidateGroup {
  group_id: string;
  group_key: string;
  category: string;
  action: string;
  event_name: string;
  display_label: string;
  /** Korean area name for UI */
  display_category?: string;
  /** Korean action label for UI */
  display_action_label?: string;
  member_total: number;
  members_visible: CandidateMember[];
  members_hidden_count: number;
  member_tag_ids: number[];
}

export const VISIBLE_MEMBER_SAMPLE = 5;

/** Site-wide nav regions (global/gnb, global/fnb). */
export function isGlobalNavCategory(category: string): boolean {
  const c = category.toLowerCase().trim();
  return c.startsWith("global/gnb") || c.startsWith("global/fnb");
}

export function buildGroupKey(category: string, action: string, event_name: string): string {
  const cat = category.trim();
  const act = action.trim();
  const ev = event_name.trim();
  if (ev) return `${cat}::${act}::${ev}`;
  return `${cat}::${act}`;
}

/** Derive unified-v1 event_name from LLM category + action. */
export function deriveEventName(category: string, action: string): string {
  const cat = slugSegment(category.replace(/\//g, "_"));
  const act = slugSegment(action);
  if (!cat && act) return act.slice(0, 80);
  if (cat && !act) return cat.slice(0, 80);
  if (!cat && !act) return "click_ambiguous_element";

  const isGlobalNav = isGlobalNavCategory(category);
  if (isGlobalNav) {
    const prefixed = act.startsWith("click_") ? act : `click_${act}`;
    return prefixed.slice(0, 80);
  }

  const combined = act.startsWith("click_") ? `${cat}_${act.slice(6)}` : `${cat}_${act}`;
  return combined.slice(0, 80);
}

function slugSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}
