import { Router } from "express";
import type { CreateSessionRequest, UpsertScreenRequest } from "@autotag/shared";
import * as store from "../store/memory.js";

export const sessionsRouter = Router();

sessionsRouter.post("/sessions", (req, res) => {
  const body = req.body as CreateSessionRequest;
  if (!body?.session_id || !body?.project) {
    return res.status(400).json({ error: "session_id and project required" });
  }

  const existing = store.getSession(body.session_id);
  const record = store.createSession(body);
  const status = existing ? 200 : 201;

  return res.status(status).json({
    session_id: record.session_id,
    status: record.status,
    created_at: record.created_at,
  });
});

sessionsRouter.put("/sessions/:sid/screens/:screenId", (req, res) => {
  const { sid, screenId } = req.params;
  const body = req.body as UpsertScreenRequest;

  if (!store.getSession(sid)) {
    return res.status(404).json({ error: "session_not_found" });
  }

  const screen = store.upsertScreen(sid, { ...body, screen_id: screenId });
  if (!screen) return res.status(404).json({ error: "session_not_found" });

  return res.status(200).json({
    screen_id: screen.screen_id,
    updated_at: new Date().toISOString(),
  });
});

sessionsRouter.get("/sessions/:sid", (req, res) => {
  const spec = store.getSpec(req.params.sid);
  if (!spec) return res.status(404).json({ error: "session_not_found" });
  return res.json(spec);
});
