import { randomUUID } from "node:crypto";
import type { CreateSessionRequest } from "@autotag/shared";
import type { Screen, Spec, TaggingEvent } from "@autotag/shared";
import { assembleSpec } from "../spec/assembler.js";
import { nameEventsWithLlm } from "../llm/client.js";

function fallbackEventName(event: TaggingEvent): { event_name: string; parameters: [] } {
  const base = event.event_type === "click" ? "click" : event.event_type;
  return { event_name: base, parameters: [] };
}

interface SessionRecord {
  session_id: string;
  project: string;
  created_at: string;
  status: "active";
  metadata?: Record<string, unknown>;
  screens: Map<string, ScreenRecord>;
}

interface ScreenRecord extends Omit<Screen, "events"> {
  events: Map<string, StoredEvent>;
}

interface StoredEvent extends TaggingEvent {
  event_id: string;
  llm_status: "pending" | "complete";
}

const sessions = new Map<string, SessionRecord>();

export function createSession(body: CreateSessionRequest): SessionRecord {
  const existing = sessions.get(body.session_id);
  if (existing) return existing;

  const record: SessionRecord = {
    session_id: body.session_id,
    project: body.project,
    created_at: new Date().toISOString(),
    status: "active",
    metadata: body.metadata,
    screens: new Map(),
  };
  sessions.set(body.session_id, record);
  return record;
}

export function getSession(sid: string): SessionRecord | undefined {
  return sessions.get(sid);
}

export function upsertScreen(
  sid: string,
  screen: Omit<Screen, "events">
): ScreenRecord | null {
  const session = sessions.get(sid);
  if (!session) return null;

  const existing = session.screens.get(screen.screen_id);
  if (existing) {
    Object.assign(existing, { ...screen, events: existing.events });
    return existing;
  }

  const record: ScreenRecord = { ...screen, events: new Map() };
  session.screens.set(screen.screen_id, record);
  return record;
}

export async function upsertEvents(
  sid: string,
  screenId: string,
  events: TaggingEvent[]
): Promise<{
  accepted: number;
  upserted: number;
  skipped: number;
  events: { event_id: string; stable_key: string; llm_status: "pending" | "complete"; event_name: string | null }[];
} | null> {
  const session = sessions.get(sid);
  if (!session) return null;

  let screen = session.screens.get(screenId);
  if (!screen) {
    screen = {
      screen_id: screenId,
      screen_name: screenId,
      page_url_pattern: "*",
      detected_by: "route",
      events: new Map(),
    };
    session.screens.set(screenId, screen);
  }

  let upserted = 0;
  let skipped = 0;
  const results: { event_id: string; stable_key: string; llm_status: "pending" | "complete"; event_name: string | null }[] = [];

  const needsLlm = events.filter((e) => !e.event_name?.length);
  const sessionModel =
    typeof session.metadata?.llm_model === "string" ? session.metadata.llm_model : undefined;
  const llmNames =
    needsLlm.length > 0
      ? await nameEventsWithLlm(needsLlm, sessionModel).catch(() => new Map())
      : new Map<string, { event_name: string; parameters: { name: string; value_hint: string | null }[] }>();

  for (const incoming of events) {
    const existing = screen.events.get(incoming.stable_key);
    const named =
      incoming.event_name != null && incoming.event_name.length > 0
        ? { event_name: incoming.event_name, parameters: incoming.parameters ?? [] }
        : llmNames.get(incoming.stable_key) ?? fallbackEventName(incoming);

    if (existing) {
      Object.assign(existing, incoming, {
        event_name: named.event_name,
        parameters: named.parameters,
        platform_targets: ["ga4"],
        llm_status: "complete" as const,
      });
      skipped++;
    } else {
      const event_id = `evt_${randomUUID().slice(0, 8)}`;
      const stored: StoredEvent = {
        ...incoming,
        event_id,
        event_name: named.event_name,
        parameters: named.parameters,
        platform_targets: ["ga4"],
        llm_status: "complete",
      };
      screen.events.set(incoming.stable_key, stored);
      upserted++;
    }

    const current = screen.events.get(incoming.stable_key)!;
    results.push({
      event_id: current.event_id,
      stable_key: current.stable_key,
      llm_status: current.llm_status,
      event_name: current.event_name,
    });
  }

  return { accepted: events.length, upserted, skipped, events: results };
}

export function patchEvent(
  sid: string,
  eventId: string,
  partial: Partial<Pick<TaggingEvent, "event_name" | "qa_status" | "source" | "notes">>
): TaggingEvent | null {
  const session = sessions.get(sid);
  if (!session) return null;

  for (const screen of session.screens.values()) {
    for (const ev of screen.events.values()) {
      if (ev.event_id === eventId) {
        Object.assign(ev, partial);
        return ev;
      }
    }
  }
  return null;
}

export function getSpec(sid: string): Spec | null {
  const session = sessions.get(sid);
  if (!session) return null;
  return assembleSpec(session);
}

export type { SessionRecord, ScreenRecord, StoredEvent };
