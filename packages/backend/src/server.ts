import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionsRouter } from "./routes/sessions.js";
import { eventsRouter } from "./routes/events.js";
import { analyzeSnapshotRouter } from "./routes/analyze-snapshot.js";
import { llmModelsRouter } from "./routes/llm-models.js";
import { devTestRouter } from "./routes/dev-test.js";
import { getExtractorStatus } from "./extractors/pipeline.js";
import { getLlmHealthStatus } from "./llm/client.js";
import { cleanupRegisteredSessions } from "./crawl/firecrawl-session-registry.js";
import { authRouter } from "./auth/routes.js";
import { attachAuth, requireAuth } from "./auth/middleware.js";
import { isMicrosoftOAuthConfigured } from "./auth/config.js";
import { ensureMigrated, isDatabaseConfigured } from "./db/pool.js";
import { projectsRouter } from "./routes/projects.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "../public");

const app = express();
app.use(express.json({ limit: "12mb" }));

const allowOrigin = process.env.CORS_ORIGIN?.trim() || "";
app.use((req, res, next) => {
  if (allowOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else if (!process.env.AZURE_AD_CLIENT_ID) {
    // Legacy local: open CORS when OAuth not configured
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  void attachAuth(req, res, next);
});

const API_BASE = "/api/v1";
app.get(`${API_BASE}/health`, (_req, res) => {
  res.status(200).json({
    status: "ok",
    extractors: getExtractorStatus(),
    ...getLlmHealthStatus(),
    firecrawl_md: process.env.USE_FIRECRAWL_MD === "1",
    database: isDatabaseConfigured(),
  });
});
app.use(API_BASE, sessionsRouter);
app.use(API_BASE, eventsRouter);
app.use(API_BASE, llmModelsRouter);
app.use(API_BASE, analyzeSnapshotRouter);

app.use("/api/auth", authRouter);
// Capture PNGs must load in <img> without depending on auth cookie timing /
// cached 401 JSON responses (that shows as a broken image in preview).
app.use("/api/dev", (req, res, next) => {
  if (req.method === "GET" && req.path.startsWith("/captures/")) {
    next();
    return;
  }
  void requireAuth(req, res, next);
}, devTestRouter);
app.use("/api/projects", requireAuth, projectsRouter);

function authDisabledEnv(): boolean {
  return process.env.AUTH_DISABLED === "1" || process.env.AUTH_DISABLED === "true";
}

function sendNoStore(res: express.Response): void {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
}

function requirePageAuth(req: express.Request, res: express.Response): boolean {
  if (authDisabledEnv()) return true;
  if (req.authUser) return true;
  sendNoStore(res);
  res.redirect("/login.html");
  return false;
}

/** Login page */
app.get("/login.html", (_req, res) => {
  sendNoStore(res);
  res.sendFile(join(publicDir, "login.html"));
});

/** App home + index.html — both require login (static must not bypass). */
app.get(["/", "/index.html"], (req, res) => {
  if (!requirePageAuth(req, res)) return;
  sendNoStore(res);
  res.sendFile(join(publicDir, "index.html"));
});

app.use(express.static(publicDir, {
  index: false,
  etag: false,
  setHeaders(res, filePath) {
    if (
      filePath.endsWith(".html") ||
      filePath.endsWith(".js") ||
      filePath.endsWith(".css")
    ) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
    }
  },
}));

const PORT = Number(process.env.PORT ?? 8080);

/** Playwright dialog races must not take down the analyze server mid-batch. */
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (
    msg.includes("handleJavaScriptDialog") ||
    msg.includes("No dialog is showing") ||
    msg.includes("__name is not defined")
  ) {
    console.warn("[autotag] swallowed non-fatal rejection:", msg);
    return;
  }
  console.error("[autotag] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  const msg = err?.message ?? String(err);
  if (
    msg.includes("handleJavaScriptDialog") ||
    msg.includes("No dialog is showing") ||
    msg.includes("__name is not defined")
  ) {
    console.warn("[autotag] swallowed non-fatal exception:", msg);
    return;
  }
  console.error("[autotag] uncaughtException:", err);
  process.exit(1);
});

void cleanupRegisteredSessions().catch((err) => {
  console.warn("[firecrawl] startup session cleanup failed:", err);
});

if (isDatabaseConfigured()) {
  void ensureMigrated()
    .then(() => console.log("[db] migrations ready"))
    .catch((err) => console.error("[db] migrate failed:", err));
} else {
  console.warn("[db] DISABLE_DB=1 — analysis cache & login persistence disabled");
}

const server = app.listen(PORT, () => {
  console.log(`[autotag] backend on :${PORT}${API_BASE}`);
  console.log(`[autotag] UI → http://localhost:${PORT}/`);
  console.log(`[autotag] Auth → http://localhost:${PORT}/api/auth/me`);
  if (isMicrosoftOAuthConfigured()) {
    const fromEnv = Boolean(process.env.AZURE_AD_CLIENT_ID?.trim());
    console.log(`[auth] Microsoft login ready (${fromEnv ? "server .env" : "saved config"})`);
  } else {
    console.warn("[auth] Microsoft login NOT configured — set AZURE_AD_CLIENT_ID in packages/backend/.env");
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[autotag] port ${PORT} already in use. Close the other backend (or kill the process on :${PORT}) and retry.`
    );
    process.exit(1);
  }
  console.error("[autotag] server error:", err);
  process.exit(1);
});
