/**
 * 택소노미 초안 마법사 — 프로젝트 → 사이트 분석 → 택소노미의 3단계 오케스트레이션
 */
(function () {
  const STEPS = [
    { id: 0, label: "프로젝트 선택" },
    { id: 1, label: "사이트 입력 & 분석" },
    { id: 2, label: "택소노미 확인 및 수정" },
  ];

  const $ = (id) => document.getElementById(id);

  let state = defaultState();
  let projects = [];
  let projectLoading = false;
  let projectOpening = false;
  let settingsContinueAfterSave = false;
  /** "create" = dialog only until save; "edit" = existing project settings */
  let settingsMode = "edit";
  let analyzeAbort = false;
  let analyzeRunning = false;
  /** @type {Set<string>|null} Keys of jobs in the current analyze/reanalyze run. */
  let activeAnalyzeKeys = null;
  /** 분석 중 「다시 시도/다시 분석」을 누르면 여기에 쌓였다가 현재 배치 종료 후 이어서 실행 */
  let analyzeWaitQueue = [];
  let autosaveTimer = null;
  /** 상단 진행 바 — 단계가 확실히 완료될 때만 증가 (되돌아가지 않음). */
  let progressBarCompleted = -1;
  let lastWizardCompleted = -1;
  let capturePhasePollTimer = null;
  let activeBatchId = null;
  let centerProgressTimer = null;
  /** @type {Array<{id:string,site_url:string,host:string,label:string,cookie_count:number,message?:string}>} */
  let authSessions = [];
  let interactiveLoginId = null;
  let interactiveLoginPopup = null;
  let interactiveLoginPollTimer = null;
  /** 같은 호스트에 로그인 창을 중복으로 자동 열지 않음 */
  const autoOpenedLoginHosts = new Set();
  let interactiveLoginOpening = false;

  /** Step1: Firecrawl map 결과 (분석 전 선택용). 분석은 실행하지 않음. */
  let discoveredLinks = [];
  /** @type {Set<string>} */
  let discoveredSelected = new Set();
  let discoverRunning = false;
  /** How many filtered rows to show in the pick list (pagination). */
  let discoverShowLimit = 40;
  /** Abort in-flight progressive discovery. */
  let discoverAbort = null;

  function showWizardCenterProgress(opts = {}) {
    const wrap = $("wizard-center-progress");
    const stageEl = $("wizard-center-progress-stage");
    const pctEl = $("wizard-center-progress-percent");
    const fillEl = $("wizard-center-progress-fill");
    const barEl = $("wizard-center-progress-bar");
    const detailEl = $("wizard-center-progress-detail");
    if (!wrap || !fillEl) return;

    if (centerProgressTimer) {
      clearInterval(centerProgressTimer);
      centerProgressTimer = null;
    }

    wrap.hidden = false;
    wrap.setAttribute("aria-hidden", "false");

    const indeterminate = !!opts.indeterminate;
    const pct = indeterminate ? 0 : Math.max(0, Math.min(100, Number(opts.percent) || 0));

    if (stageEl) stageEl.textContent = opts.stage || "진행 중…";
    if (pctEl) pctEl.textContent = indeterminate ? "" : pct + "%";
    if (detailEl) detailEl.textContent = opts.detail || "";
    fillEl.classList.toggle("indeterminate", indeterminate);
    if (!indeterminate) {
      fillEl.style.width = pct + "%";
      if (barEl) barEl.setAttribute("aria-valuenow", String(pct));
    } else if (barEl) {
      barEl.removeAttribute("aria-valuenow");
    }
  }

  function updateWizardCenterProgress(opts = {}) {
    const wrap = $("wizard-center-progress");
    if (!wrap || wrap.hidden) return;
    showWizardCenterProgress(opts);
  }

  function hideWizardCenterProgress() {
    const wrap = $("wizard-center-progress");
    const fillEl = $("wizard-center-progress-fill");
    if (centerProgressTimer) {
      clearInterval(centerProgressTimer);
      centerProgressTimer = null;
    }
    if (!wrap) return;
    wrap.hidden = true;
    wrap.setAttribute("aria-hidden", "true");
    if (fillEl) {
      fillEl.classList.remove("indeterminate");
      fillEl.style.width = "0%";
    }
  }

  window.__WIZARD_ON_TAXONOMY_META__ = (labels) => {
    state.columnLabels = labels || null;
    scheduleSave();
  };

  /** workspace-core confirmSelection 등에서 호출 */
  window.__WIZARD_CENTER_PROGRESS_SHOW__ = (opts) => {
    showWizardCenterProgress(opts);
    if (opts?.simulate) {
      let fakePct = Number(opts.percent) || 8;
      centerProgressTimer = setInterval(() => {
        fakePct = Math.min(88, fakePct + 3 + Math.random() * 5);
        updateWizardCenterProgress({
          stage: opts.stage || "택소노미 생성 중…",
          percent: Math.round(fakePct),
          detail: opts.detail,
        });
      }, 420);
    }
  };
  window.__WIZARD_CENTER_PROGRESS_UPDATE__ = updateWizardCenterProgress;
  window.__WIZARD_CENTER_PROGRESS_HIDE__ = hideWizardCenterProgress;

  function defaultState() {
    return {
      step: 0,
      projectId: null,
      projectName: "",
      projectDescription: "",
      sessionId: null,
      urls: [],
      jobs: [],
      columnLabels: null,
      savedAt: null,
    };
  }

  function migratePersistedStep(stored) {
    const raw = Number(stored?.step);
    if (stored?.flow_version === 3) return Math.max(1, Math.min(2, raw || 1));
    if (raw >= 4) return 2;
    return 1;
  }

  /** @deprecated single viewport — migrated to viewports[] */
  function migrateUrlEntry(entry) {
    if (!entry || typeof entry !== "object") {
      return { url: "", alias: "", viewports: defaultProjectViewports() };
    }
    if (Array.isArray(entry.viewports) && entry.viewports.length) {
      const vps = entry.viewports.filter((v) => v === "pc" || v === "mo");
      return { ...entry, viewports: vps.length ? vps : ["pc"] };
    }
    const vp = entry.viewport === "mo" ? "mo" : "pc";
    const next = { ...entry, viewports: [vp] };
    delete next.viewport;
    return next;
  }

  function entryViewports(entry) {
    if (Array.isArray(entry.viewports) && entry.viewports.length) {
      return entry.viewports.filter((v) => v === "pc" || v === "mo");
    }
    return ["pc"];
  }

  function defaultProjectViewports() {
    return ["pc"];
  }

  function jobKey(job) {
    return job.url + "::" + (job.viewport === "mo" ? "mo" : "pc");
  }

  async function saveState() {
    if (!state.projectId) return;
    state.savedAt = new Date().toISOString();
    const el = $("autosave-status");
    if (el) el.textContent = "DB 저장 중…";
    const persisted = {
      step: Math.max(1, state.step),
      flow_version: 3,
      urls: state.urls,
      jobs: state.jobs,
      column_labels: state.columnLabels || null,
      savedAt: state.savedAt,
    };
    try {
      const res = await fetch("/api/projects/" + encodeURIComponent(state.projectId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: state.projectName, state: persisted }),
      });
      if (!res.ok) throw new Error("project_save_failed");
    } catch (err) {
      if (el) el.textContent = "DB 저장 실패";
      console.error("project save failed:", err);
      return;
    }
    if (el) {
      const d = new Date(state.savedAt);
      el.textContent = "DB 저장됨 · " + d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    }
  }

  function scheduleSave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveState, 400);
  }

  function formatProjectDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("ko-KR", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function renderProjects() {
    const list = $("project-list");
    const status = $("project-list-status");
    if (!list || !status) return;
    if (projectLoading) {
      status.hidden = false;
      status.textContent = "DB에서 프로젝트를 불러오는 중…";
      list.innerHTML = "";
      return;
    }
    if (projectOpening) {
      status.hidden = false;
      status.textContent = "선택한 프로젝트를 여는 중…";
    }
    if (!projects.length) {
      status.hidden = false;
      status.textContent = "아직 프로젝트가 없습니다. 「새 프로젝트」로 첫 프로젝트를 만드세요.";
      list.innerHTML = "";
      return;
    }
    status.hidden = true;
    list.innerHTML = projects
      .map((project) => {
        const active = project.id === state.projectId;
        return (
          '<article class="project-card' + (active ? " active" : "") +
          '" role="button" tabindex="0" data-project-id="' + escapeAttr(project.id) + '">' +
          '<button type="button" class="project-delete-btn" data-project-delete="' +
          escapeAttr(project.id) + '" aria-label="프로젝트 삭제">×</button>' +
          '<div class="project-card-title">' + escapeHtml(project.name) + "</div>" +
          '<div class="project-card-meta">분석 대상 ' + Number(project.page_count || 0) +
          "개 · 완료 " + Number(project.analyzed_count || 0) + "개</div>" +
          '<div class="project-card-updated">최근 저장 ' +
          escapeHtml(formatProjectDate(project.updated_at)) + "</div>" +
          '<button type="button" class="project-card-options-btn" data-project-options="' +
          escapeAttr(project.id) + '">옵션 설정</button></article>'
        );
      })
      .join("");
    list.querySelectorAll(".project-card").forEach((card) => {
      const open = () => void openProject(card.dataset.projectId);
      card.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        open();
      });
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
    list.querySelectorAll(".project-delete-btn").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void removeProject(button.dataset.projectDelete);
      });
    });
    list.querySelectorAll(".project-card-options-btn").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void openProject(button.dataset.projectOptions, { showSettings: true });
      });
    });
  }

  async function loadProjects() {
    projectLoading = true;
    renderProjects();
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "project_list_failed");
      projects = Array.isArray(data.projects) ? data.projects : [];
    } catch (err) {
      const status = $("project-list-status");
      if (status) status.textContent = "프로젝트를 불러오지 못했습니다.";
      console.error("project list failed:", err);
      projects = [];
    } finally {
      projectLoading = false;
      renderProjects();
    }
  }

  function createProjectFromInput() {
    // Do NOT create in DB until the user presses save in the dialog.
    showCreateProjectDialog();
  }

  function showCreateProjectDialog() {
    settingsMode = "create";
    settingsContinueAfterSave = true;
    const dialog = $("project-settings-dialog");
    if (!dialog) return;
    const title = dialog.querySelector("h2");
    const lead = dialog.querySelector(".project-settings-head p");
    if (title) title.textContent = "새 프로젝트 만들기";
    if (lead) lead.textContent = "이름·설명을 입력한 뒤 「저장하고 프로젝트 열기」를 눌러야 생성됩니다. 취소하면 만들어지지 않습니다.";
    $("project-settings-name").value = "";
    $("project-settings-description").value = "";
    $("project-settings-message").textContent = "";
    $("project-settings-save").textContent = "저장하고 프로젝트 열기";
    if (!dialog.open) dialog.showModal();
    $("project-settings-name")?.focus();
  }

  async function openProject(projectId, opts = {}) {
    if (!projectId || projectOpening || projectLoading) return;
    projectOpening = true;
    const status = $("project-list-status");
    if (status) {
      status.hidden = false;
      status.textContent = "선택한 프로젝트를 여는 중…";
    }
    try {
      const res = await fetch("/api/projects/" + encodeURIComponent(projectId));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "project_open_failed");
      const stored = data.state || {};
      const { figma: _ignoredFigma, ...storedRest } = stored;
      const urls = Array.isArray(stored.urls) ? stored.urls.map(migrateUrlEntry) : [];
      const jobs = Array.isArray(stored.jobs)
        ? stored.jobs.filter((j) => !(j && j.kind === "figma"))
        : [];
      state = {
        ...defaultState(),
        ...storedRest,
        step: 0,
        resumeStep: migratePersistedStep(stored),
        projectId: data.project.id,
        projectName: data.project.name,
        projectDescription: data.project.description || "",
        sessionId: data.session_id || null,
        urls,
        jobs,
        columnLabels: stored.column_labels || stored.columnLabels || null,
      };
      resetProgressTracking();
      window.Workspace?.resetSession?.();
      if (state.sessionId && window.Workspace) {
        await window.Workspace.loadSession(state.sessionId);
      }
      if (state.columnLabels && window.Workspace?.setColumnLabels) {
        window.Workspace.setColumnLabels(state.columnLabels);
      }
      const saveStatus = $("autosave-status");
      if (saveStatus) saveStatus.textContent = "DB에서 불러옴";
      renderAll();
      resetDiscoverForProject();
      renderProjectContext();
      if (opts.showSettings) {
        showProjectSettings();
        return;
      }
      const resume = Math.max(1, Math.min(2, Number(state.resumeStep) || 1));
      goToStep(resume, { force: true });
    } catch (err) {
      const message = err && err.message ? String(err.message) : "project_open_failed";
      alert("프로젝트 데이터를 불러오지 못했습니다.\n" + message);
      console.error("project open failed:", err);
    } finally {
      projectOpening = false;
      if (state.step === 0) renderProjects();
    }
  }

  async function removeProject(projectId) {
    const project = projects.find((item) => item.id === projectId);
    if (!project || !confirm('"' + project.name + '" 프로젝트를 삭제할까요?')) return;
    try {
      const res = await fetch("/api/projects/" + encodeURIComponent(projectId), {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("project_delete_failed");
      const wasActive = state.projectId === projectId;
      if (wasActive) {
        state = defaultState();
        window.Workspace?.resetSession?.();
      }
      await loadProjects();
      renderAll();
      if (wasActive) resetDiscoverForProject();
    } catch (err) {
      alert("프로젝트를 삭제하지 못했습니다.");
      console.error("project delete failed:", err);
    }
  }

  function renderProjectContext() {
    const bar = $("project-context-bar");
    if (!bar) return;
    bar.hidden = !state.projectId;
    if (!state.projectId) return;
    const name = $("project-context-name");
    if (name) name.textContent = state.projectName || "이름 없는 프로젝트";
  }

  function showProjectSettings(continueAfterSave = state.step === 0) {
    if (!state.projectId) return;
    settingsMode = "edit";
    settingsContinueAfterSave = continueAfterSave;
    const dialog = $("project-settings-dialog");
    if (!dialog) return;
    const title = dialog.querySelector("h2");
    const lead = dialog.querySelector(".project-settings-head p");
    if (title) title.textContent = "프로젝트 옵션 설정";
    if (lead) lead.textContent = "프로젝트 이름과 설명을 관리합니다.";
    $("project-settings-name").value = state.projectName || "";
    $("project-settings-description").value = state.projectDescription || "";
    $("project-settings-message").textContent = "";
    $("project-settings-save").textContent = continueAfterSave
      ? "저장하고 프로젝트 열기"
      : "옵션 저장";
    if (!dialog.open) dialog.showModal();
  }

  function closeProjectSettings() {
    settingsMode = "edit";
    settingsContinueAfterSave = false;
    const dialog = $("project-settings-dialog");
    if (dialog?.open) dialog.close();
  }

  async function saveProjectSettings() {
    const name = $("project-settings-name").value.trim();
    const description = $("project-settings-description").value.trim();
    const message = $("project-settings-message");
    if (!name) {
      message.textContent = "프로젝트 이름을 입력하세요.";
      $("project-settings-name")?.focus();
      return;
    }
    if (settingsMode !== "create" && !state.projectId) return;

    const button = $("project-settings-save");
    button.disabled = true;
    message.textContent = settingsMode === "create" ? "프로젝트 생성 중…" : "DB에 저장 중…";
    try {
      const options = { default_viewports: ["pc"], cache_mode: "reuse" };

      if (settingsMode === "create") {
        const createRes = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const createData = await createRes.json();
        if (!createRes.ok || !createData.ok) {
          throw new Error(createData.error || "project_create_failed");
        }
        const projectId = createData.project.id;
        const patchRes = await fetch(
          "/api/projects/" + encodeURIComponent(projectId) + "/settings",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, description, options }),
          }
        );
        const patchData = await patchRes.json();
        if (!patchRes.ok || !patchData.ok) {
          throw new Error(patchData.error || "project_settings_failed");
        }
        const shouldContinue = settingsContinueAfterSave;
        closeProjectSettings();
        await loadProjects();
        await openProject(projectId);
        if (shouldContinue && state.step === 0) {
          const resume = Math.max(1, Math.min(2, Number(state.resumeStep) || 1));
          goToStep(resume, { force: true });
        }
        return;
      }

      const res = await fetch(
        "/api/projects/" + encodeURIComponent(state.projectId) + "/settings",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            description,
            options,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "project_settings_failed");
      state.projectName = data.project.name;
      state.projectDescription = data.project.description || "";
      const listed = projects.find((project) => project.id === state.projectId);
      if (listed) Object.assign(listed, data.project);
      renderProjects();
      renderProjectContext();
      const shouldContinue = settingsContinueAfterSave;
      closeProjectSettings();
      if (shouldContinue && state.step === 0) {
        const resume = Math.max(1, Math.min(2, Number(state.resumeStep) || 1));
        goToStep(resume, { force: true });
      }
    } catch (err) {
      message.textContent =
        settingsMode === "create"
          ? "프로젝트 생성에 실패했습니다."
          : "옵션 저장에 실패했습니다.";
      console.error("project settings failed:", err);
    } finally {
      button.disabled = false;
    }
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url.trim());
      u.hash = "";
      if (u.pathname.endsWith("/") && u.pathname.length > 1) u.pathname = u.pathname.slice(0, -1);
      return u.href;
    } catch {
      return String(url || "").trim();
    }
  }

  function isValidUrl(url) {
    try {
      const u = new URL(url.trim());
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }

  function validUrlEntries() {
    return state.urls.filter((e) => isValidUrl(e.url));
  }

  /** 실제로 끝난 마지막 표시 단계 (-1 = 프로젝트 미선택). */
  function getCompletedStep() {
    if (!state.projectId) return -1;
    if (!validUrlEntries().length || !state.jobs.some((j) => j.status === "done")) return 0;
    const ws = window.Workspace;
    if (!ws) return 1;
    const tax = ws.getTaxonomyData();
    return tax?.tabs?.length ? 2 : 1;
  }

  /** 지금 이동 가능한 최대 단계 (완료된 단계 + 1). */
  function getMaxAccessibleStep() {
    if (!state.projectId) return 0;
    return window.Workspace?.getTaxonomyData()?.tabs?.length ? 2 : 1;
  }

  function renderStepNav() {
    const nav = $("wizard-step-nav");
    if (!nav) return;
    const completed = getCompletedStep();
    const maxAccessible = getMaxAccessibleStep();
    nav.innerHTML = STEPS.map((s, index) => {
      const done = completed >= 0 && s.id <= completed && s.id !== state.step;
      const active = s.id === state.step;
      const locked = s.id > maxAccessible;
      const cls = [
        "wizard-step-btn",
        active ? "active" : "",
        done ? "done" : "",
        locked ? "locked" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const num = done ? "✓" : String(index + 1);
      const ariaCurrent = active ? ' aria-current="step"' : "";
      const ariaDisabled = locked ? ' aria-disabled="true"' : "";
      const statusLabel = active ? "현재 단계" : done ? "완료" : locked ? "잠김" : "이동 가능";
      return (
        '<button type="button" class="' +
        cls +
        '" data-step="' +
        s.id +
        '"' +
        (locked ? " disabled" : "") +
        ariaCurrent +
        ariaDisabled +
        ' aria-label="' +
        escapeAttr(index + 1 + ". " + s.label + " (" + statusLabel + ")") +
        '" title="' +
        escapeAttr(s.label) +
        '">' +
        '<span class="wizard-step-num" aria-hidden="true">' +
        num +
        "</span>" +
        '<span class="label">' +
        s.label +
        "</span></button>"
      );
    }).join("");
    nav.querySelectorAll(".wizard-step-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const n = Number(btn.dataset.step);
        if (n <= maxAccessible) goToStep(n);
      });
    });
  }

  function renderProgressStepLabel() {
    /* 상단 단계 바로 대체 — 구 진행 바 요소가 있으면 조용히 갱신 */
    const txt = $("wizard-progress-text");
    if (txt) txt.textContent = state.step + 1 + " / " + STEPS.length + " 단계";
  }

  /** 완료 단계가 올라갔을 때만 true — 진행 바를 움직일지 결정. */
  function bumpProgressBarIfNeeded() {
    const completed = getCompletedStep();
    if (progressBarCompleted < 0) {
      progressBarCompleted = completed;
      return true;
    }
    if (completed > progressBarCompleted) {
      progressBarCompleted = completed;
      return true;
    }
    return false;
  }

  function renderProgressBar() {
    const pct = Math.round((Math.max(0, progressBarCompleted) / 2) * 100);
    const fill = $("wizard-progress-fill");
    if (fill) fill.style.width = pct + "%";
    const done = $("wizard-progress-done");
    if (done) done.textContent = Math.max(0, progressBarCompleted) + "단계 완료";
  }

  function renderProgress() {
    renderProgressStepLabel();
    bumpProgressBarIfNeeded();
    renderProgressBar();
  }

  function resetProgressTracking() {
    progressBarCompleted = -1;
    lastWizardCompleted = -1;
  }

  function showPanel(step) {
    document.querySelectorAll(".wizard-panel").forEach((p) => {
      p.classList.toggle("active", Number(p.dataset.step) === step);
    });
    if (step === 1) {
      if (!state.jobs.length) initJobsFromUrls();
      renderJobCards();
      renderAnalyzeLead();
    }
    if (step === 0) {
      renderProjects();
      const status = $("status-text");
      if (status) {
        status.textContent = state.projectId
          ? "프로젝트 옵션을 확인하고 열어 주세요."
          : "프로젝트를 선택하거나 새로 만드세요.";
      }
    }
    updateGlobalAnalyzeBar();
    if (step === 2 && window.Workspace) {
      window.Workspace.renderTaxonomyView();
      renderExportPanel();
    }
  }

  function scheduleLayoutReflow() {
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  function canProceedFrom(step) {
    if (step === 0) return Boolean(state.projectId);
    if (step === 1) return validUrlEntries().length > 0;
    return !!window.Workspace?.getTaxonomyData()?.tabs?.length;
  }

  function updateNextButton() {
    const btn = $("wizard-next");
    if (!btn) return;
    btn.hidden = state.step === 2;
    if (state.step === 0) {
      btn.textContent = "프로젝트 열기";
    } else {
      btn.textContent = state.jobs.some((j) => j.status === "done")
        ? "택소노미 초안 만들기"
        : "분석 시작";
    }
    if (state.step === 1) {
      btn.disabled = analyzeRunning || !canProceedFrom(1);
      return;
    }
    btn.disabled = !canProceedFrom(state.step);
  }

  function goToStep(n, opts = {}) {
    if (n < 0 || n > 2) return;
    const maxAccessible = getMaxAccessibleStep();
    if (n > maxAccessible && !opts.force) return;

    state.step = n;
    renderStepNav();
    renderProgressStepLabel();
    showPanel(n);
    updateNextButton();
    scheduleSave();
  }

  window.WizardApp = {
    goToStep,
    getStep: () => state.step,
  };

  /* ── Step 1: discover URLs → select → confirmed list (no analyze) ── */

  function setDiscoverStatus(message, isError) {
    const el = $("discover-status");
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      el.classList.remove("is-error");
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle("is-error", !!isError);
  }

  function seedFromProjectUrls() {
    const first = validUrlEntries()[0]?.url;
    if (!first) return "";
    try {
      return new URL(first).origin + "/";
    } catch {
      return first;
    }
  }

  /**
   * @param {{ force?: boolean }} [opts] force=true overwrites what the user typed
   *   (used on project switch so one project's domain never leaks into another).
   */
  function syncSeedInputFromUrls(opts = {}) {
    const seed = $("seed-url-input");
    if (!seed) return;
    if (!opts.force && seed.value.trim()) return;
    const next = seedFromProjectUrls();
    if (opts.force || next) seed.value = next;
  }

  /** Clear step-1 discovery UI so it can't show another project's site. */
  function resetDiscoverForProject() {
    if (discoverAbort) {
      discoverAbort.abort();
      discoverAbort = null;
    }
    setDiscoverRunningUi(false);
    discoveredLinks = [];
    discoveredSelected = new Set();
    discoverShowLimit = 40;
    const filter = $("discover-filter");
    if (filter) filter.value = "";
    renderDiscoverPick();
    syncSeedInputFromUrls({ force: true });

    const existing = validUrlEntries().length;
    setDiscoverStatus(
      existing
        ? "이 프로젝트에 확정된 URL " + existing + "개가 있습니다. 더 찾으려면 「페이지 불러오기」를 누르세요."
        : "",
      false
    );
  }

  function filteredDiscoveredLinks() {
    const q = String($("discover-filter")?.value || "")
      .trim()
      .toLowerCase();
    if (!q) return discoveredLinks;
    return discoveredLinks.filter((l) => {
      const hay = ((l.url || "") + " " + (l.title || "")).toLowerCase();
      return hay.includes(q);
    });
  }

  /** @deprecated use filteredDiscoveredLinks — kept for select-all scope */
  function visibleDiscoveredLinks() {
    return filteredDiscoveredLinks().slice(0, discoverShowLimit);
  }

  function mergeDiscoveredLinks(links) {
    const byUrl = new Map();
    for (const l of discoveredLinks) {
      if (l?.url) byUrl.set(l.url, l);
    }
    for (const l of links || []) {
      if (!l?.url) continue;
      const prev = byUrl.get(l.url);
      byUrl.set(l.url, prev ? { ...prev, ...l } : l);
    }
    discoveredLinks = Array.from(byUrl.values());
  }

  function renderDiscoverPick() {
    const card = $("discover-pick-card");
    const list = $("discover-list");
    const countEl = $("discover-pick-count");
    if (!card || !list) return;

    if (!discoveredLinks.length) {
      card.hidden = true;
      list.innerHTML = "";
      if (countEl) countEl.textContent = "";
      return;
    }

    card.hidden = false;
    const filtered = filteredDiscoveredLinks();
    const visible = filtered.slice(0, discoverShowLimit);
    const selectedCount = discoveredLinks.filter((l) => discoveredSelected.has(l.url)).length;
    if (countEl) {
      countEl.textContent =
        "선택 " + selectedCount + " / 찾은 " + discoveredLinks.length + "개";
    }

    if (!filtered.length) {
      list.innerHTML = '<div class="url-rows-empty">검색 결과가 없습니다.</div>';
      return;
    }

    const rows = visible
      .map((link) => {
        const checked = discoveredSelected.has(link.url) ? " checked" : "";
        const title = String(link.title || "").trim();
        const titleHtml = title
          ? ' <span class="discover-item-title">(' + escapeHtml(title) + ")</span>"
          : "";
        return (
          '<label class="discover-item">' +
          '<input type="checkbox" data-url="' +
          escapeAttr(link.url) +
          '"' +
          checked +
          " />" +
          '<span class="discover-item-text">' +
          '<span class="discover-item-url">' +
          escapeHtml(link.url) +
          titleHtml +
          "</span></span></label>"
        );
      })
      .join("");

    const remaining = filtered.length - visible.length;
    const moreBtn =
      remaining > 0
        ? '<button type="button" class="btn-secondary btn-compact discover-more-btn" id="discover-show-more">목록 더 보기 (+' +
          remaining +
          ")</button>"
        : "";

    list.innerHTML = rows + moreBtn;

    list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const url = cb.getAttribute("data-url") || "";
        if (!url) return;
        if (cb.checked) discoveredSelected.add(url);
        else discoveredSelected.delete(url);
        if (countEl) {
          const n = discoveredLinks.filter((l) => discoveredSelected.has(l.url)).length;
          countEl.textContent =
            "선택 " + n + " / 찾은 " + discoveredLinks.length + "개";
        }
      });
    });

    $("discover-show-more")?.addEventListener("click", () => {
      discoverShowLimit += 40;
      renderDiscoverPick();
    });
  }

  /** Bare domain or URL → https URL for /site-map (does not start analysis). */
  function normalizeSeedInput(raw) {
    let s = String(raw || "")
      .trim()
      .replace(/[)\],.;]+$/g, "");
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    try {
      const u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      const host = u.hostname;
      const isLocal = host === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(host);
      if (!host || (!isLocal && !host.includes("."))) return "";
      u.hash = "";
      u.search = "";
      if (!u.pathname || u.pathname === "") u.pathname = "/";
      if (u.pathname === "/") return u.protocol + "//" + u.host + "/";
      if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
        u.pathname = u.pathname.slice(0, -1);
      }
      return u.href;
    } catch {
      return "";
    }
  }

  function rootDomainOfUrl(raw) {
    try {
      const host = new URL(raw).hostname.replace(/^www\./i, "").toLowerCase();
      const parts = host.split(".").filter(Boolean);
      if (parts.length <= 2) return host;
      const last2 = parts.slice(-2).join(".");
      if (
        /^(co|or|go|ac|ne|re|pe)\.kr$|^(com|co)\.(cn|jp|uk|au)$/.test(last2) &&
        parts.length >= 3
      ) {
        return parts.slice(-3).join(".");
      }
      return last2;
    } catch {
      return "";
    }
  }

  function aliasFromDiscoverTitle(title) {
    const t = String(title || "").trim();
    if (!t || t === "시드 URL") return "";
    // Long SEO titles pollute the alias field — keep short labels only.
    if (t.length > 28) return "";
    return t;
  }

  /** Default-check seed URL only — user picks the rest. */
  function defaultDiscoverSelection(links, seedUrl) {
    const selected = new Set();
    let seedCanon = "";
    try {
      const u = new URL(seedUrl);
      u.hash = "";
      if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
        u.pathname = u.pathname.slice(0, -1);
      }
      seedCanon = u.href;
    } catch {
      seedCanon = String(seedUrl || "").trim();
    }
    for (const link of links) {
      if (link.url === seedCanon || link.url === seedUrl) {
        selected.add(link.url);
      }
    }
    if (!selected.size && links[0]) selected.add(links[0].url);
    return selected;
  }

  function setDiscoverRunningUi(running) {
    discoverRunning = running;
    const btn = $("discover-urls-btn");
    const stopBtn = $("discover-stop-btn");
    if (btn) btn.disabled = running;
    if (stopBtn) stopBtn.hidden = !running;
  }

  async function runDiscoverUrls() {
    if (discoverRunning) return;
    const seedEl = $("seed-url-input");
    const seedUrl = normalizeSeedInput(seedEl?.value);
    if (!seedUrl || !isValidUrl(seedUrl)) {
      setDiscoverStatus("도메인 또는 URL을 입력하세요. 예: example.com / https://example.com", true);
      seedEl?.focus();
      return;
    }
    if (seedEl) seedEl.value = seedUrl;
    const limit = 100;
    const sitemap = "include";
    const includeSubdomains = false;
    const timeoutMs = 90_000;

    discoverAbort = new AbortController();
    discoverShowLimit = 40;
    discoveredLinks = [{ url: seedUrl }];
    discoveredSelected = new Set([seedUrl]);
    renderDiscoverPick();
    setDiscoverRunningUi(true);
    setDiscoverStatus("시드 URL 표시 · 추가로 찾는 중… (찾는 즉시 목록에 추가됩니다)", false);

    try {
      const res = await fetch("/api/dev/site-map-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        signal: discoverAbort.signal,
        body: JSON.stringify({
          url: seedUrl,
          limit,
          sitemap,
          includeSubdomains,
          ignoreQueryParameters: true,
          timeoutMs,
        }),
      });

      if (res.status === 401) {
        location.replace("/login.html");
        return;
      }

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "URL을 불러오지 못했습니다.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      let stopReason = "";

      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let ev;
          try {
            ev = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (ev.type === "seed" || ev.type === "batch") {
            if (Array.isArray(ev.links)) {
              discoveredLinks = ev.links;
            } else {
              mergeDiscoveredLinks(ev.links || []);
            }
            if (seedEl && ev.seed_url) seedEl.value = ev.seed_url;
            // Keep only previously selected + seed; never auto-check newly found URLs.
            const seedKeep = ev.seed_url || seedUrl;
            if (!discoveredSelected.size) {
              discoveredSelected = defaultDiscoverSelection(discoveredLinks, seedKeep);
            } else {
              // Drop selections that vanished; keep user choices.
              const urls = new Set(discoveredLinks.map((l) => l.url));
              discoveredSelected = new Set(
                [...discoveredSelected].filter((u) => urls.has(u))
              );
              if (!discoveredSelected.size) {
                discoveredSelected = defaultDiscoverSelection(discoveredLinks, seedKeep);
              }
            }
            renderDiscoverPick();
            const n = discoveredLinks.length;
            const step =
              ev.type === "batch" && ev.step_limit
                ? " · 단계 최대 " + ev.step_limit
                : "";
            setDiscoverStatus(
              "찾는 중… " + n + "개" + step + " · 원하면 지금 체크해서 확정해도 됩니다",
              false
            );
          } else if (ev.type === "stopped") {
            if (Array.isArray(ev.links)) discoveredLinks = ev.links;
            if (seedEl && ev.seed_url) seedEl.value = ev.seed_url;
            renderDiscoverPick();
            stopReason = ev.reason || "timeout";
            setDiscoverStatus(
              (ev.error || "수집 중단") +
                " · 지금까지 " +
                discoveredLinks.length +
                "개. 필요한 URL만 체크 후 「선택 URL 확정」하세요.",
              stopReason === "timeout"
            );
            finished = true;
          } else if (ev.type === "error") {
            throw new Error(ev.error || "URL을 불러오지 못했습니다.");
          } else if (ev.type === "done") {
            if (Array.isArray(ev.links)) discoveredLinks = ev.links;
            if (seedEl && ev.seed_url) seedEl.value = ev.seed_url;
            renderDiscoverPick();
            const filtered = Number(ev.filtered_out) || 0;
            setDiscoverStatus(
              "완료 · " +
                discoveredLinks.length +
                "개" +
                (filtered ? " (제외 " + filtered + ")" : "") +
                " · 시드만 기본 선택됨. 분석할 페이지만 체크한 뒤 「선택 URL 확정」하세요.",
              false
            );
            finished = true;
          }
        }
      }

      if (!finished && discoveredLinks.length) {
        setDiscoverStatus(
          "수집 종료 · " +
            discoveredLinks.length +
            "개. 필요한 URL만 체크 후 「선택 URL 확정」하세요.",
          false
        );
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        setDiscoverStatus(
          "수집 중단 · 지금까지 " +
            discoveredLinks.length +
            "개. 필요한 URL만 체크 후 확정하세요.",
          false
        );
      } else {
        setDiscoverStatus(err.message || "URL을 불러오지 못했습니다.", true);
      }
    } finally {
      discoverAbort = null;
      setDiscoverRunningUi(false);
    }
  }

  function stopDiscoverUrls() {
    if (discoverAbort) discoverAbort.abort();
  }

  function applyDiscoveredSelection() {
    const selected = discoveredLinks.filter((l) => discoveredSelected.has(l.url));
    if (!selected.length) {
      setDiscoverStatus("확정할 URL을 하나 이상 선택하세요.", true);
      return;
    }

    const seedRoot =
      rootDomainOfUrl($("seed-url-input")?.value || selected[0]?.url || "") || "";

    const prevByNorm = new Map();
    for (const e of state.urls) {
      if (!isValidUrl(e.url)) continue;
      prevByNorm.set(normalizeUrl(e.url), e);
    }

    // Keep confirmed URLs from other sites; replace only same root-domain set.
    const keptOther = state.urls.filter((e) => {
      if (!isValidUrl(e.url)) return false;
      if (!seedRoot) return false;
      return rootDomainOfUrl(e.url) !== seedRoot;
    });

    const mapped = selected.map((link) => {
      const norm = normalizeUrl(link.url);
      const prev = prevByNorm.get(norm);
      const title = aliasFromDiscoverTitle(link.title);
      if (prev) {
        return {
          url: link.url,
          alias: prev.alias || title || "",
          viewports: entryViewports(prev),
        };
      }
      return {
        url: link.url,
        alias: title || "",
        viewports: defaultProjectViewports(),
      };
    });

    state.urls = [...keptOther, ...mapped];

    renderUrlRows();
    renderUrlSummary();
    updateNextButton();
    scheduleSave();
    // Stay on the combined site/analyze step until the user starts analysis.
    setDiscoverStatus(
      "확정 " +
        mapped.length +
        "개" +
        (keptOther.length ? " (+다른 사이트 " + keptOther.length + "개 유지)" : "") +
        ". 아래 「분석 시작」을 누르면 택소노미 초안을 자동으로 만듭니다.",
      false
    );
  }

  function renderUrlRows() {
    const container = $("url-rows");
    if (!container) return;
    syncSeedInputFromUrls();

    if (!state.urls.length) {
      container.innerHTML =
        '<div class="url-rows-empty">아직 확정된 URL이 없습니다. 위에서 페이지를 불러와 선택하거나, 아래에 직접 추가하세요.</div>';
      renderUrlSummary();
      refreshWizardSteps();
      return;
    }

    const seen = new Set();
    container.innerHTML = state.urls
      .map((entry, i) => {
        const norm = normalizeUrl(entry.url);
        const valid = isValidUrl(entry.url);
        const dup = valid && seen.has(norm);
        if (valid) seen.add(norm);
        const rowCls = ["url-row", !valid && entry.url.trim() ? "invalid" : "", dup ? "duplicate" : ""]
          .filter(Boolean)
          .join(" ");
        const vps = entryViewports(entry);
        const hasPc = vps.includes("pc");
        const hasMo = vps.includes("mo");
        return (
          '<div class="' + rowCls + '" data-idx="' + i + '">' +
          '<input type="url" class="url-field" value="' + escapeAttr(entry.url) + '" placeholder="https://example.com" />' +
          '<input type="text" class="alias-field" value="' +
          escapeAttr(entry.alias || "") +
          '" placeholder="탭명 (비우면 AI 자동)" title="입력하지 않으면 분석 AI가 페이지 성격을 판단해 자동 입력합니다." />' +
          '<div class="viewport-toggle" role="group" aria-label="분석 뷰포트 (복수 선택 가능)">' +
          '<button type="button" data-vp="pc" class="' + (hasPc ? "active" : "") + '" title="PC 분석 포함"><span class="vp-dot" aria-hidden="true"></span>PC</button>' +
          '<button type="button" data-vp="mo" class="' + (hasMo ? "active" : "") + '" title="MO 분석 포함"><span class="vp-dot" aria-hidden="true"></span>MO</button>' +
          "</div>" +
          '<div class="url-row-actions"></div>' +
          '<button type="button" class="btn-secondary url-del">삭제</button>' +
          '<div class="url-row-status"></div>' +
          "</div>"
        );
      })
      .join("");

    container.querySelectorAll(".url-row").forEach((row) => {
      const idx = Number(row.dataset.idx);
      const urlIn = row.querySelector(".url-field");
      const aliasIn = row.querySelector(".alias-field");
      urlIn.addEventListener("input", () => {
        state.urls[idx].url = urlIn.value;
        renderUrlSummary();
        row.classList.toggle("invalid", urlIn.value.trim() && !isValidUrl(urlIn.value));
        refreshWizardSteps();
        scheduleSave();
      });
      aliasIn.addEventListener("input", () => {
        state.urls[idx].alias = aliasIn.value;
        scheduleSave();
      });
      row.querySelectorAll(".viewport-toggle button").forEach((b) => {
        b.addEventListener("click", () => {
          const vp = b.dataset.vp;
          let vps = entryViewports(state.urls[idx]);
          if (vps.includes(vp)) {
            if (vps.length <= 1) return;
            vps = vps.filter((x) => x !== vp);
          } else {
            vps = [...vps, vp].sort((a, c) => (a === "pc" ? -1 : c === "pc" ? 1 : 0));
          }
          state.urls[idx].viewports = vps;
          delete state.urls[idx].viewport;
          row.querySelectorAll(".viewport-toggle button").forEach((x) => {
            x.classList.toggle("active", vps.includes(x.dataset.vp));
          });
          renderUrlSummary();
          scheduleSave();
        });
      });
      row.querySelector(".url-del").addEventListener("click", () => {
        state.urls.splice(idx, 1);
        renderUrlRows();
        renderUrlSummary();
        updateNextButton();
        scheduleSave();
      });
    });
    bindUrlRowActionDelegate(container);
    updateUrlRowStatuses();
    renderUrlSummary();
    refreshWizardSteps();
  }

  /* ── 분석 상태를 URL 행에 직접 표시 (대상 목록 = 실행 목록) ── */

  function urlRowJobs(entry) {
    const url = (entry?.url || "").trim();
    if (!url) return [];
    return state.jobs.filter((j) => (j.url || "").trim() === url);
  }

  /** 캡처 단계는 done 상태지만 아직 진행 중이므로 별도 상태로 본다. */
  function effectiveJobStatus(job) {
    if (job.status === "done" && job.capturePhase === "running") return "capturing";
    return job.status;
  }

  function jobStatusText(job) {
    const status = effectiveJobStatus(job);
    if (status === "capturing") {
      return "이미지 캡쳐중 " + (job.captureCurrent ?? 0) + "/" + (job.captureTotal ?? "?");
    }
    if (status === "done") {
      return (job.fromCache ? "DB 불러옴" : "완료") + " · 후보 " + (job.candidateCount ?? "?") + "개";
    }
    if (status === "running") return phaseLabel(job.analyzePhase) || "태깅중…";
    if (status === "queued") {
      if (isJobInWaitQueue(jobKey(job))) return "대기풀 · 현재 작업 뒤 실행";
      if (analyzeRunning && activeAnalyzeKeys?.has(jobKey(job))) return "배치 대기";
      return "대기 중";
    }
    if (status === "login_required") return friendlyAnalyzeError(job.error || "로그인 필요", job);
    if (status === "failed") return "실패 · " + friendlyAnalyzeError(job.error || "오류", job);
    return "";
  }

  function urlRowStatusHtml(jobs) {
    if (!jobs.length) {
      return '<span class="url-row-hint">분석 대기 — PC·MO를 고르고 「분석 시작」을 누르세요.</span>';
    }
    let html = "";
    for (const job of jobs) {
      const status = effectiveJobStatus(job);
      html +=
        '<span class="url-vp-chip ' + status + '">' +
        '<span class="job-status-dot ' + status + '"></span>' +
        (job.viewport === "mo" ? "MO" : "PC") +
        " · " +
        escapeHtml(jobStatusText(job)) +
        "</span>";
    }
    const running = jobs.find((j) => j.status === "running");
    const capturing = jobs.find((j) => effectiveJobStatus(j) === "capturing");
    if (running) {
      html +=
        '<span class="url-row-progress"><span class="url-row-progress-fill" style="width:' +
        (running.progress || 0) +
        '%"></span></span>';
    } else if (capturing) {
      html +=
        '<span class="url-row-progress"><span class="url-row-progress-fill phase2" style="width:' +
        (capturing.captureProgress || 0) +
        '%"></span></span>';
    }
    return html;
  }

  function urlRowActionsHtml(jobs) {
    if (!jobs.length) return "";
    const runnable = jobs.filter(
      (j) =>
        j.status === "queued" &&
        !isJobInWaitQueue(jobKey(j)) &&
        !(analyzeRunning && activeAnalyzeKeys?.has(jobKey(j)))
    );
    const failed = jobs.filter((j) => j.status === "failed" || j.status === "login_required");
    const needsLogin = jobs.find(
      (j) =>
        j.status === "login_required" ||
        (j.status === "failed" && (j.errorKind === "login_required" || isMemberAreaUrl(j.url)))
    );
    let html = "";
    if (needsLogin) {
      html +=
        '<button type="button" class="btn-secondary btn-compact url-job-login" data-login-url="' +
        escapeAttr(needsLogin.url) +
        '">로그인하기</button>';
    }
    if (failed.length) {
      html +=
        '<button type="button" class="btn-secondary btn-compact url-job-retry" data-job-keys="' +
        escapeAttr(failed.map(jobKey).join("|")) +
        '">다시 시도</button>';
    } else if (runnable.length) {
      html +=
        '<button type="button" class="btn-primary btn-compact url-job-run" data-job-keys="' +
        escapeAttr(runnable.map(jobKey).join("|")) +
        '" title="이 URL만 지금 분석합니다">분석 실행</button>';
    } else if (jobs.every((j) => j.status === "done") && !jobs.some((j) => isJobInWaitQueue(jobKey(j)))) {
      html +=
        '<button type="button" class="btn-secondary btn-compact url-job-retry" data-job-keys="' +
        escapeAttr(jobs.map(jobKey).join("|")) +
        '">다시 분석</button>';
    }
    return html;
  }

  function updateUrlRowStatuses() {
    const container = $("url-rows");
    if (!container) return;
    container.querySelectorAll(".url-row").forEach((row) => {
      const entry = state.urls[Number(row.dataset.idx)];
      if (!entry) return;
      const jobs = urlRowJobs(entry);
      row.querySelectorAll(".viewport-toggle button").forEach((btn) => {
        const job = jobs.find((j) => j.viewport === btn.dataset.vp);
        btn.dataset.jobStatus = job ? effectiveJobStatus(job) : "";
      });
      const statusEl = row.querySelector(".url-row-status");
      if (statusEl) statusEl.innerHTML = urlRowStatusHtml(jobs);
      const actionsEl = row.querySelector(".url-row-actions");
      if (actionsEl) actionsEl.innerHTML = urlRowActionsHtml(jobs);
      row.classList.toggle("job-running", jobs.some((j) => j.status === "running"));
      row.classList.toggle(
        "job-failed",
        jobs.some((j) => j.status === "failed" || j.status === "login_required")
      );
      row.classList.toggle(
        "job-done",
        jobs.length > 0 && jobs.every((j) => j.status === "done")
      );
    });
  }

  function bindUrlRowActionDelegate(container) {
    if (!container || container.dataset.actionsBound === "1") return;
    container.dataset.actionsBound = "1";
    container.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const login = target.closest(".url-job-login");
      if (login) {
        const url = login.dataset.loginUrl || "";
        const host = hostKeyOf(url);
        if (host) autoOpenedLoginHosts.delete(host);
        void startInteractiveLoginUi(url);
        return;
      }
      const run = target.closest(".url-job-run");
      if (run) {
        void runUrlJobs((run.dataset.jobKeys || "").split("|").filter(Boolean), false);
        return;
      }
      const retry = target.closest(".url-job-retry");
      if (retry) {
        void runUrlJobs((retry.dataset.jobKeys || "").split("|").filter(Boolean), true);
      }
    });
  }

  /** 한 URL의 PC/MO 작업을 한 번에 실행·재실행한다. */
  async function runUrlJobs(keys, force) {
    const jobs = keys
      .map((key) => state.jobs.find((j) => jobKey(j) === key))
      .filter(
        (job) =>
          job &&
          !isJobInWaitQueue(jobKey(job)) &&
          !(analyzeRunning && activeAnalyzeKeys?.has(jobKey(job)))
      );
    if (!jobs.length) return;

    for (const job of jobs) {
      if (force) {
        job.forceReanalyze = true;
        job.status = "queued";
        job.fromCache = false;
        job.capturePhase = null;
        job.captureProgress = 0;
        job.candidateCount = null;
      }
      job.progress = 0;
      job.error = null;
      job.analyzePhase = null;
    }
    const runKeys = jobs.map(jobKey);
    scheduleSave();

    if (analyzeRunning) {
      enqueueAnalyzeKeys(runKeys, force ? runKeys : []);
      renderJobCards();
      updateGlobalAnalyzeBar();
      return;
    }

    renderJobCards();
    updateGlobalAnalyzeBar();
    await runBatchAnalyze(false, {
      skipInit: true,
      onlyKeys: runKeys,
      forceKeys: force ? runKeys : [],
    });
  }

  function upsertAuthSessionLocal(data) {
    if (!data?.id) return;
    const next = {
      id: data.id,
      site_url: data.site_url,
      host: data.host || "",
      label: data.label || data.host || data.site_url,
      cookie_count: data.cookie_count || 0,
      message: data.message || ((data.label || data.host || "사이트") + " 로그인 완료 · 세션 유지 중"),
      local_storage_count: data.local_storage_count || 0,
    };
    authSessions = authSessions.filter((s) => s.id !== next.id && s.host !== next.host);
    authSessions.push(next);
  }

  function renderAuthSessionList() {
    /* 로그인 사이드 패널 제거 — 세션은 authSessions에만 유지 */
  }

  function stopInteractiveLoginPoll() {
    if (interactiveLoginPollTimer) clearInterval(interactiveLoginPollTimer);
    interactiveLoginPollTimer = null;
  }

  function setInteractiveLoginUi(message, active) {
    const bar = $("interactive-login-bar");
    const completeBtn = $("interactive-login-complete");
    const cancelBtn = $("interactive-login-cancel");
    const status = $("interactive-login-status");
    if (status && message != null) status.textContent = message;
    if (completeBtn) completeBtn.hidden = !active;
    if (cancelBtn) cancelBtn.hidden = !active;
    if (bar) bar.hidden = !(active || !!message);
  }

  function hideInteractiveLoginBarSoon(ms) {
    setTimeout(() => {
      if (interactiveLoginId) return;
      const bar = $("interactive-login-bar");
      if (bar) bar.hidden = true;
    }, ms || 6000);
  }

  function isMemberAreaUrl(url) {
    try {
      return /(?:^|\/)(myshop|mypage|my-page|cart|order|wishlist|member)(?:\/|$)/i.test(
        new URL(url).pathname
      );
    } catch {
      return /myshop|mypage|cart|order/i.test(String(url || ""));
    }
  }

  function hostKeyOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return "";
    }
  }

  /** 로그인 필요 감지 시 Playwright 로그인 창을 자동으로 연다. */
  function maybeAutoOpenLoginBrowser() {
    if (interactiveLoginId || interactiveLoginOpening) return;
    const job =
      state.jobs.find((j) => j.status === "login_required") ||
      state.jobs.find(
        (j) =>
          j.status === "failed" &&
          (j.errorKind === "login_required" || isMemberAreaUrl(j.url))
      );
    if (!job?.url) return;
    const host = hostKeyOf(job.url);
    if (host && autoOpenedLoginHosts.has(host)) return;
    if (host) autoOpenedLoginHosts.add(host);
    void startInteractiveLoginUi(job.url);
  }

  /** User finished login — save cookies from the opened browser. */
  async function finishInteractiveLogin() {
    if (!interactiveLoginId) return;
    const id = interactiveLoginId;
    stopInteractiveLoginPoll();
    setInteractiveLoginUi("로그인 세션을 저장하는 중…", true);
    try {
      const res = await fetch(
        "/api/dev/interactive-login/" + encodeURIComponent(id) + "/complete",
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        const message =
          data.error === "login_state_not_found"
            ? "저장할 로그인 정보가 없습니다. 로그인 창에서 실제로 로그인한 뒤 다시 시도하세요."
            : data.error === "login_session_not_found"
              ? "로그인 창이 만료되었습니다. 「로그인하기」로 다시 여세요."
              : data.error || "로그인 세션 저장에 실패했습니다.";
        throw new Error(message);
      }
      upsertAuthSessionLocal(data);
      interactiveLoginId = null;

      const host = String(data.host || "").replace(/^www\./i, "").toLowerCase();
      if (host) autoOpenedLoginHosts.delete(host);

      const retryKeys = state.jobs
        .filter((j) => {
          if (j.status !== "failed" && j.status !== "login_required" && j.status !== "queued") {
            return false;
          }
          try {
            const h = new URL(j.url).hostname.replace(/^www\./i, "").toLowerCase();
            return !host || h === host;
          } catch {
            return true;
          }
        })
        .map((j) => jobKey(j));

      if (retryKeys.length && !analyzeRunning) {
        setInteractiveLoginUi(
          (data.label || data.host || "사이트") +
            " 로그인 완료 · 같은 사이트 " +
            retryKeys.length +
            "건을 다시 분석합니다…",
          false
        );
        hideInteractiveLoginBarSoon(4000);
        for (const j of state.jobs) {
          if (!retryKeys.includes(jobKey(j))) continue;
          j.forceReanalyze = true;
          j.status = "queued";
          j.error = null;
          j.progress = 0;
          j.fromCache = false;
        }
        renderJobCards();
        await runBatchAnalyze(false, {
          skipInit: true,
          onlyKeys: retryKeys,
          forceKeys: retryKeys,
        });
      } else if (retryKeys.length && analyzeRunning) {
        enqueueAnalyzeKeys(retryKeys, retryKeys);
        setInteractiveLoginUi(
          (data.label || data.host || "사이트") +
            " 로그인 완료 · " +
            retryKeys.length +
            "건을 대기풀에 넣었습니다.",
          false
        );
        hideInteractiveLoginBarSoon();
        renderJobCards();
      } else {
        setInteractiveLoginUi(
          (data.label || data.host || "사이트") +
            " 로그인 완료 · 이후 분석에 자동 적용됩니다.",
          false
        );
        hideInteractiveLoginBarSoon();
      }
    } catch (err) {
      interactiveLoginId = null;
      // allow auto/manual reopen
      autoOpenedLoginHosts.clear();
      setInteractiveLoginUi(
        (err.message || "로그인 세션 저장에 실패했습니다.") +
          " 카드의 「로그인하기」로 다시 열 수 있습니다.",
        false
      );
      hideInteractiveLoginBarSoon(8000);
    }
  }

  async function cancelInteractiveLoginUi() {
    if (!interactiveLoginId) return;
    const id = interactiveLoginId;
    stopInteractiveLoginPoll();
    interactiveLoginId = null;
    autoOpenedLoginHosts.clear();
    setInteractiveLoginUi("로그인 창을 닫았습니다.", false);
    hideInteractiveLoginBarSoon(3000);
    void fetch("/api/dev/interactive-login/" + encodeURIComponent(id), {
      method: "DELETE",
    }).catch(() => {});
  }

  /** Window closed → try to save session automatically. */
  async function pollInteractiveLogin() {
    if (!interactiveLoginId) return;
    try {
      const res = await fetch(
        "/api/dev/interactive-login/" +
          encodeURIComponent(interactiveLoginId) +
          "/status"
      );
      const data = await res.json();
      if (!res.ok || !data.ok) return;
      if (data.status === "closed") {
        stopInteractiveLoginPoll();
        setInteractiveLoginUi("로그인 창이 닫혔습니다. 세션을 저장하는 중…", true);
        await finishInteractiveLogin();
      }
    } catch {
      /* next poll retries */
    }
  }

  async function startInteractiveLoginUi(forcedUrl) {
    if (interactiveLoginOpening) return;
    if (interactiveLoginId) {
      const prevId = interactiveLoginId;
      stopInteractiveLoginPoll();
      interactiveLoginId = null;
      void fetch("/api/dev/interactive-login/" + encodeURIComponent(prevId), {
        method: "DELETE",
      }).catch(() => {});
    }

    let siteUrl = String(forcedUrl || "").trim();
    if (!siteUrl) {
      const loginJob = state.jobs.find((j) => j.status === "login_required");
      siteUrl = loginJob?.url || validUrlEntries()[0]?.url || "";
    }
    if (!siteUrl) {
      setInteractiveLoginUi("로그인할 사이트 주소가 없습니다.", false);
      hideInteractiveLoginBarSoon(4000);
      return;
    }

    interactiveLoginOpening = true;
    setInteractiveLoginUi("로그인 브라우저를 여는 중… (" + siteUrl + ")", true);

    try {
      const res = await fetch("/api/dev/interactive-login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site_url: siteUrl }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "로그인 창을 열지 못했습니다.");
      }
      interactiveLoginId = data.login_session_id;
      const host = hostKeyOf(siteUrl);
      if (host) autoOpenedLoginHosts.add(host);
      const entryHint = data.entry_url ? " · " + data.entry_url : "";
      setInteractiveLoginUi(
        "로그인 창이 열렸습니다" +
          entryHint +
          ". 사이트에서 로그인한 뒤 창을 닫거나 「로그인 완료」를 누르세요.",
        true
      );
      stopInteractiveLoginPoll();
      interactiveLoginPollTimer = setInterval(() => void pollInteractiveLogin(), 2500);
    } catch (err) {
      interactiveLoginId = null;
      setInteractiveLoginUi(err.message || "로그인 창을 열지 못했습니다.", false);
      hideInteractiveLoginBarSoon();
    } finally {
      interactiveLoginOpening = false;
    }
  }

  async function releaseAuthSessionUi(id) {
    try {
      await fetch("/api/dev/auth-cookies/" + encodeURIComponent(id), { method: "DELETE" });
    } catch {
      /* ignore */
    }
    authSessions = authSessions.filter((s) => s.id !== id);
  }

  async function hydrateAuthSessions() {
    try {
      const res = await fetch("/api/dev/auth-cookies");
      const data = await res.json();
      if (!res.ok || !data.ok || !Array.isArray(data.sessions)) return;
      authSessions = data.sessions.map((s) => ({
        id: s.id,
        site_url: s.site_url,
        host: s.host || "",
        label: s.label || s.host || s.site_url,
        cookie_count: s.cookie_count || 0,
        local_storage_count: s.local_storage_count || 0,
        message: s.message || "",
      }));
    } catch {
      /* ignore */
    }
  }

  function renderUrlSummary() {
    const el = $("url-summary");
    if (!el) return;
    const valid = validUrlEntries();
    let pc = 0;
    let mo = 0;
    for (const e of valid) {
      for (const vp of entryViewports(e)) {
        if (vp === "mo") mo++;
        else pc++;
      }
    }
    const invalid = state.urls.filter((e) => e.url.trim() && !isValidUrl(e.url)).length;
    let html =
      '<span class="chip">총 ' + valid.length + "개 URL</span>" +
      '<span class="chip">분석 ' + (pc + mo) + "건</span>" +
      '<span class="chip">PC ' + pc + "</span>" +
      '<span class="chip">MO ' + mo + "</span>";
    if (invalid) html += '<span class="chip warn">유효하지 않은 URL ' + invalid + "건</span>";
    el.innerHTML = html;
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  /* ── Step 2: Batch analyze ── */

  function syncUrlJobs() {
    const urlJobs = [];
    for (const e of validUrlEntries()) {
      for (const vp of entryViewports(e)) {
        const key = e.url.trim() + "::" + vp;
        const prev = state.jobs.find((j) => jobKey(j) === key);
        urlJobs.push({
          url: e.url.trim(),
          alias: e.alias || "",
          viewport: vp,
          status: prev?.status === "done" ? "done" : "queued",
          progress: prev?.status === "done" ? 100 : 0,
          candidateCount: prev?.candidateCount ?? null,
          error: null,
          job_id: prev?.job_id || null,
          capturePhase: prev?.capturePhase || "idle",
          captureProgress: prev?.captureProgress || 0,
          captureCurrent: prev?.captureCurrent || 0,
          captureTotal: prev?.captureTotal || 0,
        });
      }
    }
    state.jobs = urlJobs;
  }

  function initJobsFromUrls() {
    syncUrlJobs();
  }

  function updateAnalyzeGuideList() {
    const list = $("analyze-guide-list");
    if (!list) return;
    list.innerHTML =
      "<li>진행 상태는 각 URL 행에 바로 표시됩니다. 한 건만 돌리려면 그 행의 <strong>분석 실행</strong>을 누르세요.</li>" +
      "<li>완료된 행은 <strong>다시 분석</strong>을 눌렀을 때만 새로 실행합니다.</li>" +
      "<li><strong>태깅 → 이름붙이기 → 이미지 캡쳐 → 택소노미 생성</strong> 순으로 자동 진행됩니다.</li>" +
      "<li>로그인이 필요하면 해당 행에 <strong>로그인하기</strong> 버튼이 나타납니다. (/mypage 등)</li>";
  }

  function renderAnalyzeLead() {
    const lead = $("analyze-lead");
    if (!lead) return;

    const total = state.jobs.length;
    const done = state.jobs.filter((j) => j.status === "done").length;
    const running = state.jobs.filter((j) => j.status === "running").length;
    const queued = state.jobs.filter((j) => j.status === "queued").length;
    const failed = state.jobs.filter((j) => j.status === "failed").length;

    updateAnalyzeGuideList();

    if (!total) {
      lead.textContent =
        "URL을 확정하면 각 행에서 바로 분석하고 진행 상태를 확인할 수 있습니다.";
      return;
    }

    if (analyzeRunning || running > 0) {
      const prog = getAnalyzeProgress();
      const tagging = state.jobs.filter((j) => j.analyzePhase === "tagging").length;
      const naming = state.jobs.filter((j) => j.analyzePhase === "naming").length;
      const capturingNow = state.jobs.filter(
        (j) => j.analyzePhase === "capturing" || j.capturePhase === "running"
      ).length;
      const parts = [];
      if (tagging) parts.push("태깅중 " + tagging);
      if (naming) parts.push("이름붙이는중 " + naming);
      if (capturingNow) parts.push("이미지 캡쳐중 " + capturingNow);
      const phaseTxt = parts.length ? parts.join(" · ") : prog.listLabel;
      lead.textContent =
        prog.mode === "batch"
          ? "선택 항목 진행 중 (" + phaseTxt + "). 끝나면 택소노미 초안을 자동으로 만듭니다."
          : "목록 순서대로 진행 중 (" + phaseTxt + "). 끝나면 택소노미 초안을 자동으로 만듭니다.";
      return;
    }

    if (failed > 0 && done === 0) {
      lead.textContent =
        "분석에 실패한 페이지가 있습니다. 「실패 항목만 다시 시도」로 재시도하세요.";
      return;
    }

    if (done > 0 && done < total) {
      lead.textContent =
        "총 " +
        total +
        "건 중 " +
        done +
        "건 완료. 남은 분석이 끝나면 택소노미 초안으로 자동 이동합니다.";
      return;
    }

    if (done === total) {
      lead.textContent =
        "전체 " + total + "건 분석이 끝났습니다. 택소노미 초안을 만드는 중입니다.";
      return;
    }

    if (queued === total) {
      lead.textContent =
        "총 " +
        total +
        "건이 대기 중입니다. 전체를 「분석 시작」하거나, 각 카드의 「분석 실행」으로 한 건씩 돌릴 수 있습니다.";
      return;
    }

    lead.textContent = "분석 상태를 확인하고 필요하면 다시 시도하세요.";
  }

  /** Batch item.status → UI phase label key */
  function phaseFromBatchStatus(status, capturePhase) {
    if (capturePhase === "running") return "capturing";
    if (status === "collecting" || status === "running") return "tagging";
    if (status === "naming") return "naming";
    if (status === "done" && capturePhase === "running") return "capturing";
    return null;
  }

  function phaseLabel(phase) {
    if (phase === "tagging") return "태깅중…";
    if (phase === "naming") return "이름붙이는중…";
    if (phase === "capturing") return "이미지 캡쳐중…";
    return "";
  }

  function syncJobFromBatchItem(job, item) {
    if (item.job_id) job.job_id = item.job_id;
    if (item.alias?.trim() && !job.alias?.trim()) {
      const autoAlias = item.alias.trim();
      job.alias = autoAlias;
      for (const entry of state.urls) {
        if ((entry.url || "").trim() === (job.url || "").trim() && !entry.alias?.trim()) {
          entry.alias = autoAlias;
        }
      }
      renderUrlRows();
    }
    const phase = phaseFromBatchStatus(item.status, item.capture_phase);
    if (phase) job.analyzePhase = phase;
    if (item.capture_phase === "running") {
      job.capturePhase = "running";
      job.analyzePhase = "capturing";
      job.captureProgress = item.capture_pct ?? 0;
      job.captureCurrent = item.capture_current ?? 0;
      job.captureTotal = item.capture_total ?? 0;
    } else if (item.status === "done") {
      job.capturePhase = item.capture_phase === "done" ? "done" : "idle";
      if (job.capturePhase === "done") {
        job.captureProgress = 100;
        job.analyzePhase = null;
      }
    }
  }

  function updatePhase2Banner() {
    const banner = $("phase2-capture-banner");
    const text = $("phase2-capture-text");
    const fill = $("phase2-capture-fill");
    if (!banner || !text || !fill) return;

    const running = state.jobs.filter((j) => j.capturePhase === "running");
    if (!running.length) {
      banner.hidden = true;
      return;
    }

    banner.hidden = false;
    let totalCur = 0;
    let totalMax = 0;
    for (const j of running) {
      totalCur += j.captureCurrent || 0;
      totalMax += j.captureTotal || 0;
    }
    const pct = totalMax > 0 ? Math.round((totalCur / totalMax) * 100) : 0;
    text.textContent =
      "이미지 캡쳐중… " +
      totalCur +
      "/" +
      totalMax +
      " (" +
      running.length +
      "페이지)";
    fill.style.width = pct + "%";
  }

  function stopCapturePhasePoll() {
    if (capturePhasePollTimer) {
      clearInterval(capturePhasePollTimer);
      capturePhasePollTimer = null;
    }
    updateGlobalAnalyzeBar();
  }

  /**
   * Progress for the current run (reanalyze / 미완료 시작) vs overall list.
   * While a batch is running, prefer batchFinished/batchTotal so "다시 분석 1건"
   * shows 0/1 → 1/1 instead of a stale overall 1/2.
   */
  function getAnalyzeProgress() {
    const total = state.jobs.length;
    const done = state.jobs.filter((j) => j.status === "done").length;
    if (analyzeRunning && activeAnalyzeKeys && activeAnalyzeKeys.size > 0) {
      const batchJobs = state.jobs.filter((j) => activeAnalyzeKeys.has(jobKey(j)));
      const batchTotal = Math.max(batchJobs.length, activeAnalyzeKeys.size);
      const batchFinished = batchJobs.filter(
        (j) =>
          j.status === "done" ||
          j.status === "failed" ||
          j.status === "login_required"
      ).length;
      return {
        mode: "batch",
        done,
        total,
        batchFinished,
        batchTotal,
        label: batchFinished + "/" + batchTotal,
        listLabel: batchFinished + " / " + batchTotal + " 진행",
        barLabel: "분석 진행 중 · " + batchFinished + "/" + batchTotal,
      };
    }
    return {
      mode: "overall",
      done,
      total,
      batchFinished: done,
      batchTotal: total,
      label: done + "/" + total,
      listLabel: done + " / " + total + " 완료",
      barLabel: "분석 진행 중 · " + done + "/" + total + " 완료",
    };
  }

  /**
   * 전역 진행 표시줄: 어느 단계에 있든 백엔드에서 분석/캡처가 도는 동안 항상 보이게
   * 해서 "화면엔 안 보이는데 뒤에서 도는" 상황을 없앤다.
   */
  function updateGlobalAnalyzeBar() {
    const bar = $("global-analyze-bar");
    if (!bar) return;
    const running = analyzeRunning || !!capturePhasePollTimer;
    bar.hidden = !running;
    if (!running) return;
    const prog = getAnalyzeProgress();
    const capturing = state.jobs.filter(
      (j) => j.status === "done" && j.capturePhase === "running"
    ).length;
    const tagging = state.jobs.filter((j) => j.analyzePhase === "tagging").length;
    const naming = state.jobs.filter((j) => j.analyzePhase === "naming").length;
    const parts = [];
    if (tagging) parts.push("태깅중 " + tagging);
    if (naming) parts.push("이름붙이는중 " + naming);
    if (capturing > 0) parts.push("이미지 캡쳐중 " + capturing);
    let txt = parts.length
      ? parts.join(" · ") + " · " + prog.batchFinished + "/" + prog.batchTotal
      : prog.barLabel;
    if (prog.mode === "batch" && prog.done > 0 && prog.done !== prog.batchFinished) {
      txt += " · 기존 완료 " + prog.done;
    }
    const textEl = $("global-analyze-text");
    if (textEl) textEl.textContent = txt;
  }

  function isJobInWaitQueue(key) {
    return analyzeWaitQueue.some(
      (item) => item.onlyKeys?.includes(key) || item.forceKeys?.includes(key)
    );
  }

  function enqueueAnalyzeKeys(onlyKeys, forceKeys) {
    const only = [...new Set(onlyKeys || [])];
    const force = [...new Set(forceKeys || only)];
    if (!only.length) return;
    // 이미 대기 중인 키는 합친다
    const existing = analyzeWaitQueue[0];
    if (existing) {
      existing.onlyKeys = [...new Set([...(existing.onlyKeys || []), ...only])];
      existing.forceKeys = [...new Set([...(existing.forceKeys || []), ...force])];
    } else {
      analyzeWaitQueue.push({ onlyKeys: only, forceKeys: force });
    }
  }

  async function drainAnalyzeWaitQueue() {
    if (analyzeRunning || analyzeAbort) return;
    while (analyzeWaitQueue.length && !analyzeAbort) {
      const next = analyzeWaitQueue.shift();
      if (!next?.onlyKeys?.length) continue;
      await runBatchAnalyze(false, {
        skipInit: true,
        onlyKeys: next.onlyKeys,
        forceKeys: next.forceKeys || next.onlyKeys,
        deferAutoConfirm: true,
      });
    }
  }

  /** 프론트 폴링 + 백엔드 배치를 모두 중단한다. UI는 즉시 갱신하고 요청은 대기하지 않는다. */
  async function requestStopAnalyze() {
    analyzeAbort = true;
    analyzeWaitQueue = [];
    stopCapturePhasePoll();
    const id = activeBatchId;

    // UI를 먼저 갱신해 즉각 반응하게 하고, 중단 요청은 백그라운드로 보낸다.
    for (const j of state.jobs) {
      if (j.status === "running" || j.status === "queued") {
        j.status = "failed";
        j.error = "중단됨";
        j.progress = 0;
        j.analyzePhase = null;
      }
    }
    analyzeRunning = false;
    activeAnalyzeKeys = null;
    activeBatchId = null;
    const startBtn = $("start-analyze-btn");
    if (startBtn) startBtn.disabled = false;
    const stopBtn = $("stop-analyze-btn");
    if (stopBtn) stopBtn.hidden = true;
    renderJobCards();
    updateGlobalAnalyzeBar();
    updateNextButton();
    scheduleSave();

    try {
      // Stop only this batch. Do NOT call /pipeline/reset — that force-kills every
      // other parallel batch and marks them "중단됨".
      if (id) {
        await fetch("/api/dev/batch/" + encodeURIComponent(id) + "/stop", { method: "POST" });
      }
    } catch {
      /* best-effort */
    }
  }

  function startCapturePhasePoll(batchId) {
    if (!batchId || capturePhasePollTimer) return;
    const ws = window.Workspace;
    capturePhasePollTimer = setInterval(() => {
      void (async () => {
        try {
          const { res, data: batch } = await fetchJsonWithRetry(
            "/api/dev/batch/" + encodeURIComponent(batchId) + "/progress",
            {},
            1
          );
          if (!res.ok || !batch.ok) return;

          const urlToJob = new Map(state.jobs.map((j) => [jobKey(j), j]));
          for (const item of batch.items || []) {
            const itemVp = item.viewport === "mo" ? "mo" : "pc";
            const job = urlToJob.get(item.url + "::" + itemVp);
            if (!job) continue;
            syncJobFromBatchItem(job, item);
          }
          renderJobCards();
          updatePhase2Banner();
          updateGlobalAnalyzeBar();
          if (!batch.capture_pending) {
            stopCapturePhasePoll();
            if (state.sessionId && ws) {
              await ws.loadSession(state.sessionId);
              ws.renderSessionTree();
            }
          }
        } catch {
          /* keep polling */
        }
      })();
    }, 1500);
  }

  function renderJobCards() {
    const container = $("job-cards");
    const panel = document.getElementById("panel-2");
    const scrollTop = panel?.scrollTop ?? 0;
    if (!container) return;
    if (!state.jobs.length) {
      container.innerHTML =
        '<p class="caption analyze-page-empty">위에서 확정한 URL이 여기에 표시됩니다.</p>';
      updateUrlRowStatuses();
      renderAnalyzeLead();
      return;
    }
    const statusEl = $("analyze-batch-status");
    if (statusEl) statusEl.textContent = getAnalyzeProgress().listLabel;

    const sortedJobs = state.jobs
      .map((job, originalIndex) => ({ job, originalIndex }))
      .sort((a, b) => {
        const aDone = a.job.status === "done" ? 1 : 0;
        const bDone = b.job.status === "done" ? 1 : 0;
        return aDone - bDone || a.originalIndex - b.originalIndex;
      });
    const firstDoneIndex = sortedJobs.findIndex(({ job }) => job.status === "done");

    container.innerHTML = sortedJobs
      .map((job, index) => {
        job = job.job;
        const displayUrl = (() => {
          try {
            return new URL(job.url).hostname + new URL(job.url).pathname;
          } catch {
            return job.url;
          }
        })();
        let meta = "";
        const capturing = job.status === "done" && job.capturePhase === "running";
        const phase = capturing ? "capturing" : job.analyzePhase;
        if (capturing || phase === "capturing") {
          meta =
            "이미지 캡쳐중… " +
            (job.captureCurrent ?? 0) +
            "/" +
            (job.captureTotal ?? "?") +
            (job.candidateCount != null ? " · 후보 " + job.candidateCount + "개" : "");
        } else if (job.status === "done") {
          meta = job.fromCache
            ? "DB 불러옴 · 후보 " + (job.candidateCount ?? "?") + "개"
            : "완료 · 후보 " + (job.candidateCount ?? "?") + "개";
        } else if (job.status === "running") {
          meta = phaseLabel(phase) || "태깅중…";
        } else if (job.status === "queued") {
          meta = isJobInWaitQueue(jobKey(job))
            ? "대기풀 · 현재 작업이 끝나면 이어서 실행됩니다"
            : "대기 중";
        } else if (job.status === "login_required") {
          meta = friendlyAnalyzeError(job.error || "로그인 필요", job);
        } else if (job.status === "failed") {
          meta = "실패 · " + friendlyAnalyzeError(job.error || "오류", job);
        }
        let progressBar = "";
        if (job.status === "running") {
          progressBar =
            '<div class="job-card-progress"><div class="job-card-progress-fill" style="width:' +
            job.progress +
            '%"></div></div>';
        } else if (capturing) {
          progressBar =
            '<div class="job-card-progress"><div class="job-card-progress-fill phase2" style="width:' +
            (job.captureProgress ?? 0) +
            '%"></div></div>';
        }
        const key = jobKey(job);
        const inActiveBatch = !!(analyzeRunning && activeAnalyzeKeys?.has(key));
        const inWaitPool = isJobInWaitQueue(key);
        /** 대기 중이고, 지금 돌고 있는 배치에 아직 안 묶였을 때만 개별 실행 가능 */
        const canRunQueued =
          job.status === "queued" && !inActiveBatch && !inWaitPool;
        const cardCls =
          "job-card " +
          job.status +
          (capturing ? " capture-phase" : "") +
          (inWaitPool ? " wait-pool" : "");
        const dotCls = "job-status-dot " + (capturing ? "capturing" : job.status);
        const hideRemove =
          job.status === "running" || (inActiveBatch && job.status === "queued");
        return (
          (index === firstDoneIndex
            ? '<div class="job-group-divider"><span>완료된 분석</span><small>다시 실행하려면 각 항목의 「다시 분석」을 누르세요.</small></div>'
            : "") +
          '<div class="' + cardCls + '">' +
          '<div class="job-card-head">' +
          '<span class="job-card-index">' + (index + 1) + "</span>" +
          '<span class="' + dotCls + '"></span>' +
          '<span class="job-card-url">' + escapeHtml(displayUrl) + "</span>" +
          (job.alias ? '<span class="job-card-alias">' + escapeHtml(job.alias) + "</span>" : "") +
          '<span class="job-card-vp">' + (job.viewport === "mo" ? "MO" : "PC") + "</span>" +
          (job.status === "login_required" ||
          (job.status === "failed" &&
            (job.errorKind === "login_required" || isMemberAreaUrl(job.url)))
            ? '<button type="button" class="btn-secondary job-login" data-login-url="' +
              escapeAttr(job.url) +
              '">로그인하기</button>'
            : "") +
          (canRunQueued
            ? '<button type="button" class="btn-primary job-run-one" data-job-key="' +
              escapeAttr(key) +
              '" title="이 URL만 지금 분석합니다">분석 실행</button>'
            : "") +
          (job.status === "queued" && inWaitPool
            ? '<button type="button" class="btn-secondary" disabled title="대기풀에 들어가 있습니다">대기풀</button>'
            : "") +
          (job.status === "queued" && inActiveBatch
            ? '<span class="job-card-badge" title="현재 배치 대기열에 포함됨">배치 대기</span>'
            : "") +
          (job.status === "failed"
            ? '<button type="button" class="btn-secondary job-retry" data-job-key="' +
              escapeAttr(key) +
              '"' +
              (inWaitPool
                ? " disabled title=\"이미 대기풀에 들어가 있습니다\""
                : ' title="지금 분석 중이면 대기풀에 넣습니다"') +
              ">" +
              (inWaitPool ? "대기풀" : "다시 시도") +
              "</button>"
            : "") +
          (job.status === "done"
            ? '<button type="button" class="btn-secondary job-reanalyze" data-job-key="' +
              escapeAttr(key) +
              '"' +
              (inWaitPool
                ? " disabled title=\"이미 대기풀에 들어가 있습니다\""
                : ' title="지금 분석 중이면 대기풀에 넣습니다"') +
              ">" +
              (inWaitPool ? "대기풀" : "다시 분석") +
              "</button>"
            : "") +
          (hideRemove
            ? ""
            : '<button type="button" class="btn-secondary job-remove" data-job-key="' +
              escapeAttr(key) +
              '" title="목록에서 삭제">삭제</button>') +
          "</div>" +
          '<div class="job-card-meta">' + escapeHtml(meta) + "</div>" +
          progressBar +
          "</div>"
        );
      })
      .join("");

    container.querySelectorAll(".job-run-one").forEach((btn) => {
      btn.addEventListener("click", () => void runSingleQueuedJob(btn.dataset.jobKey));
    });
    container.querySelectorAll(".job-retry").forEach((btn) => {
      btn.addEventListener("click", () => void retrySingleJob(btn.dataset.jobKey));
    });
    container.querySelectorAll(".job-login").forEach((btn) => {
      btn.addEventListener("click", () => {
        const url = btn.dataset.loginUrl || "";
        const host = hostKeyOf(url);
        if (host) autoOpenedLoginHosts.delete(host); // allow manual re-open
        void startInteractiveLoginUi(url);
      });
    });
    maybeAutoOpenLoginBrowser();
    container.querySelectorAll(".job-reanalyze").forEach((btn) => {
      btn.addEventListener("click", () => void retrySingleJob(btn.dataset.jobKey));
    });
    container.querySelectorAll(".job-remove").forEach((btn) => {
      btn.addEventListener("click", () => removeJobCard(btn.dataset.jobKey));
    });

    if (panel) panel.scrollTop = scrollTop;
    updateUrlRowStatuses();
    const pendingCount = state.jobs.filter((job) => job.status === "queued").length;
    const startButton = $("start-analyze-btn");
    if (startButton && !analyzeRunning) {
      startButton.disabled = pendingCount === 0;
      startButton.textContent =
        pendingCount > 0 ? `미완료 ${pendingCount}건 분석 시작` : "분석할 새 항목 없음";
    }
    renderAnalyzeLead();
  }

  function removeJobCard(key) {
    if (!key) return;
    const job = state.jobs.find((j) => jobKey(j) === key);
    if (!job) return;
    // 지금 돌고 있는 항목만 삭제 금지 — 실패/대기 항목은 분석 중에도 제거 가능
    if (analyzeRunning && activeAnalyzeKeys?.has(key) && (job.status === "running" || job.status === "queued")) {
      return;
    }
    analyzeWaitQueue = analyzeWaitQueue
      .map((item) => ({
        onlyKeys: (item.onlyKeys || []).filter((k) => k !== key),
        forceKeys: (item.forceKeys || []).filter((k) => k !== key),
      }))
      .filter((item) => item.onlyKeys.length);
    state.jobs = state.jobs.filter((j) => jobKey(j) !== key);

    const urlNorm = (job.url || "").trim();
    state.urls = state.urls
      .map((e) => {
        if ((e.url || "").trim() !== urlNorm) return e;
        const vps = entryViewports(e).filter((v) => v !== job.viewport);
        if (!vps.length) return null;
        return { ...e, viewports: vps };
      })
      .filter(Boolean);
    renderUrlRows();

    scheduleSave();
    renderJobCards();
    updateNextButton();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  async function fetchJsonWithRetry(url, opts = {}, retries = 4) {
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(url, {
          credentials: "same-origin",
          ...opts,
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 && data?.error === "auth_required") {
          location.replace("/login.html");
          throw new Error("로그인이 필요합니다");
        }
        return { res, data };
      } catch (err) {
        lastErr = err;
        if (attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  }

  let authState = {
    checked: false,
    authenticated: false,
    required: false,
    user: null,
  };

  async function refreshAuthUi() {
    const pill = $("auth-user-pill");
    const logoutBtn = $("auth-logout-btn");
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      const data = await res.json();
      authState.checked = true;
      authState.authenticated = !!data.authenticated;
      authState.user = data.user || null;

      if (!data.authenticated) {
        location.replace("/login.html");
        return;
      }

      if (pill) {
        pill.hidden = false;
        pill.textContent =
          (authState.user &&
            (authState.user.display_name || authState.user.email)) ||
          "로그인됨";
      }
      // Always show logout on the wizard once auth check passed
      if (logoutBtn) {
        logoutBtn.hidden = false;
        logoutBtn.style.display = "inline-flex";
      }
    } catch (err) {
      console.warn("auth/me failed", err);
      if (pill) pill.textContent = "로그인 오류";
      if (logoutBtn) {
        logoutBtn.hidden = false;
        logoutBtn.style.display = "inline-flex";
      }
    }
  }

  async function autoConfirmAndAdvance() {
    const ws = window.Workspace;
    if (!ws || !state.sessionId || !state.jobs.some((j) => j.status === "done")) return false;
    const { total } = ws.countSelectionTotals();
    if (!total) return false;
    await ws.confirmSelection({ auto: true, selectAll: true });
    return !!ws.getTaxonomyData()?.tabs?.length;
  }

  async function runBatchAnalyze(onlyFailed = false, opts = {}) {
    const ws = window.Workspace;
    if (!ws || analyzeRunning) return;

    const forceKeys = new Set(opts.forceKeys || []);
    for (const j of state.jobs) {
      if (j.forceReanalyze) forceKeys.add(jobKey(j));
    }

    if (!onlyFailed && !opts.skipInit) initJobsFromUrls();

    // Re-apply force flags after init may have rebuilt URL jobs
    for (const j of state.jobs) {
      if (forceKeys.has(jobKey(j))) {
        j.forceReanalyze = true;
        if (!onlyFailed) j.status = "queued";
      }
    }

    let queue = state.jobs.filter((j) => {
      if (opts.onlyKeys?.length) return opts.onlyKeys.includes(jobKey(j));
      return onlyFailed ? j.status === "failed" : j.status === "queued";
    });

    if (!queue.length) return;

    clampStepToAccessible();
    renderJobCards();

    analyzeRunning = true;
    analyzeAbort = false;
    activeAnalyzeKeys = new Set(queue.map((j) => jobKey(j)));
    $("start-analyze-btn").disabled = true;
    $("stop-analyze-btn").hidden = false;
    updateNextButton();
    updateGlobalAnalyzeBar();

    for (const j of queue) {
      j.status = "queued";
      j.progress = 0;
      j.error = null;
      j.capturePhase = null;
      j.captureProgress = 0;
    }
    renderJobCards();
    updateGlobalAnalyzeBar();

    try {
      const urlToJob = new Map(queue.map((j) => [jobKey(j), j]));

      const batchBody = {
        project_id: state.projectId,
        session_id: state.sessionId,
        urls: queue.map((j) => ({
          url: j.url,
          alias: j.alias,
          viewport: j.viewport === "mo" ? "mo" : "pc",
          force: onlyFailed || !!j.forceReanalyze,
        })),
        force: onlyFailed,
        force_urls: onlyFailed
          ? queue.map((j) => j.url)
          : queue.filter((j) => j.forceReanalyze).map((j) => j.url),
      };

      let { res: startRes, data: startData } = await fetchJsonWithRetry(
        "/api/dev/batch-analyze",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batchBody),
        },
        4
      );

      // Never auto-call /pipeline/reset on 409 — that cancelled parallel batches
      // ("실패 · 중단됨"). Concurrent batches are allowed; 409 means a different
      // single-job lock is held and the user should retry shortly.
      if (!startRes.ok || !startData.ok) {
        const err =
          startData.error === "pipeline_already_running"
            ? "다른 단일 분석이 끝나길 기다린 뒤 다시 시도하세요."
            : startData.error || "배치 분석 시작 실패";
        throw new Error(err);
      }

      if (startData.session_id) {
        state.sessionId = startData.session_id;
        ws.setSessionId(state.sessionId);
      }

      // Apply DB cache hits immediately (may be the entire batch).
      for (const item of startData.items || []) {
        const itemVp = item.viewport === "mo" ? "mo" : "pc";
        const job = urlToJob.get(item.url + "::" + itemVp);
        if (!job) continue;
        syncJobFromBatchItem(job, item);
        if (item.from_cache || item.status === "done") {
          job.status = "done";
          job.progress = 100;
          job.fromCache = !!item.from_cache;
          if (item.candidate_count != null) job.candidateCount = item.candidate_count;
          job.forceReanalyze = false;
        }
      }
      renderJobCards();

      const batchId = startData.batch_id;
      activeBatchId = batchId;

      if (!batchId) {
        if (state.sessionId) {
          try {
            await ws.loadSession(state.sessionId);
          } catch (loadErr) {
            console.warn("loadSession(cache) failed:", loadErr);
          }
        }
      } else {
        let finished = false;
        let pollFailures = 0;
        let softWarnShown = false;

        while (!finished && !analyzeAbort) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const { res: progRes, data: batch } = await fetchJsonWithRetry(
              "/api/dev/batch/" + encodeURIComponent(batchId) + "/progress",
              {},
              4
            );
            pollFailures = 0;
            softWarnShown = false;
            if (!progRes.ok || !batch.ok) continue;

            let newlyDone = false;
            for (const item of batch.items || []) {
              const itemVp = item.viewport === "mo" ? "mo" : "pc";
              const job = urlToJob.get(item.url + "::" + itemVp);
              if (!job) continue;
              if (item.job_id) job.job_id = item.job_id;
              if (item.status === "queued") {
                job.status = "queued";
                job.progress = 0;
                job.analyzePhase = null;
              } else if (
                item.status === "running" ||
                item.status === "collecting" ||
                item.status === "naming"
              ) {
                job.status = "running";
                job.analyzePhase =
                  item.status === "naming" ? "naming" : "tagging";
                job.progress = Math.max(
                  item.status === "naming" ? 40 : 5,
                  item.progress_pct ?? (item.status === "naming" ? 40 : 10)
                );
                syncJobFromBatchItem(job, item);
              } else if (item.status === "done") {
                if (job.status !== "done") newlyDone = true;
                job.status = "done";
                job.progress = 100;
                job.candidateCount = item.candidate_count;
                syncJobFromBatchItem(job, item);
                if (item.capture_phase === "running") {
                  job.analyzePhase = "capturing";
                } else if (item.capture_phase === "done") {
                  job.analyzePhase = null;
                }
              } else if (item.status === "login_required") {
                job.status = "login_required";
                job.progress = 0;
                job.analyzePhase = null;
                job.error = item.error || "로그인 필요";
                job.errorKind = item.error_kind || "login_required";
                job.errorCurrentUrl = item.error_current_url || null;
              } else if (item.status === "error") {
                job.status = "failed";
                job.progress = 0;
                job.analyzePhase = null;
                job.error = item.error || "오류";
                job.errorKind = item.error_kind || null;
                job.errorCurrentUrl = item.error_current_url || null;
              }
            }
            renderJobCards();
            updatePhase2Banner();
            updateGlobalAnalyzeBar();
            scheduleSave();

            // 한 페이지가 끝나는 즉시 세션을 갱신해 태그 선택 트리에 라이브로 추가.
            // 실패해도 폴링은 계속한다 (이전엔 연쇄 Failed to fetch로 나머지를 실패 처리함).
            if (newlyDone && state.sessionId && ws) {
              void ws.loadSession(state.sessionId).catch((reloadErr) => {
                console.warn("loadSession(live) failed:", reloadErr);
              });
            }

            // Phase 1(배치 naming)이 끝나면 폴링 종료 — 캡처(Phase 2)는 별도 폴러가 담당.
            // capture_pending을 기다리면 연결 끊김 시 남은 URL까지 전부 실패로 찍히는 문제가 있었다.
            if (batch.status === "done") finished = true;
            notifyWizardCompletionIfChanged();
          } catch (pollErr) {
            pollFailures += 1;
            if (!softWarnShown && pollFailures >= 3) {
              softWarnShown = true;
              const detail = $("progress-detail");
              if (detail) {
                detail.textContent =
                  "진행 상태 확인이 잠시 불안정합니다. 서버 분석을 계속 기다리며 재연결합니다…";
              }
              console.warn("batch progress poll soft-fail:", pollErr);
            }
            // 절대 남은 항목을 일괄 실패 처리하지 않는다. 충분히 길면 루프만 탈출하고 캡처 폴러로 넘긴다.
            if (pollFailures >= 60) {
              console.error("batch progress poll gave up after soft retries:", pollErr);
              finished = true;
            }
          }
        }

        if (!analyzeAbort && activeBatchId) {
          startCapturePhasePoll(activeBatchId);
        }

        if (finished && state.sessionId) {
          try {
            await ws.loadSession(state.sessionId);
          } catch (loadErr) {
            console.warn("loadSession failed:", loadErr);
          }
        }
      } // end batchId poll
    } catch (err) {
      // 시작(POST) 실패만 여기로 온다. 폴링 중 일시 오류는 위에서 삼킨다.
      const msg = err?.message || "분석 실패";
      const friendly =
        msg === "Failed to fetch"
          ? "백엔드 서버에 연결할 수 없습니다. npm run dev:backend 가 실행 중인지 확인하고 다시 시도하세요."
          : msg;
      for (const j of queue) {
        if (j.status === "running" || j.status === "queued") {
          j.status = "failed";
          j.error = friendly;
        }
      }
      renderJobCards();
    }

    analyzeRunning = false;
    activeAnalyzeKeys = null;
    activeBatchId = null;
    $("stop-analyze-btn").hidden = true;
    $("retry-failed-btn").hidden = !state.jobs.some((j) => j.status === "failed");
    renderJobCards();
    updateGlobalAnalyzeBar();

    if (state.jobs.some((j) => j.status === "done")) {
      ws.renderSessionTree();
    }
    notifyWizardCompletionIfChanged();
    scheduleSave();

    // 대기풀에 쌓인 「다시 시도/다시 분석」을 이어서 실행
    if (!analyzeAbort) {
      await drainAnalyzeWaitQueue();
      if (!opts.deferAutoConfirm && !analyzeWaitQueue.length) {
        await autoConfirmAndAdvance();
      }
    }
  }

  /** Firecrawl / 로그인 / 네트워크 오류를 카드에 읽기 쉬운 한국어로 표시 */
  function friendlyAnalyzeError(raw, job) {
    const kind = job?.errorKind;
    const m = String(raw || "");
    const lower = m.toLowerCase();

    if (kind === "login_required" || lower.startsWith("login_required|") || lower.includes("로그인 필요")) {
      if (m.includes("요청") && m.includes("실제")) return m;
      if (job?.errorCurrentUrl) {
        return (
          "로그인 필요 · 주소가 달라져 중단됨 (실제 " +
          job.errorCurrentUrl.replace(/^https?:\/\//i, "") +
          ")"
        );
      }
      return m.includes("로그인") ? m : "로그인 필요 · 회원 페이지 접근을 위해 로그인이 필요합니다";
    }
    // /myshop 등 + REPL 끊김 = 로그인 리다이렉트 부작용이지 Firecrawl 한도 문제가 아님
    if (
      isMemberAreaUrl(job?.url) &&
      (kind === "session_dead" ||
        lower.includes("deno repl") ||
        lower.includes("repl exited") ||
        lower.includes("repl not ready") ||
        lower.includes("waitforpageready"))
    ) {
      return (
        m.includes("로그인")
          ? m
          : "로그인 필요 · 회원 페이지(/myshop 등)입니다. 로그인 창에서 로그인한 뒤 다시 시도하세요"
      );
    }
    if (kind === "session_dead") {
      return m || "브라우저 세션이 끊김 (Firecrawl 한도/불안정) — 「다시 시도」하세요";
    }
    if (kind === "timeout") return m || "시간 초과 — 「다시 시도」하세요";

    if (lower.startsWith("login_required|")) {
      const parts = m.split("|");
      const expected = (parts[1] || "").replace(/^https?:\/\//i, "");
      const actual = (parts[2] || "").replace(/^https?:\/\//i, "");
      return "로그인 필요 · 주소가 달라져 중단됨 (요청 " + expected + " → 실제 " + actual + ")";
    }
    if (lower.includes("deno repl") || lower.includes("repl exited") || lower.includes("repl not ready")) {
      return "브라우저 세션이 끊김 (Firecrawl 한도/불안정) — 「다시 시도」하세요";
    }
    if (lower.includes("waitforpageready")) {
      return "페이지 준비 실패 (세션 불안정 가능) — 「다시 시도」하세요";
    }
    if (lower.includes("concurrencylimited") || lower.includes("concurrent")) {
      return "동시 브라우저 한도 초과 — 잠시 후 「다시 시도」하세요";
    }
    if (m === "Failed to fetch") return "백엔드 연결 실패";
    return m;
  }

  /**
   * 대기(queued) 항목 1건만 지금 분석.
   * 다른 배치가 돌고 있으면 대기풀에 넣고, 끝나면 이어서 실행.
   */
  async function runSingleQueuedJob(key) {
    const job = state.jobs.find((j) => jobKey(j) === key);
    if (!job || job.status !== "queued") return;
    if (isJobInWaitQueue(key)) return;
    if (analyzeRunning && activeAnalyzeKeys?.has(key)) return;

    job.progress = 0;
    job.error = null;
    job.analyzePhase = null;
    scheduleSave();

    if (analyzeRunning) {
      enqueueAnalyzeKeys([key], job.forceReanalyze ? [key] : []);
      renderJobCards();
      updateGlobalAnalyzeBar();
      updateAnalyzeLead();
      return;
    }

    renderJobCards();
    updateGlobalAnalyzeBar();
    await runBatchAnalyze(false, {
      skipInit: true,
      onlyKeys: [key],
      forceKeys: job.forceReanalyze ? [key] : [],
    });
  }

  async function retrySingleJob(key) {
    const job = state.jobs.find((j) => jobKey(j) === key);
    if (!job) return;
    if (isJobInWaitQueue(key)) return;
    if (analyzeRunning && activeAnalyzeKeys?.has(key)) return;

    job.forceReanalyze = true;
    job.status = "queued";
    job.progress = 0;
    job.error = null;
    job.fromCache = false;
    job.capturePhase = null;
    job.captureProgress = 0;
    job.candidateCount = null;
    job.analyzePhase = null;
    scheduleSave();

    if (analyzeRunning) {
      enqueueAnalyzeKeys([key], [key]);
      renderJobCards();
      updateGlobalAnalyzeBar();
      return;
    }

    renderJobCards();
    updateGlobalAnalyzeBar();
    await runBatchAnalyze(false, { skipInit: true, onlyKeys: [key], forceKeys: [key] });
  }

  /* ── Step 5: Export ── */

  function exportPreviewCell(value) {
    const t = value == null ? "" : String(value).trim();
    return escapeHtml(t || "-");
  }

  function collectExportPreviewRows(tax) {
    if (!tax?.tabs) return [];
    const rows = [];
    for (const tab of tax.tabs) {
      if (tab.kind !== "page_category") continue;
      for (const row of tab.event_rows || []) rows.push(row);
    }
    return rows;
  }

  function renderExportPanel() {
    const ws = window.Workspace;
    const tax = ws?.getTaxonomyData();
    const pages = ws?.getSessionPages() || [];
    const stats = $("export-stats");
    if (!stats) return;

    const previewRows = collectExportPreviewRows(tax);
    let eventKinds = tax?.summary?.event_count;
    if (eventKinds == null) eventKinds = previewRows.length;

    const sites = new Set(
      pages.map((p) => {
        try {
          return new URL(p.page_url).hostname;
        } catch {
          return "unknown";
        }
      })
    );

    stats.innerHTML = [
      { val: sites.size || 0, lbl: "사이트" },
      { val: pages.length || 0, lbl: "페이지" },
      { val: eventKinds || 0, lbl: "이벤트" },
    ]
      .map(
        (s) =>
          '<div class="export-stat"><div class="val">' +
          s.val +
          '</div><div class="lbl">' +
          s.lbl +
          "</div></div>"
      )
      .join("");

    const preview = $("export-preview");
    if (!preview) return;
    const sample = previewRows.slice(0, 8);
    if (!sample.length) {
      preview.innerHTML =
        '<div class="export-preview-empty">확정 후 미리보기가 표시됩니다.</div>';
      return;
    }

    preview.innerHTML =
      "<table class='export-preview-table'><thead><tr>" +
      "<th>이벤트명</th><th>시점</th><th>카테고리</th><th>액션</th><th>라벨</th><th>설명</th>" +
      "</tr></thead><tbody>" +
      sample
        .map((r) => {
          const isPageView = r.event_name === "페이지뷰";
          const category = r.category_display || r.category || "";
          const action = isPageView ? "" : r.action_display || r.action || "";
          const label = isPageView ? "" : r.label || r.label_example || "";
          return (
            "<tr>" +
            "<td>" +
            exportPreviewCell(r.event_name) +
            "</td>" +
            "<td class='cell-wrap'>" +
            exportPreviewCell(r.trigger) +
            "</td>" +
            "<td>" +
            exportPreviewCell(category) +
            "</td>" +
            "<td>" +
            exportPreviewCell(action) +
            "</td>" +
            "<td>" +
            exportPreviewCell(label) +
            "</td>" +
            "<td class='cell-wrap'>" +
            exportPreviewCell(r.description) +
            "</td>" +
            "</tr>"
          );
        })
        .join("") +
      "</tbody></table>";
  }

  /* ── Navigation handlers ── */

  async function onNext() {
    if (state.step === 0) {
      if (!state.projectId) return;
      const resume = Math.max(1, Math.min(2, Number(state.resumeStep) || 1));
      goToStep(resume, { force: true });
      return;
    }

    if (state.step === 1 && canProceedFrom(1)) {
      if (window.Workspace?.getTaxonomyData()?.tabs?.length) {
        goToStep(2);
        return;
      }
      if (!state.jobs.length) initJobsFromUrls();
      const hasPending = state.jobs.some((j) => j.status === "queued" || j.status === "failed");
      if (hasPending) {
        await runBatchAnalyze();
      } else {
        await autoConfirmAndAdvance();
      }
      return;
    }
  }

  function onPrev() {
    if (state.step > 0) goToStep(state.step - 1);
  }

  function clampStepToAccessible() {
    const maxAccessible = getMaxAccessibleStep();
    if (state.step > maxAccessible) state.step = maxAccessible;
  }

  function resetWizard() {
    if (!confirm("프로젝트 선택 화면으로 돌아갈까요? 현재 프로젝트는 DB에 저장됩니다.")) return;
    void saveState();
    const ids = authSessions.map((s) => s.id);
    authSessions = [];
    for (const id of ids) {
      void fetch("/api/dev/auth-cookies/" + encodeURIComponent(id), { method: "DELETE" }).catch(
        () => {}
      );
    }
    state = defaultState();
    resetProgressTracking();
    window.Workspace?.stopPolling();
    renderAll();
    void loadProjects();
  }

  function notifyWizardCompletionIfChanged() {
    const completed = getCompletedStep();
    const completionChanged = completed !== lastWizardCompleted;
    lastWizardCompleted = completed;

    clampStepToAccessible();
    renderStepNav();
    renderProgressStepLabel();

    if (completionChanged && bumpProgressBarIfNeeded()) {
      renderProgressBar();
    }

    updateNextButton();
  }

  function renderAll() {
    lastWizardCompleted = getCompletedStep();
    if (progressBarCompleted < 0) progressBarCompleted = lastWizardCompleted;
    clampStepToAccessible();
    renderStepNav();
    renderProgressStepLabel();
    renderProgressBar();
    renderProjectContext();
    renderUrlRows();
    renderJobCards();
    showPanel(state.step);
    updateNextButton();
    if (state.sessionId && window.Workspace) {
      void window.Workspace.loadSession(state.sessionId).then((data) => {
        // 완료 여부는 프로젝트 DB 상태가 기준이다. 세션이 일시적으로 없어도
        // 완료 카드를 자동으로 대기 상태로 되돌리거나 재분석하지 않는다.
        refreshWizardSteps();
      });
    }
  }

  /* ── Init ── */

  function refreshWizardSteps() {
    notifyWizardCompletionIfChanged();
  }

  window.__WIZARD_REFRESH_STEPS__ = refreshWizardSteps;

  window.__WIZARD_ON_CONFIRM__ = () => {
    window.Workspace.renderTaxonomyView();
    notifyWizardCompletionIfChanged();
    renderExportPanel();
    goToStep(2, { force: true });
    scheduleSave();
  };

  /**
   * TutorialTour restores sample DOM via innerHTML, which drops event listeners.
   * Re-render from live state so project cards / URL rows / jobs stay clickable.
   */
  window.__WIZARD_AFTER_TOUR__ = () => {
    projectLoading = false;
    renderProjects();
    renderDiscoverPick();
    setDiscoverStatus("", false);
    syncSeedInputFromUrls();
    renderUrlRows();
    renderUrlSummary();
    renderJobCards();
    renderProjectContext();
    updateNextButton();
    refreshWizardSteps();
    if (state.step === 2) renderExportPanel();
    if (state.sessionId && window.Workspace?.loadSession) {
      void window.Workspace.loadSession(state.sessionId).then(() => {
        refreshWizardSteps();
        if (state.step >= 2) window.Workspace.renderTaxonomyView?.();
      });
    } else {
      window.Workspace?.renderSessionTree?.();
      if (state.step >= 2) window.Workspace?.renderTaxonomyView?.();
    }
  };

  $("discover-urls-btn")?.addEventListener("click", () => void runDiscoverUrls());
  $("discover-stop-btn")?.addEventListener("click", () => stopDiscoverUrls());
  $("seed-url-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void runDiscoverUrls();
    }
  });
  $("discover-filter")?.addEventListener("input", () => {
    discoverShowLimit = 40;
    renderDiscoverPick();
  });
  $("discover-select-all")?.addEventListener("click", () => {
    // Select all currently filtered matches (not only the paginated slice).
    for (const link of filteredDiscoveredLinks()) discoveredSelected.add(link.url);
    renderDiscoverPick();
  });
  $("discover-select-none")?.addEventListener("click", () => {
    for (const link of filteredDiscoveredLinks()) discoveredSelected.delete(link.url);
    renderDiscoverPick();
  });
  $("apply-discovered-btn")?.addEventListener("click", () => applyDiscoveredSelection());

  $("add-url-btn")?.addEventListener("click", () => {
    state.urls.push({ url: "", alias: "", viewports: defaultProjectViewports() });
    renderUrlRows();
    scheduleSave();
  });

  $("paste-urls-btn")?.addEventListener("click", () => {
    const dlg = $("paste-dialog");
    $("paste-textarea").value = "";
    dlg.showModal();
  });

  $("paste-cancel")?.addEventListener("click", () => $("paste-dialog").close());
  $("paste-dialog")?.querySelector("form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const lines = $("paste-textarea").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const existing = new Set(state.urls.filter((x) => isValidUrl(x.url)).map((x) => normalizeUrl(x.url)));
    for (const line of lines) {
      if (!isValidUrl(line)) {
        state.urls.push({ url: line, alias: "", viewports: defaultProjectViewports() });
        continue;
      }
      const norm = normalizeUrl(line);
      if (existing.has(norm)) continue;
      existing.add(norm);
      state.urls.push({ url: line, alias: "", viewports: defaultProjectViewports() });
    }
    $("paste-dialog").close();
    renderUrlRows();
    scheduleSave();
  });

  $("start-analyze-btn")?.addEventListener("click", () => void runBatchAnalyze());
  $("stop-analyze-btn")?.addEventListener("click", () => { void requestStopAnalyze(); });
  $("global-stop-btn")?.addEventListener("click", () => { void requestStopAnalyze(); });
  $("retry-failed-btn")?.addEventListener("click", () => {
    const failed = state.jobs.filter((j) => j.status === "failed");
    if (!failed.length) return;
    if (analyzeRunning) {
      const keys = failed.map((j) => jobKey(j));
      for (const j of failed) {
        j.forceReanalyze = true;
        j.status = "queued";
        j.progress = 0;
        j.error = null;
      }
      enqueueAnalyzeKeys(keys, keys);
      renderJobCards();
      updateGlobalAnalyzeBar();
      return;
    }
    void runBatchAnalyze(true);
  });
  $("wizard-next")?.addEventListener("click", () => void onNext());
  $("wizard-prev")?.addEventListener("click", onPrev);
  $("new-wizard-btn")?.addEventListener("click", resetWizard);
  $("project-create-btn")?.addEventListener("click", () => createProjectFromInput());
  $("project-settings-btn")?.addEventListener("click", () => showProjectSettings(false));
  $("project-settings-close")?.addEventListener("click", closeProjectSettings);
  $("project-settings-cancel")?.addEventListener("click", closeProjectSettings);
  $("project-settings-dialog")?.addEventListener("cancel", () => {
    settingsMode = "edit";
    settingsContinueAfterSave = false;
  });
  $("project-settings-dialog")?.addEventListener("close", () => {
    settingsMode = "edit";
    settingsContinueAfterSave = false;
  });
  $("project-settings-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveProjectSettings();
  });

  $("interactive-login-complete")?.addEventListener("click", () => void finishInteractiveLogin());
  $("interactive-login-cancel")?.addEventListener("click", () => void cancelInteractiveLoginUi());

  // pick-search is handled in workspace-core (class-based, survives re-render).

  function init() {
    // Auth UI first — logout must work even if Workspace failed to load
    $("auth-logout-btn")?.addEventListener("click", async () => {
      const btn = $("auth-logout-btn");
      if (btn) btn.disabled = true;
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        /* still leave */
      }
      // Hard navigate so stale SPA state / cookies don't bounce back in.
      location.replace("/login.html?logged_out=1");
    });
    void refreshAuthUi();

    if (!window.Workspace) {
      console.error("Workspace not loaded");
      return;
    }
    if (state.sessionId) window.Workspace.setSessionId(state.sessionId);
    renderAll();
    void loadProjects();
    void hydrateAuthSessions();
    window.Workspace.refreshCredits();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
