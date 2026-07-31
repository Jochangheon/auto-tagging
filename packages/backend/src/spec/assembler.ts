import type { Spec } from "@autotag/shared";
import type { SessionRecord } from "../store/memory.js";

export function assembleSpec(session: SessionRecord): Spec {
  const screens = [...session.screens.values()].map((scr) => ({
    screen_id: scr.screen_id,
    screen_name: scr.screen_name,
    page_url_pattern: scr.page_url_pattern,
    detected_by: scr.detected_by,
    capture: scr.capture,
    events: [...scr.events.values()],
  }));

  return {
    spec_version: "1.0",
    session_id: session.session_id,
    project: session.project,
    naming_convention: "unified-v1",
    platform_targets_recommended: ["ga4"],
    screens,
  };
}
