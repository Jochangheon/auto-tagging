/**
 * Smoke test for accelerated analyze queues:
 * - same-host navigate_reuse
 * - collecting → naming → done (+ capture)
 * - server stays alive (no dialog/__name crash)
 *
 * Usage (backend must be running with AUTH_DISABLED=1):
 *   node packages/backend/scripts/selftest-queue-phases.mjs
 */
const BASE = process.env.SELFTEST_BASE || "http://localhost:8080";

async function jfetch(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const started = Date.now();
  console.log(`[selftest] base=${BASE}`);

  const health = await jfetch("/api/v1/health");
  if (!health.res.ok) throw new Error("health failed — is backend up?");
  console.log(`[selftest] health ok database=${health.data.database}`);

  const me = await jfetch("/api/auth/me");
  if (!me.res.ok || !me.data?.user?.id) {
    throw new Error(
      "auth/me failed — start backend with AUTH_DISABLED=1 for this selftest"
    );
  }
  console.log(`[selftest] auth user=${me.data.user.id.slice(0, 8)}`);

  const proj = await jfetch("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: `selftest-queue-${Date.now()}` }),
  });
  if (!proj.res.ok || !proj.data?.project?.id) {
    throw new Error(`create project failed: ${JSON.stringify(proj.data)}`);
  }
  const projectId = proj.data.project.id;
  console.log(`[selftest] project=${projectId.slice(0, 8)}`);

  await jfetch("/api/dev/pipeline/reset", { method: "POST" });

  // Same host (kanu) × 2 paths → should log navigate_reuse for the 2nd URL.
  // Plus one other host to exercise FC concurrency=2.
  const urls = [
    { url: "https://kanu.co.kr/", viewport: "pc", alias: "kanu-home" },
    { url: "https://kanu.co.kr/myshop", viewport: "pc", alias: "kanu-myshop" },
    { url: "https://solution.ibank.co.kr/", viewport: "pc", alias: "ibank" },
  ];

  const start = await jfetch("/api/dev/batch-analyze", {
    method: "POST",
    body: JSON.stringify({
      urls,
      project_id: projectId,
      force: true,
      viewport: "pc",
    }),
  });
  if (!start.res.ok || !start.data.ok) {
    throw new Error(`batch start failed: ${JSON.stringify(start.data)}`);
  }
  const batchId = start.data.batch_id;
  if (!batchId) throw new Error("no batch_id (unexpected full cache hit with force)");
  console.log(
    `[selftest] batch=${batchId.slice(0, 8)} concurrency=${start.data.concurrency} total=${start.data.total}`
  );

  const seenPhases = new Set();
  const MAX_MS = 12 * 60 * 1000;
  let lastLog = "";
  let phase1DoneAt = 0;

  while (Date.now() - started < MAX_MS) {
    await sleep(2500);
    // Probe health every loop — crash would make this fail.
    const h = await jfetch("/api/v1/health");
    if (!h.res.ok) throw new Error("backend died mid-batch (health failed)");

    const { data } = await jfetch(`/api/dev/batch/${batchId}/progress`);
    if (!data.ok) throw new Error(`progress failed: ${JSON.stringify(data)}`);

    for (const it of data.items || []) {
      if (it.status) seenPhases.add(it.status);
    }

    const line = (data.items || [])
      .map(
        (it) =>
          `${it.alias || it.url}:${it.status}:${it.progress_pct ?? 0}` +
          (it.capture_phase ? `@${it.capture_phase}` : "")
      )
      .join(" | ");
    if (line !== lastLog) {
      console.log(`[selftest] ${line}`);
      lastLog = line;
    }

    const allSettled = (data.items || []).every(
      (it) =>
        it.status === "done" ||
        it.status === "error" ||
        it.status === "login_required"
    );
    if (data.status === "done" && allSettled) {
      if (!phase1DoneAt) phase1DoneAt = Date.now();
      if (!data.capture_pending || Date.now() - phase1DoneAt > 90_000) break;
    }
  }

  const final = await jfetch(`/api/dev/batch/${batchId}/progress`);
  const elapsed = Math.round((Date.now() - started) / 1000);
  console.log("\n======== SELFTEST RESULT ========");
  console.log(`elapsed_sec=${elapsed}`);
  console.log(`seen_statuses=${[...seenPhases].join(",")}`);
  console.log(
    `batch_status=${final.data.status} capture_pending=${final.data.capture_pending}`
  );
  for (const it of final.data.items || []) {
    console.log(
      `- ${it.alias || it.url} [${it.viewport}] status=${it.status}` +
        (it.candidate_count != null ? ` candidates=${it.candidate_count}` : "") +
        (it.capture_phase ? ` capture=${it.capture_phase}` : "") +
        (it.error ? ` error=${it.error}` : "")
    );
  }

  const items = final.data.items || [];
  const failed = items.filter((it) => it.status === "error");
  const stuck = items.filter(
    (it) =>
      it.status === "running" ||
      it.status === "queued" ||
      it.status === "collecting" ||
      it.status === "naming"
  );
  const done = items.filter((it) => it.status === "done");

  if (stuck.length) {
    console.log(`FAIL: ${stuck.length} still in-flight`);
    process.exit(2);
  }
  if (!seenPhases.has("collecting") && !seenPhases.has("naming") && done.length === 0) {
    console.log("FAIL: never observed collecting/naming and no done items");
    process.exit(1);
  }
  if (failed.length === items.length) {
    console.log("FAIL: all items failed");
    process.exit(1);
  }
  if (done.length === 0) {
    console.log("FAIL: zero successes");
    process.exit(1);
  }
  console.log(
    failed.length
      ? `PARTIAL OK: ${done.length} done, ${failed.length} failed (server stayed up)`
      : "OK: all items done, server stayed up"
  );
  process.exit(failed.length ? 3 : 0);
}

main().catch((err) => {
  console.error("[selftest] ERROR", err);
  process.exit(1);
});
