import { Router } from "express";
import type { PatchEventRequest, UpsertEventsRequest } from "@autotag/shared";
import * as store from "../store/memory.js";

export const eventsRouter = Router();

eventsRouter.post("/sessions/:sid/screens/:screenId/events", async (req, res) => {
  const { sid, screenId } = req.params;
  const body = req.body as UpsertEventsRequest;

  if (!body?.events || !Array.isArray(body.events)) {
    return res.status(400).json({ error: "events array required" });
  }

  try {
    const result = await store.upsertEvents(sid, screenId, body.events);
    if (!result) return res.status(404).json({ error: "session_not_found" });
    return res.status(200).json(result);
  } catch (err) {
    console.error("[autotag] upsert events failed", err);
    return res.status(500).json({ error: "upsert_events_failed" });
  }
});

eventsRouter.patch("/sessions/:sid/events/:eventId", (req, res) => {
  const { sid, eventId } = req.params;
  const body = req.body as PatchEventRequest;

  const updated = store.patchEvent(sid, eventId, body);
  if (!updated) return res.status(404).json({ error: "event_not_found" });

  return res.status(200).json(updated);
});
