/**
 * Self-test: reset → batch-analyze 2 PC URLs → poll until done or timeout.
 * Usage: node --experimental-strip-types scripts/selftest-batch.mjs
 *        or: node packages/backend/scripts/selftest-batch.mjs
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
  console.log(`[selftest] health ok`);

  await jfetch("/api/dev/pipeline/reset", { method: "POST" });
  console.log(`[selftest] pipeline reset`);

  const urls = [
    { url: "https://solution.ibank.co.kr/", viewport: "pc", alias: "ibank" },
    { url: "https://kanu.co.kr/", viewport: "pc", alias: "kanu" },
  ];

  const start = await jfetch("/api/dev/batch-analyze", {
    method: "POST",
    body: JSON.stringify({ urls }),
  });
  if (!start.res.ok || !start.data.ok) {
    throw new Error(`batch start failed: ${JSON.stringify(start.data)}`);
  }
  const batchId = start.data.batch_id;
  console.log(`[selftest] batch=${batchId.slice(0, 8)} concurrency=${start.data.concurrency}`);

  const MAX_MS = 10 * 60 * 1000;
  let lastLog = "";
  while (Date.now() - started < MAX_MS) {
    await sleep(3000);
    const { data } = await jfetch(`/api/dev/batch/${batchId}/progress`);
    if (!data.ok) throw new Error("progress failed");
    const line = data.items
      .map((it) => `${it.alias || it.url}:${it.status}:${it.progress_pct ?? 0}`)
      .join(" | ");
    if (line !== lastLog) {
      console.log(`[selftest] ${line} capture_pending=${data.capture_pending}`);
      lastLog = line;
    }
    const allSettled = data.items.every((it) => it.status === "done" || it.status === "error");
    if (data.status === "done" && allSettled && !data.capture_pending) break;
    if (data.status === "done" && allSettled && data.capture_pending) {
      // Phase 1 done; wait a bit more for captures then finish report
      if (Date.now() - started > 8 * 60 * 1000) break;
    }
  }

  const final = await jfetch(`/api/dev/batch/${batchId}/progress`);
  const elapsed = Math.round((Date.now() - started) / 1000);
  console.log("\n======== SELFTEST RESULT ========");
  console.log(`elapsed_sec=${elapsed}`);
  console.log(`batch_status=${final.data.status} capture_pending=${final.data.capture_pending}`);
  for (const it of final.data.items || []) {
    console.log(
      `- ${it.alias || it.url} [${it.viewport}] status=${it.status}` +
        (it.candidate_count != null ? ` candidates=${it.candidate_count}` : "") +
        (it.error ? ` error=${it.error}` : "")
    );
  }
  const failed = (final.data.items || []).filter((it) => it.status === "error");
  const stuck = (final.data.items || []).filter((it) => it.status === "running" || it.status === "queued");
  if (stuck.length) {
    console.log(`FAIL: ${stuck.length} still running/queued (hang risk)`);
    process.exit(2);
  }
  if (failed.length === final.data.items.length) {
    console.log("FAIL: all items failed");
    process.exit(1);
  }
  console.log(failed.length ? `PARTIAL: ${failed.length} failed` : "OK: no hangs, at least one success");
  process.exit(failed.length ? 3 : 0);
}

main().catch((err) => {
  console.error("[selftest] ERROR", err);
  process.exit(1);
});
