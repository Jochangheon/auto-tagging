/**
 * Capture tutorial screenshots (login + each wizard step).
 * Asks the running backend for a localhost-only /api/auth/dev-login cookie.
 *
 * Usage (repo root, with npm run dev:backend already up):
 *   npx tsx ./packages/backend/scripts/capture-tutorial-screens.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "../public/tutorial/screens");
const PORT = Number(process.env.PORT ?? 8080);
const BASE = `http://127.0.0.1:${PORT}`;

const STEPS = [
  { file: "00-login.png", path: "/login.html", label: "로그인" },
  { file: "01-project.png", step: 0, label: "프로젝트 선택" },
  { file: "02-site-input.png", step: 1, label: "사이트 입력" },
  { file: "03-analyze.png", step: 2, label: "분석 실행" },
  { file: "04-candidates.png", step: 3, label: "후보 선택" },
  { file: "05-taxonomy.png", step: 4, label: "택소노미 초안" },
  { file: "06-export.png", step: 5, label: "검토 & 보내기" },
];

async function showWizardStep(page, step) {
  await page.evaluate((n) => {
    document.querySelectorAll(".wizard-panel").forEach((p) => {
      p.classList.toggle("active", Number(p.dataset.step) === n);
    });
    document.querySelectorAll(".wizard-step-btn").forEach((btn) => {
      const id = Number(btn.dataset.step);
      btn.classList.toggle("active", id === n);
      btn.classList.toggle("done", id < n);
      btn.disabled = false;
      const num = btn.querySelector(".wizard-step-num");
      if (num) num.textContent = id < n ? "✓" : String(id);
    });
    const progressText = document.getElementById("wizard-progress-text");
    if (progressText) progressText.textContent = `${n} / 5 단계`;
    window.scrollTo(0, 0);
  }, step);

  if (step === 1) {
    await page.evaluate(() => {
      const rows = document.getElementById("url-rows");
      if (!rows) return;
      rows.innerHTML = `
        <div class="url-row">
          <input type="url" value="https://example.com/" readonly />
          <div class="vp-toggles">
            <button type="button" class="active">PC</button>
            <button type="button" class="active">MO</button>
          </div>
        </div>`;
      const summary = document.getElementById("url-summary");
      if (summary) summary.textContent = "등록 URL 1개 · PC 1 · MO 1";
      document.getElementById("auth-login-card")?.scrollIntoView({
        block: "center",
        behavior: "instant",
      });
    });
  }
  if (step === 2) {
    await page.evaluate(() => {
      const cards = document.getElementById("job-cards");
      if (!cards) return;
      cards.innerHTML = `
        <article class="job-card">
          <div class="job-card-head"><strong>example.com</strong><span class="badge done">완료</span></div>
          <div class="job-card-meta">PC · MO · Phase 1 완료</div>
        </article>`;
    });
  }
  if (step === 3) {
    await page.evaluate(() => {
      if (window.TutorialTour?.start) {
        window.TutorialTour.start(3);
        return;
      }
      const list = document.getElementById("list");
      if (!list) return;
      list.innerHTML = `
        <li class="tree-page active-page"><div class="tree-item-main">
          <input type="checkbox" class="tree-select-cb" checked />
          <span class="tree-chevron">▾</span>
          <span class="tree-tier-pill pill-page">페이지</span>
          <span class="tree-row-title">홈</span>
          <span class="meta tree-row-count">클릭 ×5 · 페이지뷰</span>
          <span class="page-url">http://ibank-ax.com/</span>
        </div></li>
        <li class="tree-category">
          <input type="checkbox" class="tree-select-cb" checked />
          <span class="tree-row-body">
            <span class="tree-chevron">▾</span>
            <span class="tree-tier-pill pill-category">카테고리</span>
            <span class="tree-row-title">메인</span>
            <span class="meta tree-row-count">×5</span>
          </span>
        </li>
        <li class="tree-action">
          <input type="checkbox" class="tree-select-cb" checked />
          <span class="tree-row-body">
            <span class="tree-chevron">▾</span>
            <span class="tree-tier-pill pill-action">액션</span>
            <span class="tree-row-title">GNB</span>
          </span>
        </li>
        <li class="label-row selected"><div class="tree-item-main">
          <input type="checkbox" class="tree-select-cb" checked />
          <span class="tree-tier-pill pill-label">요소</span>
          <strong class="label-text">제품</strong>
          <span class="meta tag-id-meta">#12</span>
        </div></li>`;
    });
  }
  if (step === 5) {
    await page.evaluate(() => {
      const stats = document.getElementById("export-stats");
      if (stats) {
        stats.innerHTML = `
          <div class="export-stat"><strong>12</strong><span>이벤트</span></div>
          <div class="export-stat"><strong>3</strong><span>페이지</span></div>
          <div class="export-stat"><strong>PC+MO</strong><span>플랫폼</span></div>`;
      }
    });
  }

  await page.waitForTimeout(450);
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const view = { width: 1440, height: 900, deviceScaleFactor: 1 };
  const manifest = [];

  // Login screen must be captured BEFORE setting the session cookie
  // (login.js redirects authenticated users to /).
  {
    const anon = await browser.newContext({ viewport: view, deviceScaleFactor: 1 });
    const page = await anon.newPage();
    await page.goto(`${BASE}/login.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".login-card", { timeout: 15000 });
    await page.waitForTimeout(400);
    const out = join(outDir, "00-login.png");
    await page.screenshot({ path: out, fullPage: false });
    manifest.push({ file: "00-login.png", label: "로그인" });
    console.log("[capture] 00-login.png — 로그인");
    await anon.close();
  }

  const context = await browser.newContext({
    viewport: view,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  const loginRes = await page.request.post(`${BASE}/api/auth/dev-login`);
  if (!loginRes.ok()) {
    throw new Error(
      `dev-login failed (${loginRes.status()}). Is the backend running with latest code? ${await loginRes.text()}`
    );
  }
  console.log("[capture] session via /api/auth/dev-login");

  for (const item of STEPS) {
    if (item.path) continue; // login already captured
    const out = join(outDir, item.file);
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".wizard-app", { timeout: 20000 });
    await showWizardStep(page, item.step);
    await page.screenshot({ path: out, fullPage: item.step === 1 });
    manifest.push({ file: item.file, label: item.label });
    console.log(`[capture] ${item.file} — ${item.label}`);
  }

  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await browser.close();
  console.log(`[capture] done → ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
