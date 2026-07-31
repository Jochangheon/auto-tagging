/** UI 릴리스 버전 — 기능 변경 시 1.2, 1.3 … 로 올릴 것 */
    const APP_VERSION = "3.5";
    const appVersionEl = document.getElementById("app-version");
    if (appVersionEl) appVersionEl.textContent = "v" + APP_VERSION;

    const urlInput = document.getElementById("url");
    const analyzeBtn = document.getElementById("analyze");
    const viewOnlyBtn = document.getElementById("view-only");
    const layoutHintEl = document.getElementById("layout-hint");
    const badgeEl = document.getElementById("badge");
    const statusText = document.getElementById("status-text");
    const listEl = document.getElementById("list");
    const countEl = document.getElementById("count");
    const previewImage = document.getElementById("preview-image");
    const previewEmpty = document.getElementById("preview-empty");
    const previewBody = document.getElementById("preview-body");
    const previewShell = document.getElementById("preview-shell");
    const previewScroll = document.getElementById("preview-scroll");
    const previewOverlay = document.getElementById("preview-overlay");
    const previewMessage = document.getElementById("preview-message");
    const previewStage = document.getElementById("preview-stage");
    const previewShowAllBtn = document.getElementById("preview-show-all-btn");
    const previewValidateBtn = document.getElementById("preview-validate-btn");
    const positionValidationPanel = document.getElementById("position-validation-panel");
    /** @deprecated compat aliases — preview replaced live iframe */
    const liveShell = previewShell;
    const liveEmpty = previewEmpty;
    const liveFrame = previewImage;
    const liveFrameWrapper = previewStage;
    const liveExpired = null;
    const liveExpiredMsg = null;
    const liveReconnectBtn = null;
    const liveReanalyzeBtn = null;
    const liveExpiryHint = null;
    const creditsFirecrawlEl = document.getElementById("credits-firecrawl");
    const creditsLlmEl = document.getElementById("credits-llm");
    const progressWrap = document.getElementById("progress-wrap");
    const progressStage = document.getElementById("progress-stage");
    const progressPercent = document.getElementById("progress-percent");
    const progressFill = document.getElementById("progress-fill");
    const progressDetail = document.getElementById("progress-detail");
    const progressBar = progressWrap ? progressWrap.querySelector(".progress-bar") : null;

    let selectedLi = null;
    let pollTimer = null;
    let activeJobId = null;
    let devSessionId = null;
    let sessionPages = [];
    let lastAnalyzedPageUrl = null;
    let lastAnalyzedViewport = "pc";
    let viewportMode = "pc";
    let lastGroups = [];
    let lastTree = null;
    let lastCandidateCount = 0;
    let lastGroupCount = 0;
    let lastCandidatesByTagId = {};
    const collapsedPages = new Set();
    const collapsedCategories = new Set();
    const collapsedActions = new Set();
    const expandedLabelGroups = new Set();
    let lastLiveViewUrl = null;
    let liveViewSession = null;
    let liveViewCheckTimer = null;
    let liveViewExpiryTickTimer = null;
    let liveViewExpiryWarned = false;
    let pendingSwitchMode = null;
    let currentCapturePage = null;
    let lastCaptureQc = null;
    let currentPreviewMode = "page";
    let lastHighlightMembers = null;
    let lastHighlightTagId = null;
    let captureWatchTimer = null;
    let previewResizeObserver = null;
    let viewportSwitchPromise = null;
    /**
     * Default ON: show every tagged label-group position on the page capture
     * (merged members share one union box — no tag_id badges).
     */
    let showAllPreviewPositions = true;
    const positionValidationByPage = new Map();

    let selectionState = {};
    let selectionFilter = "all";
    let taxonomyData = null;
    let taxonomyTabIndex = 0;
    let taxonomyScope = "common";
    let taxonomySearch = "";
    let taxonomyExpandedRows = new Set();
    let taxonomySortCol = null;
    let taxonomySortAsc = true;
    let selectionPersistTimer = null;
    let selectionDirty = false;
    let confirmInFlight = false;
    let treeActionsCollapsedOnce = false;
    /** Active page tab in pick list (`url::viewport`). */
    let activePickPageKey = null;
    const pickPageTabsEl = document.getElementById("pick-page-tabs");

    const TAXONOMY_MATRIX_COLUMNS = [
      "platform",
      "category",
      "action",
      "label",
      "link_url",
      "direction",
    ];

    const taxonomySummaryBarEl = document.getElementById("taxonomy-summary-bar");
    const taxonomySummaryChipsEl = document.getElementById("taxonomy-summary-chips");

    const selectionBarEl = document.getElementById("selection-bar");
    const selectionSummaryEl = document.getElementById("selection-summary");
    const selectAllBtn = document.getElementById("select-all-btn");
    const selectNoneBtn = document.getElementById("select-none-btn");
    const selectionFilterEl = document.getElementById("selection-filter");
    const confirmBtn = document.getElementById("confirm-btn");
    const mainPanelEl = document.getElementById("main-panel");
    const navAnalyzeEl = document.getElementById("nav-analyze");
    const navTaxonomyEl = document.getElementById("nav-taxonomy");
    const viewTaxonomyEl = document.getElementById("view-taxonomy");
    const taxonomyEmptyEl = document.getElementById("taxonomy-empty");
    const taxonomyContentEl = document.getElementById("taxonomy-content");
    const taxonomyPageTabsEl = document.getElementById("taxonomy-page-tabs");
    const taxonomyPlatformTabsEl = document.getElementById("taxonomy-platform-tabs");
    const taxonomyTableWrapEl = document.getElementById("taxonomy-table-wrap");
    const taxonomySearchEl = document.getElementById("taxonomy-search");
    const taxonomyExportBtn = document.getElementById("taxonomy-export-btn");

    function selKey(pageUrl, tagId) {
      return pageKey(pageUrl) + "::" + tagId;
    }

    function isItemSelected(pageUrl, tagId) {
      const k = selKey(pageUrl, tagId);
      if (k in selectionState) return selectionState[k] !== false;
      return true;
    }

    function setItemSelected(pageUrl, tagId, selected) {
      selectionState[selKey(pageUrl, tagId)] = !!selected;
    }

    function allTagIdsInTree(filtered) {
      const ids = [];
      if (!filtered?.categories) return ids;
      for (const cat of filtered.categories) {
        for (const act of cat.actions) {
          for (const lg of act.label_groups) {
            for (const id of lg.member_tag_ids || []) ids.push(id);
          }
        }
      }
      return ids;
    }

    function countSelectionTotals() {
      let total = 0;
      let selected = 0;
      for (const page of sessionPages) {
        for (const c of page.candidates || []) {
          total += 1;
          if (isItemSelected(page.page_url, c.tag_id)) selected += 1;
        }
      }
      if (!sessionPages.length && lastTree) {
        const map = lastCandidatesByTagId;
        for (const c of Object.values(map)) {
          total += 1;
          if (isItemSelected("", c.tag_id)) selected += 1;
        }
      }
      return { total, selected };
    }

    function updateSelectionSummary() {
      const { total, selected } = countSelectionTotals();
      if (selectionSummaryEl) {
        selectionSummaryEl.textContent = "포함 " + selected + " / 전체 " + total;
      }
      const dock = document.getElementById("pick-confirm-dock");
      if (dock) dock.hidden = total === 0;
      // Keep empty legacy bar hidden — dock replaced it (Fitts confirm proximity).
      if (selectionBarEl) selectionBarEl.hidden = true;
      const confirmPick = document.getElementById("pick-confirm-btn");
      if (confirmPick) {
        confirmPick.disabled = selected === 0;
        confirmPick.textContent =
          selected > 0 ? "확정하고 다음 (" + selected + ")" : "선택된 항목 없음";
      }
      if (typeof window.__WIZARD_REFRESH_STEPS__ === "function") {
        window.__WIZARD_REFRESH_STEPS__();
      }
    }

    /** Re-apply pick search after tree re-render (class-based, survives filter). */
    function applyPickSearchFilter() {
      const input = document.getElementById("pick-search");
      const q = String(input?.value || "")
        .trim()
        .toLowerCase();
      document
        .querySelectorAll("#list .label-row, #list .tree-category, #list .tree-action")
        .forEach((el) => {
          if (!q) {
            el.classList.remove("search-hidden");
            return;
          }
          const text = (el.textContent || "").toLowerCase();
          el.classList.toggle("search-hidden", !text.includes(q));
        });
    }

    function scheduleSelectionPersist() {
      if (!devSessionId) return;
      selectionDirty = true;
      if (selectionPersistTimer) clearTimeout(selectionPersistTimer);
      selectionPersistTimer = setTimeout(() => {
        void fetch("/api/dev/selection", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: devSessionId, selection: selectionState }),
        })
          .then(() => {
            selectionDirty = false;
          })
          .catch(() => {});
      }, 400);
    }

    function mergeSelectionFromServer(serverSelection) {
      if (!serverSelection || typeof serverSelection !== "object") return;
      if (selectionDirty) {
        selectionState = { ...serverSelection, ...selectionState };
      } else {
        selectionState = { ...selectionState, ...serverSelection };
      }
    }

    function createSelectCheckbox(pageUrl, tagIds, { indeterminateFn } = {}) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "tree-select-cb";
      const sync = () => {
        const states = tagIds.map((id) => isItemSelected(pageUrl, id));
        cb.checked = states.every(Boolean);
        cb.indeterminate = !cb.checked && states.some(Boolean);
        if (indeterminateFn) indeterminateFn(cb);
      };
      sync();
      cb.addEventListener("mousedown", (e) => e.stopPropagation());
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", (e) => {
        e.stopPropagation();
        for (const id of tagIds) setItemSelected(pageUrl, id, cb.checked);
        updateSelectionSummary();
        scheduleSelectionPersist();
        rerenderTree();
      });
      cb._syncSelection = sync;
      return cb;
    }

    function matchesSelectionFilter(pageUrl, tagIds) {
      if (selectionFilter === "all") return true;
      const selected = tagIds.some((id) => isItemSelected(pageUrl, id));
      if (selectionFilter === "selected") return selected;
      if (selectionFilter === "excluded") return !selected;
      return true;
    }

    function formatTaxCell(value) {
      const v = value == null ? "" : String(value).trim();
      return v ? v : "-";
    }

    function eventNameChipClass(name) {
      if (name === "페이지뷰") return "page_view";
      if (name === "클릭") return "click";
      if (name === "배너이동") return "banner";
      if (name === "찜하기") return "wish";
      if (name === "장바구니담기") return "cart";
      return "other";
    }

    function eventStripeColor(name) {
      const map = {
        "페이지뷰": "#22c55e",
        "클릭": "#3b82f6",
        "배너이동": "#a855f7",
        "찜하기": "#ec4899",
        "장바구니담기": "#f97316",
      };
      return map[name] || "#64748b";
    }

    function getActiveTaxonomyTab() {
      const tabs = getVisibleTaxonomyTabs();
      if (!tabs.length) return null;
      const idx = Math.min(Math.max(0, taxonomyTabIndex), tabs.length - 1);
      return tabs[idx];
    }

    function taxonomyDisplayName(value) {
      const text = value == null ? "" : String(value).trim();
      if (text.toUpperCase() === "FNB") return "Footer";
      return text.replace(/\bFNB\b/g, "Footer");
    }

    /** Trust server scope=common — no GNB/Footer/푸터 name allowlist. */
    function isCommonTaxonomyRow(_row, tab) {
      return tab?.scope === "common";
    }

    function taxonomyViewportOf(row, tab) {
      if (tab?.scope === "pc" || tab?.scope === "mo") return tab.scope;
      const platform = String(
        row?.platform ||
          row?.members?.[0]?.params?.platform ||
          ""
      ).toLowerCase();
      return platform.includes("mo") || platform.includes("mobile") ? "mo" : "pc";
    }

    function getVisibleTaxonomyTabs() {
      if (!taxonomyData?.tabs?.length) return [];
      return taxonomyData.tabs.filter((tab) => {
        if (tab.kind === "values") return false;
        if (taxonomyScope === "common") {
          return tab.scope === "common" || tab.kind === "common";
        }
        return tab.kind === "page_category" && tab.scope === taxonomyScope;
      });
    }

    function normalizeTaxonomyData(raw) {
      if (!raw) return null;
      if (raw.version === 3 && Array.isArray(raw.tabs)) {
        const commonRows = [];
        const scopedTabs = new Map();
        const utilityTabs = [];
        for (const tab of raw.tabs) {
          if (tab.kind !== "page_category") {
            if (tab.kind === "common") {
              utilityTabs.push({
                ...tab,
                tab_label: "변수 사전",
                variable_rows: (tab.variable_rows || []).map((row) => ({
                  ...row,
                  sample_value: taxonomyDisplayName(row.sample_value) || row.sample_value,
                })),
              });
            } else if (tab.kind === "values") {
              // 값 목록 탭 제거 — skip legacy snapshots
            }
            continue;
          }
          for (const sourceRow of tab.event_rows || []) {
            const row = {
              ...sourceRow,
              page_category: taxonomyDisplayName(sourceRow.page_category),
              trigger: sourceRow.trigger ?? "",
              description: sourceRow.description ?? "",
              note: sourceRow.note ?? "",
              category: taxonomyDisplayName(sourceRow.category) || null,
              category_display:
                taxonomyDisplayName(sourceRow.category_display ?? sourceRow.category) || null,
              action: taxonomyDisplayName(sourceRow.action) || null,
              action_display:
                taxonomyDisplayName(sourceRow.action_display ?? sourceRow.action) || null,
              label: sourceRow.label ?? sourceRow.label_example ?? null,
              label_example: sourceRow.label ?? sourceRow.label_example ?? null,
              members: Array.isArray(sourceRow.members)
                ? sourceRow.members.map((member) => ({
                    ...member,
                    params: Object.fromEntries(
                      Object.entries(member.params || {}).map(([key, value]) => [
                        key,
                        taxonomyDisplayName(value) || value,
                      ])
                    ),
                  }))
                : [],
            };
            if (isCommonTaxonomyRow(row, tab)) {
              commonRows.push(row);
              continue;
            }
            const scope = taxonomyViewportOf(row, tab);
            const label = taxonomyDisplayName(tab.tab_label) || "기타";
            const key = `${scope}:${label}`;
            const grouped = scopedTabs.get(key) || {
              kind: "page_category",
              tab_id: key,
              tab_label: label,
              scope,
              event_rows: [],
            };
            grouped.event_rows.push(row);
            scopedTabs.set(key, grouped);
          }
        }
        const commonEventTab = {
          kind: "page_category",
          tab_id: "events:common",
          tab_label: "공통",
          scope: "common",
          event_rows: commonRows,
        };
        return {
          ...raw,
          tabs: [commonEventTab, ...scopedTabs.values(), ...utilityTabs],
          summary: raw.summary ?? { event_count: 0, parameter_count: 0 },
        };
      }
      return null;
    }

    function buildPayloadFromMember(member, eventName) {
      const payload = { event_name: eventName };
      for (const [k, v] of Object.entries(member.params || {})) {
        if (v != null && String(v).trim() !== "") payload[k] = v;
      }
      return payload;
    }

    function openTaxonomyPayloadDrawer(row, member, editWholeRow) {
      if (!row || !member) return;
      const params = member.params || {};
      const pageCategory = params.category || params.page_category || "";
      const payload = {
        event_name: row.event_name,
        page_category: params.page_category || pageCategory,
        category: pageCategory,
        action: params.action || "",
        label: member.label || params.label || "",
        trigger: row.trigger || "",
        description: row.description || "",
        note: row.note || "",
      };
      for (const key of [
        "platform",
        "link_url",
        "direction",
        "page_path",
        "page_title",
        "page_location",
        "page_referrer",
      ]) {
        if (params[key] != null && String(params[key]).trim() !== "") payload[key] = params[key];
      }
      let sourcePage = sessionPages.find((page) =>
        (page.candidates || []).some((candidate) => candidate.candidate_id === member.candidate_id)
      );
      if (member.element_location) {
        payload.element_location = member.element_location;
      } else if (member.page_url) {
        sourcePage ||= sessionPages.find(
          (p) => normalizeUrlClient(p.page_url) === normalizeUrlClient(member.page_url)
        );
        const c = sourcePage?.candidates?.find((x) => x.tag_id === member.tag_id);
        if (c) {
          payload.element_location = buildElementLocation(c, pageMetaFromSessionPage(sourcePage));
        }
      }
      const rowTagIds = (row.members || []).map((item) => item.tag_id);
      const ctx = {
        key: "tax::" + row.row_key + "::" + member.tag_id,
        eventName: row.event_name,
        eventType: row.event_name === "페이지뷰" ? "page_view" : "click",
        label: member.label || payload.label || "",
        tagIds: editWholeRow ? rowTagIds : [member.tag_id],
        category: pageCategory,
        action: payload.action || "",
        payload,
        parameters: payload,
        pageUrl: sourcePage?.page_url || member.page_url || "",
        pageViewport: sourcePage?.active_viewport || member.element_location?.viewport || "pc",
        editable: row.event_name !== "페이지뷰",
        taxonomyRowKey: editWholeRow ? row.row_key : null,
      };
      paramDrawerJsonMode = false;
      openParamDrawer(ctx, null);
      if (editWholeRow && ctx.editable) {
        paramDrawerEditMode = true;
        renderParamDrawer();
      }
    }

    function switchAppView(view) {
      const isTax = view === "taxonomy";
      if (mainPanelEl) mainPanelEl.classList.toggle("view-taxonomy-mode", isTax);
      if (navAnalyzeEl) navAnalyzeEl.classList.toggle("active", !isTax);
      if (navTaxonomyEl) navTaxonomyEl.classList.toggle("active", isTax);
      if (viewTaxonomyEl && !window.__WIZARD_MODE__) viewTaxonomyEl.hidden = !isTax;
      if (isTax) renderTaxonomyView();
    }

    function renderTaxonomyPageTabs() {
      const visibleTabs = getVisibleTaxonomyTabs();
      if (!visibleTabs.length) {
        taxonomyPageTabsEl.innerHTML = "";
        return;
      }
      if (taxonomyTabIndex >= visibleTabs.length) taxonomyTabIndex = 0;
      taxonomyPageTabsEl.innerHTML = visibleTabs
        .map((t, i) => {
          let count = "";
          if (t.kind === "page_category") {
            const n = (t.event_rows || []).length;
            count = " (" + n + ")";
          }
          return (
            '<button type="button" class="taxonomy-page-tab' +
            (i === taxonomyTabIndex ? " active" : "") +
            '" data-tab-idx="' +
            i +
            '">' +
            escapeHtml(t.tab_label) +
            count +
            "</button>"
          );
        })
        .join("");
      taxonomyPageTabsEl.querySelectorAll(".taxonomy-page-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          taxonomyTabIndex = Number(btn.dataset.tabIdx) || 0;
          renderTaxonomyView();
        });
      });
    }

    function renderTaxonomyPlatformTabs() {
      if (!taxonomyPlatformTabsEl) return;
      const eventTabs = (taxonomyData?.tabs || []).filter((tab) => tab.kind === "page_category");
      const counts = {
        common: eventTabs
          .filter((tab) => tab.scope === "common")
          .reduce((sum, tab) => sum + (tab.event_rows || []).length, 0),
        pc: eventTabs
          .filter((tab) => tab.scope === "pc")
          .reduce((sum, tab) => sum + (tab.event_rows || []).length, 0),
        mo: eventTabs
          .filter((tab) => tab.scope === "mo")
          .reduce((sum, tab) => sum + (tab.event_rows || []).length, 0),
      };
      taxonomyPlatformTabsEl.querySelectorAll("[data-taxonomy-scope]").forEach((button) => {
        const scope = button.dataset.taxonomyScope;
        const label = scope === "common" ? "공통" : scope === "mo" ? "MO" : "PC";
        button.textContent = `${label} (${counts[scope] || 0})`;
        button.classList.toggle("active", scope === taxonomyScope);
        button.onclick = () => {
          taxonomyScope = scope;
          taxonomyTabIndex = 0;
          renderTaxonomyView();
        };
      });
    }

    function renderTaxonomySummary() {
      const s = taxonomyData.summary || {};
      taxonomySummaryChipsEl.innerHTML =
        '<span class="taxonomy-summary-chip">이벤트 ' + (s.event_count ?? 0) + "</span>" +
        '<span class="taxonomy-summary-chip">파라미터 ' + (s.parameter_count ?? 0) + "</span>" +
        '<span class="taxonomy-summary-chip">선택 ' + taxonomyData.selected_count + "/" + taxonomyData.total_count + "</span>";
    }

    function renderTaxonomyView() {
      if (!taxonomyData?.tabs?.length) {
        taxonomyEmptyEl.hidden = false;
        taxonomyContentEl.hidden = true;
        taxonomySummaryBarEl.hidden = true;
        return;
      }
      taxonomyEmptyEl.hidden = true;
      taxonomyContentEl.hidden = false;
      taxonomySummaryBarEl.hidden = false;
      renderTaxonomySummary();
      renderTaxonomyPlatformTabs();
      renderTaxonomyPageTabs();
      renderTaxonomyTable();
    }

    function sortTaxonomyRows(rows) {
      if (!taxonomySortCol) return rows;
      const col = taxonomySortCol;
      const asc = taxonomySortAsc;
      return [...rows].sort((a, b) => {
        const va =
          col === "event_name"
            ? a.event_name
            : col === "member_count"
              ? a.member_count
              : col === "category"
                ? a.category_display || a.category
                : col === "action"
                  ? a.action_display || a.action
                  : col === "label"
                    ? a.label || a.label_example
                    : a[col] ?? a[col + "_example"];
        let vb =
          col === "event_name"
            ? b.event_name
            : col === "member_count"
              ? b.member_count
              : col === "category"
                ? b.category_display || b.category
                : col === "action"
                  ? b.action_display || b.action
                  : col === "label"
                    ? b.label || b.label_example
                    : b[col] ?? b[col + "_example"];
        va = va == null ? "" : String(va);
        vb = vb == null ? "" : String(vb);
        const cmp = va.localeCompare(vb, "ko");
        return asc ? cmp : -cmp;
      });
    }

    function renderTaxonomyCommonTable(tab) {
      const q = taxonomySearch.trim().toLowerCase();
      let rows = tab.variable_rows || [];
      if (q) {
        rows = rows.filter((r) =>
          (r.name + r.description + (r.sample_value || "")).toLowerCase().includes(q)
        );
      }
      taxonomyTableWrapEl.innerHTML =
        "<table class='taxonomy-table'><thead><tr>" +
        "<th>파라미터</th><th>타입</th><th>설명</th><th>비고</th><th>예시값</th><th>사용 이벤트</th>" +
        "</tr></thead><tbody>" +
        rows
          .map(
            (r) =>
              "<tr><td>" +
              escapeHtml(r.name) +
              "</td><td>" +
              r.type +
              "</td><td class='cell-wrap'>" +
              escapeHtml(formatTaxCell(r.description)) +
              "</td><td class='cell-wrap'>" +
              escapeHtml(formatTaxCell(r.note)) +
              "</td><td>" +
              escapeHtml(formatTaxCell(r.sample_value)) +
              "</td><td class='cell-wrap'>" +
              escapeHtml((r.used_events || []).join(", ") || "-") +
              "</td></tr>"
          )
          .join("") +
        "</tbody></table>";
    }

    function renderTaxonomyValuesTable(tab) {
      const q = taxonomySearch.trim().toLowerCase();
      let valueRows = tab.value_rows || [];
      if (q) {
        valueRows = valueRows
          .map((row) => ({
            ...row,
            values: row.values.filter((v) =>
              (row.param_name + v.value).toLowerCase().includes(q)
            ),
          }))
          .filter((row) => row.values.length);
      }
      let html = "";
      for (const row of valueRows) {
        html +=
          "<h4 style='margin:16px 0 8px;font-size:13px'>" +
          escapeHtml(row.param_name) +
          "</h4>" +
          "<table class='taxonomy-table'><thead><tr><th>값</th><th>건수</th></tr></thead><tbody>";
        for (const v of row.values) {
          html +=
            "<tr><td>" +
            escapeHtml(v.value) +
            "</td><td>" +
            v.count +
            "</td></tr>";
        }
        html += "</tbody></table>";
      }
      taxonomyTableWrapEl.innerHTML = html || "<p class='empty'>값 없음</p>";
    }

    function renderTaxonomyMatrixTable(tab) {
      const q = taxonomySearch.trim().toLowerCase();
      let rows = tab.event_rows || [];
      if (q) {
        rows = rows.filter((r) => {
          const hay =
            (r.event_name || "") +
            " " +
            (r.trigger || "") +
            " " +
            (r.description || "") +
            " " +
            (r.category_display || r.category || "") +
            " " +
            (r.action_display || r.action || "") +
            " " +
            (r.label || r.label_example || "") +
            " " +
            (r.members || []).map((m) => (m.label || "") + " " + (m.link_url || "")).join(" ");
          return hay.toLowerCase().includes(q);
        });
      }
      rows = sortTaxonomyRows(rows);

      const sortMark = (col) => {
        if (taxonomySortCol !== col) return "";
        return taxonomySortAsc ? " ▲" : " ▼";
      };

      const head =
        "<th></th><th></th>" +
        "<th data-sort='event_name'>event_name" +
        sortMark("event_name") +
        "</th>" +
        "<th>발생 시점</th>" +
        "<th data-sort='platform'>platform" +
        sortMark("platform") +
        "</th>" +
        "<th data-sort='category'>category (카테고리)" +
        sortMark("category") +
        "</th>" +
        "<th data-sort='action'>action (액션)" +
        sortMark("action") +
        "</th>" +
        "<th data-sort='label'>label</th>" +
        "<th>설명</th><th>비고</th>" +
        "<th>수정</th>";

      let body = "";
      for (const r of rows) {
        const expanded = taxonomyExpandedRows.has(r.row_key);
        const stripe = eventStripeColor(r.event_name);
        const chipCls = eventNameChipClass(r.event_name);
        const isPageView = r.event_name === "페이지뷰";
        const catCell = isPageView ? "-" : formatTaxCell(r.category_display || r.category);
        const actCell = isPageView ? "-" : formatTaxCell(r.action_display || r.action);
        const labelCell = isPageView ? "-" : formatTaxCell(r.label || r.label_example);
        body +=
          "<tr class='taxonomy-event-row' data-row-key='" +
          escapeHtml(r.row_key) +
          "'>" +
          "<td class='event-stripe' style='background:" +
          stripe +
          "'></td>" +
          "<td><button type='button' class='taxonomy-expand-btn' data-expand='" +
          escapeHtml(r.row_key) +
          "'>" +
          (expanded ? "▾" : "▸") +
          "</button></td>" +
          "<td>" +
          '<span class="taxonomy-event-chip ' +
          chipCls +
          '">' +
          escapeHtml(r.event_name) +
          "</span></td>" +
          "<td class='cell-wrap'>" +
          escapeHtml(formatTaxCell(r.trigger)) +
          "</td>" +
          "<td" +
          (formatTaxCell(r.platform) === "-" ? " class='cell-empty'" : "") +
          ">" +
          escapeHtml(formatTaxCell(r.platform)) +
          "</td>" +
          "<td" +
          (catCell === "-" ? " class='cell-empty'" : "") +
          ">" +
          escapeHtml(catCell) +
          "</td>" +
          "<td" +
          (actCell === "-" ? " class='cell-empty'" : "") +
          ">" +
          escapeHtml(actCell) +
          "</td>" +
          "<td" +
          (labelCell === "-" ? " class='cell-empty'" : "") +
          ">" +
          escapeHtml(labelCell) +
          "</td>" +
          "<td class='cell-wrap'>" +
          escapeHtml(formatTaxCell(r.description)) +
          "</td>" +
          "<td class='cell-wrap'>" +
          escapeHtml(formatTaxCell(r.note)) +
          "</td>" +
          "<td><button type='button' class='taxonomy-payload-btn tax-row-payload' data-row-key='" +
          escapeHtml(r.row_key) +
          "' title='이 행과 연결된 후보 JSON 수정'>수정</button></td>" +
          "</tr>";

        if (expanded && r.members?.length) {
          for (const m of r.members) {
            body +=
              "<tr class='taxonomy-member-row'>" +
              "<td></td><td></td>" +
              "<td colspan='2'>tag_id " +
              m.tag_id +
              "</td>" +
              "<td colspan='5'>" +
              escapeHtml(formatTaxCell(m.label)) +
              "</td>" +
              "<td colspan='1'></td>" +
              "<td><button type='button' class='taxonomy-payload-btn tax-member-payload' data-row-key='" +
              escapeHtml(r.row_key) +
              "' data-tag-id='" +
              m.tag_id +
              "'>{ }</button></td>" +
              "</tr>";
          }
        }
      }

      taxonomyTableWrapEl.innerHTML =
        "<table class='taxonomy-table'><thead><tr>" +
        head +
        "</tr></thead><tbody>" +
        (body || "<tr><td colspan='11'>없음</td></tr>") +
        "</tbody></table>";

      taxonomyTableWrapEl.querySelectorAll("[data-sort]").forEach((th) => {
        th.style.cursor = "pointer";
        th.addEventListener("click", () => {
          const col = th.dataset.sort;
          if (taxonomySortCol === col) taxonomySortAsc = !taxonomySortAsc;
          else {
            taxonomySortCol = col;
            taxonomySortAsc = true;
          }
          renderTaxonomyTable();
        });
      });

      taxonomyTableWrapEl.querySelectorAll(".taxonomy-expand-btn, .taxonomy-event-row").forEach((el) => {
        el.addEventListener("click", (e) => {
          if (e.target.closest(".taxonomy-payload-btn")) return;
          const key = el.dataset.expand || el.closest(".taxonomy-event-row")?.dataset.rowKey;
          if (!key) return;
          if (taxonomyExpandedRows.has(key)) taxonomyExpandedRows.delete(key);
          else taxonomyExpandedRows.add(key);
          renderTaxonomyTable();
        });
      });

      taxonomyTableWrapEl.querySelectorAll(".tax-row-payload").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const row = rows.find((r) => r.row_key === btn.dataset.rowKey);
          const member = row?.members?.[0];
          if (member) openTaxonomyPayloadDrawer(row, member, true);
        });
      });

      taxonomyTableWrapEl.querySelectorAll(".tax-member-payload").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const row = rows.find((r) => r.row_key === btn.dataset.rowKey);
          const member = row?.members?.find((m) => String(m.tag_id) === btn.dataset.tagId);
          if (member && row) openTaxonomyPayloadDrawer(row, member, false);
        });
      });
    }

    function renderTaxonomyTable() {
      const tab = getActiveTaxonomyTab();
      if (!tab) {
        const label = taxonomyScope === "mo" ? "MO" : taxonomyScope === "pc" ? "PC" : "공통";
        taxonomyTableWrapEl.innerHTML =
          "<p class='empty'>" + label + " 택소노미 항목이 없습니다.</p>";
        return;
      }
      if (tab.kind === "common") {
        renderTaxonomyCommonTable(tab);
        return;
      }
      renderTaxonomyMatrixTable(tab);
    }

    async function confirmSelection() {
      if (!devSessionId || confirmInFlight) return;
      const { selected } = countSelectionTotals();
      if (!selected) {
        setStatus("선택된 항목이 없습니다.", true);
        return;
      }
      if (!confirm("선택 " + selected + "개로 택소노미를 만듭니다. 계속할까요?")) return;
      confirmInFlight = true;
      if (confirmBtn) confirmBtn.disabled = true;
      setBadge("progress", "확정 중");
      setStatus("택소노미 생성 중…");
      if (typeof window.__WIZARD_CENTER_PROGRESS_SHOW__ === "function") {
        window.__WIZARD_CENTER_PROGRESS_SHOW__({
          stage: "택소노미 생성 중…",
          percent: 5,
          detail: "선택 " + selected + "개 · 이벤트·파라미터 정리",
          simulate: true,
        });
      }
      try {
        const res = await fetch("/api/dev/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: devSessionId }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "confirm failed");
        if (typeof window.__WIZARD_CENTER_PROGRESS_UPDATE__ === "function") {
          window.__WIZARD_CENTER_PROGRESS_UPDATE__({
            stage: "택소노미 표 정리 중…",
            percent: 96,
            detail: "선택 " + (data.selected_count ?? selected) + "개 반영",
          });
        }
        const normalized = normalizeTaxonomyData(data.taxonomy);
        if (!normalized?.tabs?.length) {
          throw new Error("택소노미 응답 형식 오류 (tabs 없음)");
        }
        taxonomyData = normalized;
        taxonomyTabIndex = 0;
        taxonomyExpandedRows = new Set();
        if (typeof window.__WIZARD_CENTER_PROGRESS_UPDATE__ === "function") {
          window.__WIZARD_CENTER_PROGRESS_UPDATE__({
            stage: "완료",
            percent: 100,
            detail: "택소노미 초안 준비됨",
          });
        }
        setBadge("done", "확정됨");
        if (typeof window.__WIZARD_ON_CONFIRM__ === "function") {
          window.__WIZARD_ON_CONFIRM__(normalized, data);
        } else {
          setStatus(
            "택소노미 완료 · 선택 " +
              data.selected_count +
              "/" +
              data.total_count +
              " · 좌측 「택소노미」 탭에서 확인"
          );
        }
      } catch (err) {
        setBadge("error", "확정 실패");
        setStatus(err.message, true);
      } finally {
        confirmInFlight = false;
        if (confirmBtn) confirmBtn.disabled = false;
        if (typeof window.__WIZARD_CENTER_PROGRESS_HIDE__ === "function") {
          setTimeout(() => window.__WIZARD_CENTER_PROGRESS_HIDE__(), 450);
        }
      }
    }

    const modePcBtn = document.getElementById("mode-pc");
    const modeMoBtn = document.getElementById("mode-mo");
    const platformHint = document.getElementById("platform-hint");

    function setModeButtonsEnabled(enabled) {
      if (modePcBtn) modePcBtn.disabled = !enabled;
      if (modeMoBtn) modeMoBtn.disabled = !enabled;
    }

    function syncPreviewShellForPage(pageEntry) {
      if (!previewShell || !previewStage) return;
      const isMo = pageEntry?.active_viewport === "mo";
      previewShell.classList.remove("mo", "pc");
      previewShell.classList.add(isMo ? "mo" : "pc");
      previewStage.style.maxWidth = isMo ? "390px" : "";
      previewStage.style.margin = isMo ? "0 auto" : "";
      previewStage.style.width = "";
      previewStage.style.height = "";
      scheduleLayoutReflow("viewport");
    }

    function setViewportModeUI(mode) {
      viewportMode = mode;
      if (modePcBtn) modePcBtn.classList.toggle("active", mode === "pc");
      if (modeMoBtn) modeMoBtn.classList.toggle("active", mode === "mo");
      if (previewShell) {
        previewShell.classList.toggle("mo", mode === "mo");
        previewShell.classList.toggle("pc", mode !== "mo");
      }
      scheduleLayoutReflow("mode");
      updateModeHint();
      if (sessionPages.length) {
        const targetUrl =
          lastAnalyzedPageUrl || currentCapturePage?.page_url || urlInput.value.trim();
        if (targetUrl) {
          const page = findSessionPage(targetUrl, mode);
          if (page?.capture_url) {
            lastAnalyzedPageUrl = page.page_url;
            lastAnalyzedViewport = page.active_viewport === "mo" ? "mo" : "pc";
            syncPreviewShellForPage(page);
            const curKey = currentCapturePage
              ? pageKey(currentCapturePage.page_url, currentCapturePage.active_viewport)
              : null;
            const nextKey = pageKey(page.page_url, page.active_viewport);
            if (curKey !== nextKey || previewShell?.classList.contains("mo") !== (mode === "mo")) {
              showCapturePreview(page);
            }
          }
        }
        renderSessionTree();
      } else if (lastTree || lastGroups.length) {
        renderList(lastTree, lastGroups, lastGroupCount);
      }
    }

    function updateModeHint() {
      const label = viewportMode === "mo" ? "MO" : "PC";
      if (platformHint) {
        platformHint.textContent = activeJobId ? label + " 모드" : label + " 모드로 분석";
      }
    }

    function onModeButtonClick(mode) {
      if (viewportSwitchPromise && pendingSwitchMode === mode) return;
      if (!activeJobId) {
        setViewportModeUI(mode);
        return;
      }
      void switchViewport(mode);
    }

    function normalizeUrlClient(url) {
      try {
        const u = new URL(url);
        u.hash = "";
        if (u.pathname.endsWith("/") && u.pathname.length > 1) {
          u.pathname = u.pathname.slice(0, -1);
        }
        return u.href;
      } catch {
        return String(url || "").trim();
      }
    }

    function pageKey(url, viewport) {
      const base = normalizeUrlClient(url);
      const vp = viewport === "mo" ? "mo" : viewport ? "pc" : null;
      return vp ? base + "::" + vp : base;
    }

    function pageCollapseKey(pageUrl, suffix) {
      return pageKey(pageUrl) + "::" + suffix;
    }

    const paramDrawerEl = document.getElementById("param-drawer");
    const paramBackdropEl = document.getElementById("param-drawer-backdrop");
    const paramDrawerBadgeEl = document.getElementById("param-drawer-badge");
    const paramDrawerLabelEl = document.getElementById("param-drawer-label");
    const paramDrawerSubEl = document.getElementById("param-drawer-sub");
    const paramDrawerBodyEl = document.getElementById("param-drawer-body");
    const paramDrawerCloseBtn = document.getElementById("param-drawer-close");
    const paramToggleJsonBtn = document.getElementById("param-toggle-json");
    const paramToggleEditBtn = document.getElementById("param-toggle-edit");
    const paramSaveBtn = document.getElementById("param-save-btn");
    const paramCopyBtn = document.getElementById("param-copy-btn");

    let paramDrawerOpen = false;
    let paramDrawerJsonMode = false;
    let paramDrawerEditMode = false;
    let paramDrawerContext = null;
    let paramDrawerSourceKey = null;
    let paramDrawerActiveLi = null;

    const PARAM_DISPLAY_ORDER = [
      "event_name",
      "page_category",
      "page_name",
      "category",
      "action",
      "label",
      "platform",
      "link_url",
      "direction",
      "page_path",
      "page_title",
      "page_location",
      "page_referrer",
    ];

    const INTERNAL_ACTION_KEYS = new Set([
      "click",
      "slide_nav",
      "page_view",
      "add_wishlist",
      "interact",
    ]);

    function taggingPageCategoryOf(candidate) {
      if (!candidate) return "기타";
      if (candidate.page_category?.trim()) return candidate.page_category.trim();
      const params = parametersToRecord(candidate.parameters);
      if (params.page_category?.trim()) return params.page_category.trim();
      if (candidate.category?.trim()) return candidate.category.trim();
      return "기타";
    }

    function taggingAreaOf(candidate) {
      if (!candidate) return "기타";
      if (candidate.tag_id === 0 || candidate.action_key === "page_view") return "";
      const rawAction = candidate.action?.trim();
      if (rawAction && !INTERNAL_ACTION_KEYS.has(rawAction)) return rawAction;
      const params = parametersToRecord(candidate.parameters);
      if (params.action?.trim()) return params.action.trim();
      const page = taggingPageCategoryOf(candidate);
      const legacyArea = params.category?.trim();
      if (legacyArea && legacyArea !== page) return legacyArea;
      return "기타";
    }

    function buildElementLocation(record, pageMeta) {
      if (!record) return null;
      const tagId = record.tag_id ?? 0;
      const loc = {
        tag_id: tagId,
        selector_hint: (record.selector_hint || `[data-tag-id="${tagId}"]`).trim(),
        bbox: record.overlay_bbox ?? record.bbox ?? null,
        platform: record.platform ?? null,
        element_capture_url: record.element_capture_url ?? null,
        menu_reveal_path: record.menu_reveal_path,
        hidden_reason: record.hidden_reason,
        text: (record.text || record.label || "").slice(0, 120),
      };
      if (record.selectors_fallback?.length) loc.selectors_fallback = record.selectors_fallback;
      if (pageMeta?.active_viewport === "mo" || pageMeta?.active_viewport === "pc") {
        loc.viewport = pageMeta.active_viewport;
      }
      if (pageMeta?.capture_width > 0) loc.page_width = pageMeta.capture_width;
      if (pageMeta?.capture_height > 0) loc.page_height = pageMeta.capture_height;
      if (pageMeta?.capture_url) loc.capture_url = pageMeta.capture_url;
      return loc;
    }

    function pageMetaFromSessionPage(page) {
      if (!page) return null;
      return {
        active_viewport: page.active_viewport,
        capture_width: page.capture_width,
        capture_height: page.capture_height,
        capture_url: page.capture_url,
      };
    }

    function buildTaggingTransmissionPayload(candidate, pageMeta) {
      if (!candidate) return {};
      const params = parametersToRecord(candidate.parameters);
      const page_category = taggingPageCategoryOf(candidate);
      const isPageView =
        candidate.tag_id === 0 || candidate.action_key === "page_view";

      if (isPageView) {
        const pageName =
          (params.page_name && String(params.page_name).trim()) ||
          page_category ||
          "페이지";
        const payload = {
          event_name: candidate.event_name?.trim() || "페이지뷰",
          page_category,
          page_name: pageName,
        };
        for (const key of [
          "platform",
          "page_location",
          "page_path",
          "page_title",
          "page_referrer",
        ]) {
          const v = params[key];
          if (v != null && String(v).trim() !== "") payload[key] = v;
        }
        if (!payload.platform && candidate.platform) payload.platform = candidate.platform;
        return payload;
      }

      const action = taggingAreaOf(candidate);
      const label = (candidate.label || candidate.text || "").trim();
      const payload = {
        event_name: candidate.event_name?.trim() || "클릭",
        page_category,
        category: page_category,
        action,
        label,
        element_location: buildElementLocation(candidate, pageMeta),
      };
      for (const key of [
        "platform",
        "link_url",
        "direction",
        "page_location",
        "page_path",
        "page_title",
        "page_referrer",
      ]) {
        const v = params[key];
        if (v != null && String(v).trim() !== "") payload[key] = v;
      }
      if (!payload.platform && candidate.platform) payload.platform = candidate.platform;
      return payload;
    }

    function buildCandidatesMap(candidates) {
      const map = {};
      for (const c of candidates || []) map[c.tag_id] = c;
      return map;
    }

    function buildPositionsMap(positions) {
      const map = {};
      for (const p of positions || []) map[p.tag_id] = p;
      return map;
    }

    /** Bbox on full-page capture wins over tag-time offscreen/collapsed heuristics. */
    function reconcileHiddenReason(reason, bbox) {
      if (bbox && bbox.w > 0 && bbox.h > 0) {
        if (reason === "offscreen" || reason === "collapsed_parent") return "visible";
        return reason || "visible";
      }
      if (!reason || reason === "visible") return "zero_size";
      return reason;
    }

    /** positions.json row + candidate + tree member → one record (pick UI & taxonomy share this). */
    function mergeTagRecord(candidate, position, member) {
      const tagId = candidate?.tag_id ?? position?.tag_id ?? member?.tag_id;
      const overlay_bbox =
        candidate?.overlay_bbox ?? position?.bbox ?? member?.overlay_bbox ?? null;
      const hidden_reason = reconcileHiddenReason(
        candidate?.hidden_reason ?? position?.hidden_reason ?? member?.hidden_reason,
        overlay_bbox
      );
      return {
        ...(member || {}),
        ...(candidate || {}),
        tag_id: tagId,
        overlay_bbox,
        menu_reveal_path:
          candidate?.menu_reveal_path ?? position?.menu_reveal_path ?? member?.menu_reveal_path,
        hidden_reason,
        capture_status: candidate?.capture_status ?? member?.capture_status,
        element_capture_url:
          candidate?.element_capture_url ?? member?.element_capture_url ?? null,
        no_capture: candidate?.no_capture ?? member?.no_capture,
        capture_found: candidate?.capture_found ?? member?.capture_found,
        label: member?.label || candidate?.label,
        text: member?.text || candidate?.text || position?.text,
        platform: candidate?.platform ?? position?.platform ?? member?.platform,
        element_location: buildElementLocation(
          {
            tag_id: tagId,
            selector_hint: candidate?.selector_hint ?? position?.selector_hint,
            selectors_fallback: candidate?.selectors_fallback ?? position?.selectors_fallback,
            overlay_bbox,
            platform: candidate?.platform ?? position?.platform ?? member?.platform,
            element_capture_url:
              candidate?.element_capture_url ?? position?.element_capture_url ?? member?.element_capture_url,
            menu_reveal_path:
              candidate?.menu_reveal_path ?? position?.menu_reveal_path ?? member?.menu_reveal_path,
            hidden_reason,
            text: member?.text || candidate?.text || position?.text,
            label: member?.label || candidate?.label,
          },
          null
        ),
      };
    }

    function getPageContext(pageUrl, preferViewport) {
      const page = pageUrl ? findSessionPage(pageUrl, preferViewport ?? viewportMode) : null;
      if (!page) {
        return { page: null, candidates: lastCandidatesByTagId, positions: {} };
      }
      return {
        page,
        candidates: buildCandidatesMap(page.candidates || []),
        positions: buildPositionsMap(page.positions || []),
      };
    }

    function resolveTagRecord(pageUrl, tagId, preferViewport, member) {
      const ctx = getPageContext(pageUrl, preferViewport);
      const candidate = ctx.candidates[tagId] || lastCandidatesByTagId[tagId];
      const position = ctx.positions[tagId];
      return mergeTagRecord(candidate, position, member);
    }

    function getCandidatesMapForPage(pageUrl, preferViewport) {
      const page = findSessionPage(pageUrl, preferViewport ?? viewportMode);
      if (!page?.candidates?.length) return lastCandidatesByTagId;
      const positions = buildPositionsMap(page.positions);
      const map = {};
      for (const c of page.candidates) {
        map[c.tag_id] = mergeTagRecord(c, positions[c.tag_id], null);
      }
      return map;
    }

    function parametersToRecord(parameters) {
      const out = {};
      for (const p of parameters || []) {
        if (!p || !p.name) continue;
        out[p.name] = p.value_hint;
      }
      return out;
    }

    function buildTransmissionPayload(candidate) {
      return buildTaggingTransmissionPayload(candidate);
    }

    function isPageViewCandidate(c) {
      if (!c) return false;
      return (
        c.tag_id === 0 ||
        c.action_key === "page_view" ||
        c.action === "페이지뷰" ||
        c.event_name === "페이지뷰"
      );
    }

    function buildDrawerContextFromCandidate(candidate, extras = {}) {
      if (!candidate) return null;
      const page =
        extras.pageUrl != null
          ? findSessionPage(extras.pageUrl, extras.pageViewport ?? viewportMode)
          : null;
      const pageMeta = pageMetaFromSessionPage(page);
      const payload = buildTaggingTransmissionPayload(candidate, pageMeta);
      const pageView = isPageViewCandidate(candidate);
      const tagIds = extras.tagIds || [candidate.tag_id];
      const pageUrl = extras.pageUrl || "";
      return {
        key: extras.paramKey || pageUrl + "::" + tagIds.join(","),
        eventName: payload.event_name || (pageView ? "페이지뷰" : "클릭"),
        eventType: pageView ? "page_view" : "click",
        label: pageView
          ? payload.page_name || extras.label || payload.page_category || ""
          : payload.label || extras.label || "",
        tagIds,
        category: pageView
          ? ""
          : extras.category || payload.category || payload.page_category || "",
        action: pageView ? "" : payload.action || "",
        payload,
        parameters: payload,
        pageUrl,
        pageViewport: extras.pageViewport ?? page?.active_viewport ?? viewportMode,
        editable: !pageView && tagIds.some((id) => id !== 0),
      };
    }

    function formatParamValue(value) {
      if (value == null || String(value).trim() === "") {
        return '<span class="param-empty-val">(없음)</span>';
      }
      if (typeof value === "object") {
        try {
          return escapeHtml(JSON.stringify(value));
        } catch {
          return '<span class="param-empty-val">(객체)</span>';
        }
      }
      return escapeHtml(String(value));
    }

    function orderedParamKeys(payload) {
      const keys = Object.keys(payload || {}).filter(
        (k) => k !== "element_location" && payload[k] != null && String(payload[k]).trim() !== ""
      );
      const ordered = [];
      for (const k of PARAM_DISPLAY_ORDER) {
        if (keys.includes(k)) ordered.push(k);
      }
      for (const k of keys.sort()) {
        if (!ordered.includes(k)) ordered.push(k);
      }
      return ordered;
    }

    function renderParamDrawerBody() {
      if (!paramDrawerContext) return;
      const payload = paramDrawerContext.payload || {};
      if (paramDrawerEditMode && paramDrawerContext.editable) {
        const p = payload;
        paramDrawerBodyEl.innerHTML =
          '<form class="param-edit-form" id="param-edit-form">' +
          '<p class="param-edit-hint">카테고리·액션·라벨이 기존 그룹과 같으면 그 그룹으로 합쳐집니다.</p>' +
          "<label>카테고리 (page_category)<input name=\"page_category\" value=\"" +
          escapeAttr(p.page_category || p.category || "") +
          '" /></label>' +
          "<label>액션 / 영역 (action)<input name=\"action\" value=\"" +
          escapeAttr(p.action || "") +
          '" /></label>' +
          "<label>라벨 (label)<input name=\"label\" value=\"" +
          escapeAttr(p.label || "") +
          '" /></label>' +
          "<label>이벤트명 (event_name)<input name=\"event_name\" value=\"" +
          escapeAttr(p.event_name || "") +
          '" /></label>' +
          "<label>링크 URL (link_url)<input name=\"link_url\" value=\"" +
          escapeAttr(p.link_url || "") +
          '" /></label>' +
          "<label>방향 (direction)<input name=\"direction\" value=\"" +
          escapeAttr(p.direction || "") +
          '" /></label>' +
          (paramDrawerContext.taxonomyRowKey
            ? "<label>발생 시점 (trigger)<input name=\"trigger\" value=\"" +
              escapeAttr(p.trigger || "") +
              '" /></label>' +
              "<label>설명 (description)<textarea name=\"description\" rows=\"3\">" +
              escapeHtml(p.description || "") +
              "</textarea></label>" +
              "<label>비고 (note)<textarea name=\"note\" rows=\"2\">" +
              escapeHtml(p.note || "") +
              "</textarea></label>"
            : "") +
          "</form>";
        return;
      }
      if (paramDrawerJsonMode) {
        paramDrawerBodyEl.innerHTML =
          '<pre class="param-json-block">' +
          escapeHtml(JSON.stringify(payload, null, 2)) +
          "</pre>";
        return;
      }
      const keys = orderedParamKeys(payload);
      let rows = "";
      for (const key of keys) {
        rows +=
          "<tr><th>" + escapeHtml(key) + "</th><td>" + formatParamValue(payload[key]) + "</td></tr>";
      }
      paramDrawerBodyEl.innerHTML = '<table class="param-kv-table"><tbody>' + rows + "</tbody></table>";
    }

    function renderParamDrawer() {
      if (!paramDrawerContext) return;
      const ctx = paramDrawerContext;
      const badgeClass =
        ctx.eventType === "page_view" ? "page_view" : ctx.eventType === "click" ? "click" : "other";
      paramDrawerBadgeEl.className = "param-event-badge " + badgeClass;
      paramDrawerBadgeEl.textContent = ctx.eventName || "이벤트";
      paramDrawerLabelEl.textContent = ctx.label || "(이름 없음)";
      const tagPart = ctx.tagIds?.length ? "tag_id " + ctx.tagIds.join(", ") : "";
      const catPart = ctx.category ? " · " + ctx.category : "";
      paramDrawerSubEl.textContent = (tagPart + catPart).replace(/^ · /, "") || "";
      paramToggleJsonBtn.textContent = paramDrawerJsonMode ? "표 보기" : "JSON 보기";
      paramToggleJsonBtn.classList.toggle("active", paramDrawerJsonMode);
      if (paramToggleEditBtn) {
        paramToggleEditBtn.hidden = !ctx.editable;
        paramToggleEditBtn.textContent = paramDrawerEditMode ? "표 보기" : "수정";
        paramToggleEditBtn.classList.toggle("active", paramDrawerEditMode);
      }
      if (paramSaveBtn) paramSaveBtn.hidden = !paramDrawerEditMode || !ctx.editable;
      if (paramToggleJsonBtn) paramToggleJsonBtn.hidden = !!paramDrawerEditMode;
      renderParamDrawerBody();
    }

    async function saveParamDrawerEdits() {
      const ctx = paramDrawerContext;
      if (!ctx?.editable || !devSessionId) return;
      const form = document.getElementById("param-edit-form");
      if (!form) return;
      const fd = new FormData(form);
      const body = {
        session_id: devSessionId,
        page_url: ctx.pageUrl,
        viewport: ctx.pageViewport || viewportMode,
        tag_ids: ctx.tagIds || [],
        page_category: String(fd.get("page_category") || "").trim(),
        action: String(fd.get("action") || "").trim(),
        label: String(fd.get("label") || "").trim(),
        event_name: String(fd.get("event_name") || "").trim(),
        link_url: String(fd.get("link_url") || "").trim(),
        direction: String(fd.get("direction") || "").trim(),
      };
      if (ctx.taxonomyRowKey) {
        body.row_key = ctx.taxonomyRowKey;
        body.trigger = String(fd.get("trigger") || "").trim();
        body.description = String(fd.get("description") || "").trim();
        body.note = String(fd.get("note") || "").trim();
      }
      if (paramSaveBtn) paramSaveBtn.disabled = true;
      try {
        const res = await fetch(
          ctx.taxonomyRowKey ? "/api/dev/taxonomy/rows" : "/api/dev/candidates",
          {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
          }
        );
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "저장 실패");
        }
        if (Array.isArray(data.pages) && data.pages.length) {
          sessionPages = data.pages;
        } else if (data.page) {
          const idx = sessionPages.findIndex(
            (p) =>
              p.page_url === data.page.page_url &&
              (p.active_viewport || "pc") === (data.page.active_viewport || "pc")
          );
          if (idx >= 0) sessionPages[idx] = data.page;
        }
        if (data.selection) mergeSelectionFromServer(data.selection);
        if (data.taxonomy) {
          taxonomyData = normalizeTaxonomyData(data.taxonomy);
          renderTaxonomyView();
        }
        renderSessionTree();
        setStatus(
          ctx.taxonomyRowKey
            ? "택소노미와 연결된 후보 JSON을 함께 저장했습니다."
            : "후보를 저장했습니다. 같은 카/액/라면 그룹이 합쳐집니다.",
          false
        );
        closeParamDrawer();
      } catch (err) {
        setStatus(err.message || "저장 실패", true);
      } finally {
        if (paramSaveBtn) paramSaveBtn.disabled = false;
      }
    }

    function openParamDrawer(context, sourceLi) {
      if (!context) return;
      paramDrawerContext = context;
      paramDrawerSourceKey = context.key;
      paramDrawerOpen = true;
      paramDrawerEditMode = false;
      paramDrawerJsonMode = false;
      if (paramDrawerActiveLi) paramDrawerActiveLi.classList.remove("param-source-active");
      paramDrawerActiveLi = sourceLi || null;
      if (sourceLi) sourceLi.classList.add("param-source-active");
      renderParamDrawer();
      paramDrawerEl.hidden = false;
      paramBackdropEl.hidden = false;
      paramDrawerEl.setAttribute("aria-hidden", "false");
      paramBackdropEl.setAttribute("aria-hidden", "false");
      requestAnimationFrame(() => {
        paramDrawerEl.classList.add("open");
        paramBackdropEl.classList.add("open");
      });
    }

    function closeParamDrawer() {
      paramDrawerOpen = false;
      paramDrawerJsonMode = false;
      paramDrawerEditMode = false;
      paramDrawerContext = null;
      paramDrawerSourceKey = null;
      if (paramDrawerActiveLi) {
        paramDrawerActiveLi.classList.remove("param-source-active");
        paramDrawerActiveLi = null;
      }
      paramDrawerEl.classList.remove("open");
      paramBackdropEl.classList.remove("open");
      paramDrawerEl.setAttribute("aria-hidden", "true");
      paramBackdropEl.setAttribute("aria-hidden", "true");
      window.setTimeout(() => {
        if (!paramDrawerOpen) {
          paramDrawerEl.hidden = true;
          paramBackdropEl.hidden = true;
        }
      }, 260);
    }

    function restoreParamDrawerHighlight() {
      if (!paramDrawerOpen || !paramDrawerSourceKey) return;
      if (paramDrawerActiveLi) paramDrawerActiveLi.classList.remove("param-source-active");
      const el = listEl.querySelector('[data-param-key="' + CSS.escape(paramDrawerSourceKey) + '"]');
      paramDrawerActiveLi = el;
      if (el) el.classList.add("param-source-active");
    }

    function appendParamButton(li, getContext) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "param-btn";
      btn.setAttribute("aria-label", "이벤트 파라미터 보기");
      btn.title = "이벤트 파라미터 보기";
      btn.textContent = "{ }";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const ctx = getContext();
        if (!ctx) {
          setStatus("파라미터 데이터를 찾을 수 없습니다.", true);
          return;
        }
        if (paramDrawerOpen && paramDrawerSourceKey === ctx.key) {
          closeParamDrawer();
          return;
        }
        paramDrawerJsonMode = false;
        openParamDrawer(ctx, li);
      });
      li.appendChild(btn);
    }

    function applyJobResult(data) {
      if (data.session_id) devSessionId = data.session_id;
      if (Array.isArray(data.pages)) {
        if (!sessionPages.length && data.pages.length) treeActionsCollapsedOnce = false;
        sessionPages = data.pages;
      }

      mergeSelectionFromServer(data.selection);

      if (data.taxonomy) taxonomyData = normalizeTaxonomyData(data.taxonomy);

      lastAnalyzedPageUrl =
        data.page_url || data.active_page_url || data.url || lastAnalyzedPageUrl;
      if (data.active_viewport === "mo" || data.active_viewport === "pc") {
        lastAnalyzedViewport = data.active_viewport;
      }
      if (data.url) urlInput.value = data.url;
      if (lastAnalyzedPageUrl) {
        collapsedPages.delete(pageKey(lastAnalyzedPageUrl, lastAnalyzedViewport));
      }

      resetPreviewSelection();

      lastGroups = data.groups || [];
      lastTree = data.tree || null;
      lastCandidateCount = data.candidate_count || 0;
      lastGroupCount = resolveGroupCount(data);
      lastCandidatesByTagId = buildCandidatesMap(data.candidates || []);

      const mode = data.active_viewport === "mo" ? "mo" : "pc";
      setViewportModeUI(mode);

      const capturePage =
        (Array.isArray(data.pages) ? data.pages : sessionPages).find(
          (p) =>
            pageKey(p.page_url, p.active_viewport) ===
            pageKey(lastAnalyzedPageUrl, lastAnalyzedViewport)
        ) || null;
      if (capturePage?.capture_url || data.capture_url) {
        lastCaptureQc = capturePage?.capture_qc ?? data.capture_qc ?? null;
        if (capturePage) showCapturePreview(capturePage);
        else if (data.capture_url) {
          showCapturePreview({
            page_url: lastAnalyzedPageUrl,
            active_viewport: lastAnalyzedViewport,
            capture_url: data.capture_url,
            capture_width: data.capture_width,
            capture_height: data.capture_height,
          });
        }
      }
      updateSelectionSummary();
      maybeStartCaptureWatch();
    }

    function clearPreviewOverlay() {
      if (previewOverlay) previewOverlay.innerHTML = "";
    }

    function previewScaleFactors() {
      const refW = previewImage?.naturalWidth || currentCapturePage?.capture_width || 0;
      const refH = previewImage?.naturalHeight || currentCapturePage?.capture_height || 0;
      const displayW = previewImage?.clientWidth || 0;
      const displayH = previewImage?.clientHeight || 0;
      if (!refW || !refH || !displayW || !displayH) {
        return { scaleX: 1, scaleY: 1, refW, refH };
      }
      return {
        scaleX: displayW / refW,
        scaleY: displayH / refH,
        refW,
        refH,
      };
    }

    function syncPreviewOverlaySize() {
      if (!previewImage || !previewOverlay || !previewStage) return;
      const w = previewImage.clientWidth;
      const h = previewImage.clientHeight;
      if (w <= 0 || h <= 0) return;
      previewStage.style.width = w + "px";
      previewStage.style.height = h + "px";
      previewOverlay.style.width = w + "px";
      previewOverlay.style.height = h + "px";
    }

    function scrollPreviewToBbox(bbox, scaleX, scaleY) {
      if (!previewScroll || !bbox) return;
      const left = bbox.x * scaleX;
      const top = bbox.y * scaleY;
      const width = Math.max(2, bbox.w * scaleX);
      const height = Math.max(2, bbox.h * scaleY);
      const centerX = left + width / 2;
      const centerY = top + height / 2;
      const targetLeft = Math.max(0, centerX - previewScroll.clientWidth / 2);
      const targetTop = Math.max(0, centerY - previewScroll.clientHeight / 2);
      previewScroll.scrollTo({ left: targetLeft, top: targetTop, behavior: "smooth" });
    }

    function scrollPreviewToMembers(members) {
      const list = members || [];
      if (!list.length) return;
      const union = unionOverlayBbox(list);
      const withBox = list.filter((m) => m?.overlay_bbox && m.overlay_bbox.w > 0 && m.overlay_bbox.h > 0);
      const target = union || withBox[0]?.overlay_bbox;
      if (!target) return;
      const run = () => {
        const { scaleX, scaleY } = previewScaleFactors();
        scrollPreviewToBbox(target, scaleX, scaleY);
      };
      requestAnimationFrame(() => {
        run();
        setTimeout(run, 120);
      });
    }

    function unionOverlayBbox(members) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let found = false;
      for (const m of members || []) {
        const b = m?.overlay_bbox;
        if (!b || !(b.w > 0) || !(b.h > 0)) continue;
        found = true;
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w);
        maxY = Math.max(maxY, b.y + b.h);
      }
      if (!found) return null;
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    /**
     * One highlight box per visual target. Multiple DOM hits for the same
     * button/label become a single union bbox that covers them all.
     */
    function collapseMembersToUnionBoxes(members) {
      const withBox = (members || []).filter(
        (m) => m && m.tag_id !== 0 && m.overlay_bbox && m.overlay_bbox.w > 0 && m.overlay_bbox.h > 0
      );
      if (!withBox.length) return [];
      const union = unionOverlayBbox(withBox);
      if (!union) return [];
      return [{ ...withBox[0], overlay_bbox: union }];
    }

    function allPositionMembers(page) {
      if (!page) return [];
      const candidates = new Map((page.candidates || []).map((candidate) => [candidate.tag_id, candidate]));
      return (page.positions || [])
        .filter((position) => position.tag_id > 0 && position.bbox?.w > 0 && position.bbox?.h > 0)
        .map((position) =>
          mergeTagRecord(
            candidates.get(position.tag_id) || {
              tag_id: position.tag_id,
              text: position.text || "",
            },
            position,
            null
          )
        );
    }

    /** Show-all: one union box per label group (not per raw tag_id). */
    function allGroupedPositionMembers(page) {
      if (!page) return [];
      const map = getCandidatesMapForPage(page.page_url, page.active_viewport);
      const filtered = filterTreeByViewport(page.tree, page.active_viewport);
      const groups = [];
      const used = new Set();
      for (const cat of filtered?.categories || []) {
        for (const act of cat.actions || []) {
          if (isPageViewAction(act)) continue;
          for (const lg of act.label_groups || []) {
            const members = (lg.member_tag_ids || [])
              .map((id) => map[id])
              .filter((m) => m && m.overlay_bbox && m.overlay_bbox.w > 0 && m.overlay_bbox.h > 0);
            if (!members.length) continue;
            for (const m of members) used.add(m.tag_id);
            const union = unionOverlayBbox(members);
            if (!union) continue;
            groups.push({
              ...members[0],
              overlay_bbox: union,
              label: lg.display_label || lg.label || members[0].label,
            });
          }
        }
      }
      for (const m of allPositionMembers(page)) {
        if (!used.has(m.tag_id)) groups.push(m);
      }
      return groups;
    }

    function updatePreviewTools(page) {
      const hasPositions = allGroupedPositionMembers(page).length > 0;
      if (previewShowAllBtn) {
        previewShowAllBtn.disabled = !hasPositions;
        previewShowAllBtn.textContent = showAllPreviewPositions
          ? "선택 위치만 표시"
          : "모든 위치 표시";
        previewShowAllBtn.setAttribute(
          "aria-pressed",
          showAllPreviewPositions ? "true" : "false"
        );
      }
    }

    function renderPositionValidationPanel(report) {
      if (!positionValidationPanel) return;
      positionValidationPanel.replaceChildren();
      if (!report) {
        positionValidationPanel.hidden = true;
        return;
      }
      positionValidationPanel.hidden = false;
      const summary = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = report.ok ? "AI 위치 검증 통과 · " : "AI 위치 검증 확인 필요 · ";
      title.className = report.ok ? "ok" : "suspicious";
      summary.appendChild(title);
      summary.append(
        document.createTextNode(
          `${report.checked_count || 0}개 확인 · ${report.summary || ""} · ${report.model || ""}`
        )
      );
      positionValidationPanel.appendChild(summary);

      const issues = Array.isArray(report.issues) ? report.issues : [];
      if (!issues.length) return;
      const list = document.createElement("div");
      list.className = "validation-issues";
      for (const issue of issues) {
        const row = document.createElement("span");
        row.className = `validation-issue ${issue.status === "wrong" ? "wrong" : "suspicious"}`;
        row.textContent = `tag_id ${issue.tag_id} · ${issue.reason}`;
        list.appendChild(row);
      }
      positionValidationPanel.appendChild(list);
    }

    /**
     * Phase 2 (background) capture lifecycle for one candidate.
     * "ready"     → element_capture_url exists (or page_view) — show it.
     * "capturing" → Phase 1 finished but the element PNG isn't ready yet.
     * "unavailable" → capture failed / legacy job with no capture_status.
     */
    function candidateCaptureState(member) {
      if (!member) return "unavailable";
      if (member.tag_id === 0) return "ready";
      if (member.element_capture_url) return "ready";
      const status = member.capture_status;
      if (status === "pending" || status === "capturing") return "capturing";
      if (status === "failed") return "failed";
      // Legacy / in-flight: no dedicated PNG yet but analysis produced a bbox.
      if (!member.no_capture && member.overlay_bbox) return "capturing";
      return "unavailable";
    }

    function resetPreviewEmptyDefault() {
      if (!previewEmpty) return;
      previewEmpty.classList.remove("capturing");
      const icon = previewEmpty.querySelector(".icon");
      const p = previewEmpty.querySelector("p");
      const s = previewEmpty.querySelector("small");
      if (icon) icon.textContent = "🖼";
      if (p) p.textContent = "분석이 완료되면 페이지 캡처가 여기에 표시됩니다.";
      if (s) s.textContent = "요소를 클릭하면 전체 페이지 캡처 위에 위치(주황 박스)가 표시됩니다.";
    }

    function previewPageKeyOf(pageEntry) {
      if (!pageEntry?.page_url) return "";
      const vp = pageEntry.active_viewport === "mo" ? "mo" : "pc";
      return pageKey(pageEntry.page_url, vp);
    }

    /** Full page_view PNG + bbox overlay (canonical pick-step preview). */
    function showPageBBoxPreview(pageEntry, members, opts) {
      opts = opts || {};
      if (window.__TOUR_LOCK_PREVIEW__) return;
      const list = members || lastHighlightMembers || [];
      if (!previewShell || !previewEmpty || !previewImage) return;
      updatePreviewTools(pageEntry);
      renderPositionValidationPanel(positionValidationByPage.get(previewPageKeyOf(pageEntry)) || null);

      if (!pageEntry?.capture_url) {
        // Do not keep the previous page's PNG when this page has no capture.
        currentCapturePage = pageEntry || null;
        previewImage.dataset.captureBase = "";
        previewImage.dataset.pageKey = previewPageKeyOf(pageEntry);
        clearPreviewOverlay();
        if (opts.capturing && list[0]) {
          showCapturingPreview(list[0], pageEntry);
          return;
        }
        previewShell.hidden = true;
        previewEmpty.hidden = false;
        previewEmpty.classList.remove("capturing");
        const p = previewEmpty.querySelector("p");
        const s = previewEmpty.querySelector("small");
        if (p) p.textContent = "이 페이지의 스크린샷이 없습니다.";
        if (s) s.textContent = "다른 페이지 그림이 남지 않도록 비웠습니다.";
        return;
      }

      currentPreviewMode = "page";
      currentCapturePage = pageEntry;
      syncPreviewShellForPage(pageEntry);
      resetPreviewEmptyDefault();
      previewEmpty.hidden = true;
      previewShell.hidden = false;
      clearPreviewOverlay();

      const nextKey = previewPageKeyOf(pageEntry);
      const baseUrl = pageEntry.capture_url;

      const paintHighlights = () => {
        if (previewPageKeyOf(currentCapturePage) !== nextKey) return;
        syncPreviewOverlaySize();
        // Draw boxes without scrolling; one settled scroll path avoids competing smooth-scrolls.
        redrawCaptureHighlights(list, { ...opts, skipScroll: true });
        if (!opts.showAll) scrollPreviewToMembers(list);
        if (layoutHintEl && !previewShell.hidden) {
          layoutHintEl.hidden = false;
          const nw = previewImage.naturalWidth || 0;
          const nh = previewImage.naturalHeight || 0;
          layoutHintEl.textContent =
            "전체 캡처 " + nw + "×" + nh + " · positions.json 좌표";
          layoutHintEl.className = "layout-hint ok";
        }
      };

      previewImage.onload = () => {
        if (previewPageKeyOf(currentCapturePage) !== nextKey) return;
        paintHighlights();
      };
      previewImage.onerror = () => {
        if (previewPageKeyOf(currentCapturePage) !== nextKey) return;
        setStatus("페이지 스크린샷을 불러오지 못했습니다.", true);
      };

      // Same PAGE (url+viewport) + same capture file → reuse. Different page
      // must always swap the background — even if a stale dataset.captureBase
      // still points at the previous file after showCapturePreview.
      const samePage =
        previewImage.dataset.pageKey === nextKey &&
        previewImage.dataset.captureBase === baseUrl &&
        previewImage.complete &&
        previewImage.naturalWidth > 0;
      previewImage.dataset.pageKey = nextKey;
      previewImage.dataset.captureBase = baseUrl;
      if (samePage) {
        requestAnimationFrame(paintHighlights);
      } else {
        if (previewScroll) previewScroll.scrollTo({ top: 0, behavior: "instant" });
        const url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "_t=" + Date.now();
        previewImage.src = url;
      }
      startPreviewResizeObserver();
    }

    /** Phase 1 candidate picked, Phase 2 element PNG still capturing in the background. */
    function showCapturingPreview(member, pageEntry) {
      const page =
        pageEntry ||
        (member ? findSessionPage(lastAnalyzedPageUrl, lastAnalyzedViewport) : null);
      if (page?.capture_url) {
        showPageBBoxPreview(page, member ? [member] : lastHighlightMembers, { capturing: true });
        return;
      }
      if (!previewShell || !previewEmpty) return;
      currentPreviewMode = "capturing";
      currentCapturePage = null;
      previewShell.hidden = true;
      previewEmpty.hidden = false;
      previewEmpty.classList.add("capturing");
      const icon = previewEmpty.querySelector(".icon");
      const p = previewEmpty.querySelector("p");
      const s = previewEmpty.querySelector("small");
      if (icon) icon.textContent = "⏳";
      if (p) p.textContent = "이미지 캡쳐중...";
      if (s) {
        s.textContent =
          "백그라운드에서 요소 캡처(tag_id " +
          (member?.tag_id ?? "") +
          ")를 생성하고 있습니다. 완료되면 자동으로 표시됩니다.";
      }
      startCaptureWatch();
    }

    function sessionHasPendingCaptures() {
      for (const page of sessionPages) {
        for (const c of page.candidates || []) {
          if (candidateCaptureState(c) === "capturing") return true;
        }
      }
      for (const tagId in lastCandidatesByTagId) {
        if (candidateCaptureState(lastCandidatesByTagId[tagId]) === "capturing") return true;
      }
      return false;
    }

    function maybeStartCaptureWatch() {
      if (sessionHasPendingCaptures()) startCaptureWatch();
      else stopCaptureWatch();
    }

    let lastCaptureWatchSig = "";

    function captureWatchSig() {
      let sig = "";
      for (const page of sessionPages) {
        sig += page.job_id || "";
        for (const c of page.candidates || []) {
          sig += "|" + c.tag_id + ":" + (c.capture_status || "");
        }
      }
      return sig;
    }

    function startCaptureWatch() {
      if (captureWatchTimer) return;
      captureWatchTimer = setInterval(() => {
        void refreshPendingCaptures();
      }, 2500);
    }

    function stopCaptureWatch() {
      if (captureWatchTimer) {
        clearInterval(captureWatchTimer);
        captureWatchTimer = null;
      }
      lastCaptureWatchSig = "";
    }

    function restoreSelectionAfterRefresh() {
      if (lastHighlightTagId == null || !lastHighlightMembers?.length) return;
      const li =
        listEl.querySelector('[data-tag-id="' + lastHighlightTagId + '"]') ||
        selectedLi;
      if (li) {
        if (selectedLi && selectedLi !== li) selectedLi.classList.remove("selected");
        selectedLi = li;
        li.classList.add("selected");
      }
      const pageEntry = findSessionPage(lastAnalyzedPageUrl, lastAnalyzedViewport);
      if (pageEntry?.capture_url) {
        showPageBBoxPreview(pageEntry, lastHighlightMembers, {
          capturing: lastHighlightMembers.some(
            (m) => candidateCaptureState(m) === "capturing"
          ),
        });
      }
    }

    async function refreshPendingCaptures() {
      if (!devSessionId) {
        stopCaptureWatch();
        return;
      }
      try {
        const res = await fetch("/api/dev/sessions/" + encodeURIComponent(devSessionId));
        const data = await res.json();
        if (!res.ok || !data.ok) return;
        sessionPages = data.pages || [];

        // Phase 2 patches the job store live; session cache may lag until
        // batch re-sync — pull lite capture fields from each in-flight job.
        for (const page of sessionPages) {
          if (!page.job_id) continue;
          const hasPending = (page.candidates || []).some(
            (c) => candidateCaptureState(c) === "capturing"
          );
          if (!hasPending) continue;
          try {
            const jobRes = await fetch(
              "/api/dev/jobs/" + encodeURIComponent(page.job_id) + "/progress?lite=1"
            );
            const jobData = await jobRes.json();
            if (jobRes.ok && jobData.ok && Array.isArray(jobData.candidates)) {
              const byId = new Map(jobData.candidates.map((c) => [c.tag_id, c]));
              page.candidates = (page.candidates || []).map((c) => {
                const live = byId.get(c.tag_id);
                if (!live) return c;
                return {
                  ...c,
                  capture_status: live.capture_status ?? c.capture_status,
                  capture_error: live.capture_error ?? c.capture_error,
                  overlay_bbox: live.overlay_bbox ?? c.overlay_bbox,
                  element_capture_url: live.element_capture_url ?? c.element_capture_url,
                };
              });
              const posMap = buildPositionsMap(page.positions);
              page.candidates = page.candidates.map((c) =>
                mergeTagRecord(c, posMap[c.tag_id], null)
              );
            }
          } catch {
            /* job poll is best-effort */
          }
        }

        const current = findSessionPage(lastAnalyzedPageUrl, lastAnalyzedViewport);
        if (current?.candidates?.length) {
          lastCandidatesByTagId = getCandidatesMapForPage(
            current.page_url,
            current.active_viewport
          );
          lastTree = current.tree || lastTree;
          // Remap highlights from THIS page only — tag_id can collide across pages.
          if (lastHighlightMembers?.length) {
            const map = lastCandidatesByTagId;
            lastHighlightMembers = lastHighlightMembers.map((m) => map[m.tag_id] || m);
          }
        }

        const sig = captureWatchSig();
        if (sig === lastCaptureWatchSig) {
          if (!sessionHasPendingCaptures()) stopCaptureWatch();
          return;
        }
        lastCaptureWatchSig = sig;

        // Keep preview on the page the user last clicked (not session[0]).
        restoreSelectionAfterRefresh();

        if (!sessionHasPendingCaptures()) stopCaptureWatch();
      } catch {
        /* transient — try again on next tick */
      }
    }

    function previewUnavailableMessage(member) {
      if (!member) return "미리보기에 표시할 수 없습니다";
      if (member.tag_id === 0) {
        return "페이지뷰 이벤트 — 화면상 특정 영역이 없습니다";
      }
      if (candidateCaptureState(member) === "capturing") {
        return "이미지 캡쳐중...";
      }
      if (!member.overlay_bbox) {
        return "태깅·캡처 모두에서 위치를 확인하지 못했습니다";
      }
      if (member.menu_reveal_path?.length && member.capture_found === false) {
        return "메뉴·팝업이 닫힌 캡처 — 태깅 시점 좌표로 표시합니다";
      }
      const reason = member.hidden_reason;
      if (reason === "display_none") {
        return "display:none 상태라 캡처 화면에 나타나지 않습니다";
      }
      if (reason === "visibility_hidden") {
        return "visibility:hidden 상태라 캡처에 보이지 않습니다";
      }
      if (reason === "opacity_zero") {
        return "투명(opacity:0) 요소라 캡처에서 확인할 수 없습니다";
      }
      if (reason === "zero_size") {
        return "크기가 0인 요소라 위치를 표시할 수 없습니다";
      }
      if (member.capture_status === "failed" || member.no_capture) {
        return "요소 전용 캡처를 만들지 못했습니다. 페이지 캡처 위 태깅 좌표로 표시합니다.";
      }
      if (!member.element_capture_url) {
        return "요소 캡처를 준비 중입니다.";
      }
      return "미리보기에 표시할 수 없습니다";
    }

    function enrichHighlightMembers(members, pageUrl, preferViewport) {
      const page = pageUrl ? findSessionPage(pageUrl, preferViewport ?? viewportMode) : null;
      return (members || []).map((m) => resolveTagRecord(pageUrl, m.tag_id, page?.active_viewport, m));
    }

    function showElementCapturePreview(url) {
      if (!previewShell || !previewEmpty || !previewImage) return;
      if (!url) {
        previewShell.hidden = true;
        previewEmpty.hidden = false;
        return;
      }

      currentPreviewMode = "element";
      resetPreviewEmptyDefault();
      previewEmpty.hidden = true;
      previewShell.hidden = false;
      if (previewMessage) previewMessage.hidden = true;
      clearPreviewOverlay();
      if (previewScroll) previewScroll.scrollTo({ top: 0, behavior: "instant" });

      previewImage.onload = () => {
        syncPreviewOverlaySize();
        if (layoutHintEl && !previewShell.hidden) {
          layoutHintEl.hidden = false;
          layoutHintEl.textContent =
            "요소 캡처 " +
            (previewImage.naturalWidth || 0) +
            "×" +
            (previewImage.naturalHeight || 0) +
            " · bbox 포함";
          layoutHintEl.className = "layout-hint ok";
        }
      };
      previewImage.onerror = () => {
        const pending = lastHighlightMembers?.[0];
        if (pending && candidateCaptureState(pending) === "capturing") {
          showCapturingPreview(pending);
          return;
        }
        if (currentCapturePage?.capture_url) {
          showCapturePreview(currentCapturePage);
          redrawCaptureHighlights(lastHighlightMembers || []);
        }
        const msg = previewUnavailableMessage(pending);
        setBadge("done", "표시 불가");
        setStatus(`tag_id ${pending?.tag_id ?? ""} — ${msg}`, false);
      };
      previewImage.src = url + (url.includes("?") ? "&" : "?") + "_t=" + Date.now();
      startPreviewResizeObserver();
    }

    function showCapturePreview(page) {
      if (!previewShell || !previewEmpty) return;
      updatePreviewTools(page);
      renderPositionValidationPanel(positionValidationByPage.get(previewPageKeyOf(page)) || null);
      const url = page?.capture_url;
      if (!url) {
        previewShell.hidden = true;
        previewEmpty.hidden = false;
        previewEmpty.classList.remove("capturing");
        const icon = previewEmpty.querySelector(".icon");
        const p = previewEmpty.querySelector("p");
        const s = previewEmpty.querySelector("small");
        if (icon) icon.textContent = "🖼";
        if (p) p.textContent = "이 페이지의 스크린샷이 없습니다.";
        if (s) s.textContent = "다시 분석하면 page_view 캡처가 생성됩니다.";
        currentCapturePage = null;
        if (previewImage) {
          previewImage.dataset.captureBase = "";
          previewImage.dataset.pageKey = "";
        }
        return;
      }

      // Default: draw every label-group as one encompassing box (no tag numbers).
      const allMembers = allGroupedPositionMembers(page);
      if (showAllPreviewPositions && allMembers.length) {
        showPageBBoxPreview(page, allMembers, {
          showAll: true,
          statusMsg: `전체 ${allMembers.length}개 위치 표시`,
        });
        return;
      }

      currentPreviewMode = "page";
      currentCapturePage = page;
      syncPreviewShellForPage(page);
      resetPreviewEmptyDefault();
      previewEmpty.hidden = true;
      previewShell.hidden = false;
      if (previewMessage) previewMessage.hidden = true;
      clearPreviewOverlay();

      const nextKey = previewPageKeyOf(page);
      const samePage =
        previewImage.dataset.pageKey === nextKey &&
        previewImage.dataset.captureBase === url &&
        previewImage.complete &&
        previewImage.naturalWidth > 0;

      previewImage.dataset.pageKey = nextKey;
      previewImage.dataset.captureBase = url;
      previewImage.onload = () => {
        if (previewPageKeyOf(currentCapturePage) !== nextKey) return;
        syncPreviewOverlaySize();
        if (previewScroll) previewScroll.scrollTo({ top: 0, behavior: "instant" });
        if (layoutHintEl && !previewShell.hidden) {
          layoutHintEl.hidden = false;
          layoutHintEl.textContent =
            "page_view " +
            (previewImage.naturalWidth || 0) +
            "×" +
            (previewImage.naturalHeight || 0);
          layoutHintEl.className = "layout-hint ok";
        }
      };
      if (samePage) {
        requestAnimationFrame(() => {
          if (previewPageKeyOf(currentCapturePage) !== nextKey) return;
          syncPreviewOverlaySize();
          if (previewScroll) previewScroll.scrollTo({ top: 0, behavior: "instant" });
        });
      } else {
        if (previewScroll) previewScroll.scrollTo({ top: 0, behavior: "instant" });
        previewImage.src = url + (url.includes("?") ? "&" : "?") + "_t=" + Date.now();
      }
      startPreviewResizeObserver();
    }

    /** Full-page overlay from positions.json — never crop element PNG in pick UI. */
    function redrawCaptureHighlights(members, opts) {
      opts = opts || {};
      // Tutorial sample preview owns the overlay — do not repaint live boxes on top.
      if (window.__TOUR_LOCK_PREVIEW__) return;
      if (currentPreviewMode !== "page") return;
      if (!previewOverlay || !previewImage) return;
      syncPreviewOverlaySize();
      const { scaleX, scaleY, refW, refH } = previewScaleFactors();
      if (!refW || !refH) return;

      clearPreviewOverlay();
      if (previewMessage) previewMessage.hidden = true;

      let drew = 0;
      let scrollTarget = null;
      const primary = members?.[0];
      const report = positionValidationByPage.get(previewPageKeyOf(currentCapturePage));
      const issueByTagId = new Map((report?.issues || []).map((issue) => [issue.tag_id, issue]));

      if (primary?.tag_id === 0) {
        if (previewScroll) previewScroll.scrollTo({ top: 0, behavior: "smooth" });
        if (previewMessage) {
          previewMessage.hidden = false;
          previewMessage.textContent = previewUnavailableMessage(primary);
        }
        return;
      }

      // Selection highlight: members of one label group → one encompassing box.
      // Show-all already passes pre-collapsed per-group members.
      const paintList = opts.showAll
        ? (members || []).filter(
            (m) => m && m.tag_id !== 0 && m.overlay_bbox && m.overlay_bbox.w > 0
          )
        : collapseMembersToUnionBoxes(members);

      for (const m of paintList) {
        if (m.tag_id === 0 || !m.overlay_bbox) continue;
        const b = m.overlay_bbox;
        const box = document.createElement("div");
        const issue = issueByTagId.get(m.tag_id);
        let validationClass = "";
        if (issue) validationClass = ` validation-${issue.status}`;
        else if (report && opts.showAll) validationClass = " validation-ok";
        else if (opts.showAll) validationClass = " show-all";
        box.className =
          "preview-highlight-box" +
          (opts.capturing ? " capturing" : "") +
          validationClass;
        box.style.left = b.x * scaleX + "px";
        box.style.top = b.y * scaleY + "px";
        box.style.width = Math.max(2, b.w * scaleX) + "px";
        box.style.height = Math.max(2, b.h * scaleY) + "px";
        previewOverlay.appendChild(box);
        if (!scrollTarget) scrollTarget = b;
        drew += 1;
      }

      if (opts.capturing && previewMessage) {
        previewMessage.hidden = false;
        previewMessage.textContent = "이미지 캡쳐중... · 전체 페이지 위치 표시";
      } else if (drew && opts.statusMsg && previewMessage) {
        previewMessage.hidden = false;
        previewMessage.textContent = opts.statusMsg;
      }

      if (!drew) {
        if (previewMessage) {
          previewMessage.hidden = false;
          previewMessage.textContent = previewUnavailableMessage(primary);
        }
        return;
      }

      if (!opts.showAll && !opts.skipScroll) {
        scrollPreviewToBbox(scrollTarget, scaleX, scaleY);
      }
    }

    function setShowAllPositions(enabled) {
      const page = currentCapturePage;
      const members = allGroupedPositionMembers(page);
      if (!page || !members.length) return;
      showAllPreviewPositions = Boolean(enabled);
      if (previewShowAllBtn) {
        previewShowAllBtn.textContent = showAllPreviewPositions ? "선택 위치만 표시" : "모든 위치 표시";
      }
      if (showAllPreviewPositions) {
        showPageBBoxPreview(page, members, {
          showAll: true,
          statusMsg: `전체 ${members.length}개 위치 표시`,
        });
      } else if (lastHighlightMembers?.length) {
        showPageBBoxPreview(page, lastHighlightMembers);
      } else {
        showCapturePreview(page);
      }
    }

    async function validateCurrentPagePositions() {
      const page = currentCapturePage;
      if (!devSessionId || !page?.job_id) {
        setStatus("검증할 프로젝트 분석 페이지를 먼저 선택하세요.", true);
        return;
      }
      const members = allPositionMembers(page);
      if (!members.length) {
        setStatus("검증할 위치 데이터가 없습니다.", true);
        return;
      }
      if (previewValidateBtn) {
        previewValidateBtn.disabled = true;
        previewValidateBtn.textContent = "AI 검증 중…";
      }
      setShowAllPositions(true);
      if (positionValidationPanel) {
        positionValidationPanel.hidden = false;
        positionValidationPanel.textContent = `전체 ${members.length}개 박스를 표시했습니다. AI가 캡처와 위치를 비교하는 중입니다…`;
      }
      try {
        const res = await fetch("/api/dev/positions/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: devSessionId,
            job_id: page.job_id,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok || !data.report) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        positionValidationByPage.set(previewPageKeyOf(page), data.report);
        renderPositionValidationPanel(data.report);
        showPageBBoxPreview(page, members, {
          showAll: true,
          statusMsg: data.report.ok
            ? `AI 검증 완료 · ${data.report.checked_count}개 정상`
            : `AI 검증 완료 · ${data.report.issues?.length || 0}개 확인 필요`,
        });
        setStatus(
          data.report.ok
            ? `AI 위치 검증 완료 — ${data.report.checked_count}개 박스에서 뚜렷한 이상이 없습니다.`
            : `AI 위치 검증 완료 — ${data.report.issues?.length || 0}개 박스를 확인하세요.`,
          false
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (positionValidationPanel) {
          positionValidationPanel.hidden = false;
          positionValidationPanel.textContent = `AI 위치 검증 실패: ${message}`;
        }
        setStatus(`AI 위치 검증 실패: ${message}`, true);
      } finally {
        if (previewValidateBtn) {
          previewValidateBtn.disabled = false;
          previewValidateBtn.textContent = "AI 위치 검증";
        }
      }
    }

    function schedulePreviewLayout(_source) {
      requestAnimationFrame(() => {
        syncPreviewOverlaySize();
        if (showAllPreviewPositions && currentCapturePage && currentPreviewMode === "page") {
          redrawCaptureHighlights(allGroupedPositionMembers(currentCapturePage), {
            showAll: true,
            skipScroll: true,
          });
        } else if (lastHighlightMembers?.length && currentPreviewMode === "page") {
          redrawCaptureHighlights(lastHighlightMembers, { skipScroll: true });
        }
      });
    }

    function startPreviewResizeObserver() {
      if (typeof ResizeObserver === "undefined" || !previewShell) return;
      if (!previewResizeObserver) {
        previewResizeObserver = new ResizeObserver(() => schedulePreviewLayout("resize"));
        previewResizeObserver.observe(previewShell);
      }
    }

    function getPreviewPanelSize() {
      const body = document.querySelector(".live-card .card-body");
      const w = previewShell?.clientWidth ?? body?.clientWidth ?? 0;
      const h = previewShell?.clientHeight ?? body?.clientHeight ?? 0;
      return {
        panel_width: w > 0 ? Math.round(w) : undefined,
        panel_height: h > 0 ? Math.round(h) : undefined,
      };
    }

    /** @deprecated live stream layout — kept as no-op for compat callers */
    let dprMediaQuery = null;

    function scheduleLayoutReflow(source) {
      schedulePreviewLayout(source || "reflow");
    }

    function scheduleLayoutMeasure(label) {
      schedulePreviewLayout(label || "measure");
    }

    function applyLiveFrameLayout() {
      return null;
    }

    function measureLayout() {
      return null;
    }

    function getLivePanelSize() {
      return getPreviewPanelSize();
    }

    /** @deprecated */
    function startLiveShellResizeObserver() {
      startPreviewResizeObserver();
    }

    function onViewOnlyFrameLoad() {
      schedulePreviewLayout("viewonly");
    }

    function onDevicePixelRatioChange() {
      watchDevicePixelRatio();
      scheduleLayoutReflow("dpr");
    }

    function watchDevicePixelRatio() {
      if (typeof window.matchMedia !== "function") return;
      const dppx = window.devicePixelRatio || 1;
      if (dprMediaQuery) {
        dprMediaQuery.removeEventListener("change", onDevicePixelRatioChange);
      }
      dprMediaQuery = window.matchMedia("(resolution: " + dppx + "dppx)");
      dprMediaQuery.addEventListener("change", onDevicePixelRatioChange);
    }

    function initLiveLayoutListeners() {
      startPreviewResizeObserver();
      watchDevicePixelRatio();
      window.addEventListener("resize", () => schedulePreviewLayout("window-resize"));
      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", () =>
          schedulePreviewLayout("visual-viewport")
        );
      }
    }

    async function showViewOnlyLayout() {
      const url = urlInput.value.trim();
      if (!url) {
        setBadge("error", "오류");
        setStatus("URL을 입력하세요.", true);
        return;
      }

      viewOnlyBtn.disabled = true;
      setModeButtonsEnabled(false);
      stopPolling();
      activeJobId = null;
      lastGroups = [];
      lastTree = null;
      setBadge("progress", "여는 중");
      setStatus(
        "Live view 여는 중 — " +
          (viewportMode === "mo" ? "MO" : "PC") +
          " · LLM/태깅 없음"
      );
      showProgress(false);
      liveShell.hidden = true;
      liveEmpty.hidden = false;
      liveEmpty.querySelector("p").textContent = "Firecrawl live view를 여는 중…";
      liveEmpty.querySelector("small").textContent = "분석·태깅·LLM은 실행하지 않습니다.";

      try {
        const res = await fetch("/api/dev/view-only", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url,
            viewport: viewportMode,
            session_id: devSessionId,
            ...getLivePanelSize(),
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "HTTP " + res.status);
        }

        if (data.session_id) devSessionId = data.session_id;
        if (data.job_id) activeJobId = data.job_id;

        liveViewSession = data.live_view_session || null;
        listEl.innerHTML =
          '<li class="empty">화면만 보기 — live view만 표시 중 (추출·태깅 없음)</li>';
        countEl.textContent = "";

        if (!data.live_view_url) {
          throw new Error("live view URL을 받지 못했습니다.");
        }

        showLiveView(data.live_view_url);
        startLiveViewMonitor();
        setBadge("done", "Live view");
        setStatus("Live view 연결됨 · " + url + " · LLM/태깅 없음");
        scheduleLayoutMeasure("viewonly");
        void refreshCredits();
      } catch (err) {
        setBadge("error", "실패");
        setStatus(err.message || "Live view를 열 수 없습니다.", true);
        layoutHintEl.hidden = true;
        liveShell.hidden = true;
        liveEmpty.hidden = false;
        liveEmpty.querySelector("p").textContent = "Live view를 열지 못했습니다.";
        liveEmpty.querySelector("small").textContent = err.message || "";
      } finally {
        viewOnlyBtn.disabled = false;
        setModeButtonsEnabled(true);
      }
    }

    function measureLiveViewSize(label) {
      return measureLayout(label);
    }

    window.addEventListener("load", () => {
      initLiveLayoutListeners();
      scheduleLayoutReflow("load");
    });

    function stopLiveViewMonitor() {}
    function startLiveViewMonitor() {}
    function hideLiveViewExpired() {}
    function showLiveViewExpired() {}
    async function reconnectLiveView() {}
    function refreshLiveFrame() {}

    if (liveReconnectBtn) {
      liveReconnectBtn.addEventListener("click", () => void reconnectLiveView());
    }
    if (liveReanalyzeBtn) {
      liveReanalyzeBtn.addEventListener("click", () => analyzeBtn.click());
    }

    if (viewOnlyBtn) viewOnlyBtn.addEventListener("click", () => void showViewOnlyLayout());

    function formatUsd(n) {
      return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    async function refreshCredits() {
      creditsFirecrawlEl.className = "credits-badge";
      creditsLlmEl.className = "credits-badge";
      creditsFirecrawlEl.textContent = "Firecrawl: …";
      creditsLlmEl.textContent = "LLM: …";
      try {
        const res = await fetch("/api/dev/credits");
        const data = await res.json();

        const fc = data.firecrawl?.remaining ?? data.remaining;
        const keyCount = data.firecrawl?.key_count ?? data.firecrawl?.pool?.key_count;
        if (fc == null) {
          creditsFirecrawlEl.textContent = "Firecrawl: 조회 실패";
          creditsFirecrawlEl.className = "credits-badge error";
        } else {
          const n = Number(fc);
          const poolLabel =
            keyCount != null && Number(keyCount) >= 1
              ? ` (${Number(keyCount)}키 합계)`
              : "";
          creditsFirecrawlEl.textContent = "Firecrawl: " + n.toLocaleString() + poolLabel;
          if (Number.isFinite(n) && n <= 50) {
            creditsFirecrawlEl.className = "credits-badge low";
          }
        }

        const llm = data.llm;
        if (!llm) {
          creditsLlmEl.textContent = "LLM: —";
          return;
        }

        const providerLabel =
          llm.provider === "openrouter"
            ? "OpenRouter"
            : llm.provider === "gemini"
              ? "Gemini"
              : "미설정";

        if (llm.remaining != null && Number.isFinite(Number(llm.remaining))) {
          const rem = Number(llm.remaining);
          const suffix = llm.source === "key" ? " (키 한도)" : "";
          creditsLlmEl.textContent = `LLM ${providerLabel}: ${formatUsd(rem)} 남음${suffix}`;
          if (rem <= 5) creditsLlmEl.className = "credits-badge low";
        } else if (llm.total_usage != null && Number.isFinite(Number(llm.total_usage))) {
          creditsLlmEl.textContent =
            `LLM ${providerLabel}: 사용 ${formatUsd(Number(llm.total_usage))}` +
            (llm.usage_daily != null ? ` · 오늘 ${formatUsd(Number(llm.usage_daily))}` : "");
        } else if (llm.provider === "gemini") {
          creditsLlmEl.textContent = "LLM Gemini · 잔액 조회 없음";
        } else {
          creditsLlmEl.textContent = `LLM ${providerLabel}: 조회 불가`;
          creditsLlmEl.className = "credits-badge error";
        }
      } catch {
        creditsFirecrawlEl.textContent = "Firecrawl: 조회 실패";
        creditsFirecrawlEl.className = "credits-badge error";
        creditsLlmEl.textContent = "LLM: 조회 실패";
        creditsLlmEl.className = "credits-badge error";
      }
    }

    refreshCredits();

    async function switchViewport(mode) {
      if (!activeJobId) return false;
      if (viewportMode === mode && (lastTree || lastGroups.length)) {
        return true;
      }

      const fromMode = viewportMode;
      const switchRun = (async () => {
        stopPolling();
        pendingSwitchMode = mode;
        setModeButtonsEnabled(false);
        setViewportModeUI(mode);
        showSkeleton();
        countEl.textContent = (mode === "mo" ? "MO" : "PC") + " 태깅 중…";
        setBadge("progress", mode === "mo" ? "MO 전환" : "PC 전환");
        setStatus((mode === "mo" ? "MO" : "PC") + " 화면 전환 및 태깅 중…");
        showProgress(true);
        updateProgress({ stage_label: "화면 전환 중", percent: 5, progress: { current: 0, total: 1 } });

        const res = await fetch("/api/dev/switch-viewport", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "화면 전환 실패");
        }

        if (data.cached) {
          showProgress(false);
          applyJobResult(data);
          setBadge("done", "완료");
          setStatus(
            (mode === "mo" ? "MO" : "PC") +
              " · " + formatLabelCount(resolveGroupCount(data)) +
              (data.cached ? " (캐시 — LLM·재태깅 없음, 브라우저만 전환)" : "")
          );
          return true;
        }

        if (data.started && data.job_id) {
          return await new Promise((resolve, reject) => {
            pollJobProgress(data.job_id, {
              targetMode: mode,
              onDone: (result) => {
                applyJobResult(result);
                if (result.switch_error) {
                  setBadge("error", "전환 실패");
                  setStatus(
                    (mode === "mo" ? "MO" : "PC") +
                      " 전환 실패 — " +
                      (result.active_viewport === "mo" ? "MO" : "PC") +
                      "로 복원됨: " +
                      result.switch_error,
                    true
                  );
                } else {
                  setBadge("done", "완료");
                  setStatus(
                    (mode === "mo" ? "MO" : "PC") +
                      " · " +
                      formatLabelCount(resolveGroupCount(result))
                  );
                }
                resolve(true);
              },
              onFail: (err) => reject(err),
            });
          });
        }

        return true;
      })();

      viewportSwitchPromise = switchRun;

      try {
        return await switchRun;
      } catch (err) {
        if (viewportSwitchPromise !== switchRun) return false;
        setBadge("error", "전환 실패");
        setStatus(err.message || "화면 전환 실패", true);
        showProgress(false);
        if (pendingSwitchMode) {
          setViewportModeUI(fromMode);
          rerenderTree();
          if (lastLiveViewUrl) refreshLiveFrame(lastLiveViewUrl);
        }
        return false;
      } finally {
        if (viewportSwitchPromise === switchRun) {
          pendingSwitchMode = null;
          viewportSwitchPromise = null;
          setModeButtonsEnabled(true);
          analyzeBtn.disabled = false;
        }
      }
    }

    if (modePcBtn) modePcBtn.addEventListener("click", () => onModeButtonClick("pc"));
    if (modeMoBtn) modeMoBtn.addEventListener("click", () => onModeButtonClick("mo"));

    setViewportModeUI("pc");

    function setBadge(kind, label) {
      if (!badgeEl) return;
      badgeEl.className = "badge " + kind;
      badgeEl.textContent = label;
    }

    function setStatus(text, isError) {
      if (!statusText) return;
      statusText.textContent = text;
      statusText.className = isError ? "error" : "";
      if (typeof window.__WIZARD_ON_STATUS__ === "function") {
        window.__WIZARD_ON_STATUS__(text, isError);
      }
    }

    function resetPreviewSelection() {
      lastHighlightMembers = null;
      selectedLi = null;
      clearPreviewOverlay();
      if (previewScroll) previewScroll.scrollTo({ top: 0, behavior: "instant" });
    }

    function showProgress(show) {
      if (!progressWrap) return;
      progressWrap.hidden = false;
      progressWrap.classList.toggle("is-active", !!show);
      progressWrap.setAttribute("aria-hidden", show ? "false" : "true");
    }

    function updateProgress(data) {
      const pct = Number(data.percent) || 0;
      if (progressStage) progressStage.textContent = data.stage_label || "진행 중";
      if (progressPercent) progressPercent.textContent = pct + "%";
      if (progressFill) progressFill.style.width = pct + "%";
      if (progressBar) progressBar.setAttribute("aria-valuenow", String(pct));

      if (data.stage === "naming" && data.progress) {
        if (progressDetail) progressDetail.textContent =
          "배치 " + data.progress.current + "/" + data.progress.total;
      } else if (data.progress && data.progress.total > 1) {
        if (progressDetail) progressDetail.textContent =
          data.progress.current + " / " + data.progress.total;
      } else {
        if (progressDetail) progressDetail.textContent = "";
      }

      setStatus(data.stage_label || "분석 진행 중…");
      if (typeof window.__WIZARD_ON_PROGRESS__ === "function") {
        window.__WIZARD_ON_PROGRESS__(pct);
      }
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function pollJobProgress(jobId, opts = {}) {
      stopPolling();
      activeJobId = jobId;
      showProgress(true);
      updateProgress({ stage_label: "분석 시작", percent: 0, progress: { current: 0, total: 1 } });

      const tick = async () => {
        try {
          const res = await fetch("/api/dev/jobs/" + encodeURIComponent(jobId) + "/progress");
          const data = await res.json();
          if (!res.ok || !data.ok) {
            throw new Error(data.error || "progress poll failed");
          }

          updateProgress(data);

          if (data.stage === "done") {
            stopPolling();
            showProgress(false);
            if (opts.onDone) {
              opts.onDone(data);
            } else {
              applyJobResult(data);
              ensureCapturePreview();
              setBadge("done", "완료");
              const llmLabel = data.llm_source ? " · LLM " + data.llm_source : "";
              setStatus(
                (data.active_viewport === "mo" ? "MO" : "PC") +
                  " · " +
                  formatLabelCount(resolveGroupCount(data)) +
                  (data.capture_url ? " · 캡처 준비됨" : "") +
                  llmLabel
              );
              analyzeBtn.disabled = false;
              setModeButtonsEnabled(true);
              refreshCredits();
            }
          } else if (data.stage === "failed") {
            stopPolling();
            showProgress(false);
            if (opts.onFail) {
              opts.onFail(new Error(data.error || "실패"));
            } else {
          renderSessionTree();
              setBadge("error", "실패");
              setStatus(data.error || "분석 실패", true);
              liveShell.hidden = true;
              liveEmpty.hidden = false;
              liveEmpty.querySelector("p").textContent = "분석에 실패했습니다.";
              liveEmpty.querySelector("small").textContent = data.error || "";
              analyzeBtn.disabled = false;
              setModeButtonsEnabled(true);
              refreshCredits();
            }
          }
        } catch (err) {
          stopPolling();
          showProgress(false);
          if (opts.onFail) {
            opts.onFail(err);
          } else {
            setBadge("error", "실패");
            setStatus(err.message, true);
            analyzeBtn.disabled = false;
            setModeButtonsEnabled(true);
            refreshCredits();
          }
        }
      };

      void tick();
      pollTimer = setInterval(tick, 1000);
    }

    function showSkeleton() {
      listEl.innerHTML =
        '<li class="skeleton-list" aria-hidden="true">' +
        '<div class="skeleton-row"></div>'.repeat(5) +
        "</li>";
      countEl.textContent = "";
    }

    function candidateToMember(c) {
      return {
        tag_id: c.tag_id,
        candidate_id: c.candidate_id,
        label: c.label,
        text: c.text,
        category: c.category,
        action: c.action,
        event_name: c.event_name,
        selector_hint: c.selector_hint,
        selectors_fallback: c.selectors_fallback || [],
        overlay_bbox: c.overlay_bbox,
        platform: c.platform,
        hidden_reason: c.hidden_reason,
        no_capture: c.no_capture,
        capture_found: c.capture_found,
        capture_status: c.capture_status,
        element_capture_url: c.element_capture_url ?? null,
        menu_reveal_path: c.menu_reveal_path,
      };
    }

    function membersForLabelGroup(lg, pageUrl, pageViewport) {
      const ids = lg.member_tag_ids || [];
      if (!ids.length) return lg.members || [];
      const map = pageUrl ? getCandidatesMapForPage(pageUrl, pageViewport) : lastCandidatesByTagId;
      const resolved = [];
      for (const id of ids) {
        const c = map[id];
        if (c) resolved.push(candidateToMember(c));
        else {
          const fromVisible = (lg.members || []).find((m) => m.tag_id === id);
          if (fromVisible) resolved.push(fromVisible);
        }
      }
      return resolved.length ? resolved : lg.members || [];
    }

    function membersForAction(act, pageUrl, pageViewport) {
      const out = [];
      for (const lg of act.label_groups || []) {
        out.push(...membersForLabelGroup(lg, pageUrl, pageViewport));
      }
      return out;
    }

    function membersForCategory(cat, pageUrl, pageViewport) {
      const out = [];
      for (const act of cat.actions || []) {
        if (isPageViewAction(act)) continue;
        out.push(...membersForAction(act, pageUrl, pageViewport));
      }
      return out;
    }

    function getGroupMembers(g) {
      const ids = g.member_tag_ids || [];
      const members = [];
      for (const id of ids) {
        const c = lastCandidatesByTagId[id];
        if (c) members.push(candidateToMember(c));
        else {
          const fromVisible = (g.members_visible || []).find((m) => m.tag_id === id);
          if (fromVisible) members.push(fromVisible);
        }
      }
      if (!members.length && g.members_visible?.length) {
        return [...g.members_visible];
      }
      return members;
    }

    function resolveGroupCount(data) {
      if (!data) return 0;
      if (data.group_count != null) return Number(data.group_count) || 0;
      if (data.tree?.label_group_count != null) return Number(data.tree.label_group_count) || 0;
      return Array.isArray(data.groups) ? data.groups.length : 0;
    }

    function countLabelsInAction(act) {
      return act.label_groups?.length ?? 0;
    }

    function isPageViewAction(act) {
      return act?.action_key === "__page_view__" || act?.action === "페이지뷰";
    }

    function countClickLabelsInCategory(cat) {
      return (cat.actions || [])
        .filter((act) => !isPageViewAction(act))
        .reduce((n, act) => n + countLabelsInAction(act), 0);
    }

    function countLabelsInCategory(cat) {
      return countClickLabelsInCategory(cat);
    }

    function countClickLabelsInTree(tree) {
      if (!tree?.categories) return 0;
      return tree.categories.reduce((n, cat) => n + countClickLabelsInCategory(cat), 0);
    }

    function countLabelsInTree(tree) {
      if (!tree) return 0;
      const clickOnly = countClickLabelsInTree(tree);
      if (clickOnly > 0) return clickOnly;
      if (tree.label_group_count != null) {
        const pvSlots = (tree.categories || []).some((cat) =>
          (cat.actions || []).some((act) => isPageViewAction(act))
        );
        return pvSlots ? Math.max(0, tree.label_group_count - 1) : tree.label_group_count;
      }
      return clickOnly;
    }

    function formatLabelCount(n) {
      return Number(n || 0).toLocaleString() + "개 라벨";
    }

    function memberHasConfirmedPosition(m) {
      if (m.tag_id === 0) return true;
      const b = m.overlay_bbox;
      return b && b.w > 0 && b.h > 0;
    }

    function memberMatchesViewport(m, preferViewport) {
      if (m.tag_id === 0) return true;
      const p = m.platform || "All";
      if (p === "All") return true;
      const mode =
        preferViewport === "mo" || preferViewport === "pc" ? preferViewport : viewportMode;
      return mode === "pc" ? p === "PC" : p === "MO";
    }

    function candidatePlatform(tagId) {
      const c = lastCandidatesByTagId[tagId];
      return c?.platform || "All";
    }

    function filterTreeByViewport(tree, preferViewport) {
      if (!tree?.categories) return null;
      const categories = [];
      for (const cat of tree.categories) {
        const actions = [];
        for (const act of cat.actions) {
          if (isPageViewAction(act)) continue;
          const label_groups = [];
          for (const lg of act.label_groups) {
            const allMembers = lg.members || [];
            const visibleMembers = allMembers.filter(
              (m) => memberMatchesViewport(m, preferViewport) && memberHasConfirmedPosition(m)
            );
            if (!visibleMembers.length) continue;
            label_groups.push({
              ...lg,
              members: visibleMembers,
              member_total: visibleMembers.length,
              member_tag_ids: visibleMembers.map((m) => m.tag_id),
            });
          }
          if (!label_groups.length) continue;
          const member_total = act.member_total ?? label_groups.reduce((n, lg) => n + lg.member_total, 0);
          actions.push({ ...act, label_groups, member_total });
        }
        if (!actions.length) continue;
        const member_total = cat.member_total ?? actions.reduce((n, a) => n + a.member_total, 0);
        categories.push({ ...cat, actions, member_total });
      }
      return {
        ...tree,
        categories,
        member_total: categories.reduce((n, c) => n + c.member_total, 0),
        category_count: categories.length,
        action_count: categories.reduce((n, c) => n + c.actions.length, 0),
        label_group_count: categories.reduce(
          (n, c) => n + c.actions.reduce((m, a) => m + a.label_groups.length, 0),
          0
        ),
      };
    }

    function rerenderTree() {
      if (sessionPages.length) renderSessionTree();
      else renderList(lastTree, lastGroups, lastGroupCount);
    }

    function actionCollapseKey(pageUrl, cat, act) {
      return pageCollapseKey(pageUrl, cat.category_key + "::" + act.action_key);
    }

    function labelGroupKey(pageUrl, cat, act, lg) {
      return pageCollapseKey(
        pageUrl,
        cat.category_key + "::" + act.action_key + "::" + lg.label_key
      );
    }

    function ensureActivePickPage() {
      if (!sessionPages.length) {
        activePickPageKey = null;
        return;
      }
      const keys = sessionPages.map((p) => pageKey(p.page_url, p.active_viewport));
      if (activePickPageKey && keys.includes(activePickPageKey)) return;
      if (lastAnalyzedPageUrl) {
        const preferred = pageKey(lastAnalyzedPageUrl, lastAnalyzedViewport);
        if (keys.includes(preferred)) {
          activePickPageKey = preferred;
          return;
        }
      }
      activePickPageKey = keys[0];
    }

    function renderPickPageTabs() {
      if (!pickPageTabsEl) return;
      if (!sessionPages.length) {
        pickPageTabsEl.hidden = true;
        pickPageTabsEl.innerHTML = "";
        return;
      }
      pickPageTabsEl.hidden = false;
      pickPageTabsEl.innerHTML = sessionPages
        .map((page) => {
          const pk = pageKey(page.page_url, page.active_viewport);
          const filtered = filterTreeByViewport(page.tree, page.active_viewport);
          const n = countClickLabelsInTree(filtered);
          const vp = page.active_viewport === "mo" ? "MO" : "PC";
          const name = page.page_name || page.page_url;
          const active = pk === activePickPageKey ? " active" : "";
          return (
            '<button type="button" class="pick-page-tab' +
            active +
            '" role="tab" aria-selected="' +
            (pk === activePickPageKey ? "true" : "false") +
            '" data-page-key="' +
            escapeAttr(pk) +
            '" title="' +
            escapeAttr(page.page_url + " · " + vp) +
            '">' +
            '<span class="pick-page-tab-name">' +
            escapeHtml(name) +
            "</span>" +
            '<span class="pick-page-tab-meta">' +
            escapeHtml(vp) +
            " · " +
            n +
            "</span></button>"
          );
        })
        .join("");

      pickPageTabsEl.querySelectorAll(".pick-page-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.getAttribute("data-page-key") || "";
          if (!key || key === activePickPageKey) return;
          activePickPageKey = key;
          const page = sessionPages.find(
            (p) => pageKey(p.page_url, p.active_viewport) === key
          );
          if (page) {
            urlInput.value = page.page_url;
            collapsedPages.delete(key);
            ensureCapturePreview(page.page_url, page.active_viewport);
          }
          renderSessionTree();
        });
      });
    }

    function renderSessionTree() {
      listEl.innerHTML = "";
      selectedLi = null;
      const modeLabel = viewportMode === "mo" ? "MO" : "PC";
      ensureActivePickPage();
      renderPickPageTabs();

      if (!sessionPages.length) {
        countEl.textContent = "";
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "분석된 페이지가 없습니다.";
        listEl.appendChild(li);
        return;
      }

      let totalLabels = 0;
      for (const page of sessionPages) {
        const pageVp = page.active_viewport === "mo" ? "mo" : "pc";
        const filtered = filterTreeByViewport(page.tree, pageVp);
        totalLabels += countLabelsInTree(filtered);
      }

      const activePage =
        sessionPages.find((p) => pageKey(p.page_url, p.active_viewport) === activePickPageKey) ||
        sessionPages[0];
      const activeFiltered = filterTreeByViewport(
        activePage.tree,
        activePage.active_viewport
      );
      const activeClicks = countClickLabelsInTree(activeFiltered);

      countEl.textContent =
        sessionPages.length.toLocaleString() +
        "페이지 중 1 · 이 페이지 클릭 " +
        activeClicks.toLocaleString() +
        " · 전체 " +
        totalLabels.toLocaleString() +
        " (" +
        modeLabel +
        ")";

      if (!treeActionsCollapsedOnce && sessionPages.length) {
        for (const page of sessionPages) {
          const pageVp = page.active_viewport === "mo" ? "mo" : "pc";
          const filtered = filterTreeByViewport(page.tree, pageVp);
          for (const cat of filtered?.categories || []) {
            for (const act of cat.actions || []) {
              if (act.flattened || isPageViewAction(act)) continue;
              collapsedActions.add(actionCollapseKey(page.page_url, cat, act));
            }
          }
        }
        treeActionsCollapsedOnce = true;
      }

      const page = activePage;
      const pk = pageKey(page.page_url, page.active_viewport);
      const filtered = activeFiltered;
      const clickTotal = activeClicks;
      const pageCandidates = getCandidatesMapForPage(page.page_url, page.active_viewport);
      const pageViewCandidate = pageCandidates[0];
      const pageName =
        page.page_name ||
        pageViewCandidate?.page_category ||
        pageViewCandidate?.category ||
        page.page_url;
      const countLabel = pageViewCandidate
        ? `클릭 ×${clickTotal} · 페이지뷰`
        : `×${clickTotal}`;

      const pageLi = document.createElement("li");
      pageLi.className = "tree-page active-page";
      const pageParamKey = pk + "::page_view";
      pageLi.dataset.paramKey = pageParamKey;
      const pageMain = document.createElement("div");
      pageMain.className = "tree-item-main";
      const pageCb = createSelectCheckbox(page.page_url, [0]);
      pageMain.appendChild(pageCb);
      const pvLabel = pageViewCandidate
        ? pageViewCandidate.page_category ||
          pageViewCandidate.category ||
          pageViewCandidate.label ||
          pageName
        : pageName;
      pageMain.insertAdjacentHTML(
        "beforeend",
        `<span class="tree-tier-pill pill-page">페이지</span>` +
          `<span class="tree-tier-pill pill-html" title="사이트 HTML(Firecrawl) 분석">HTML</span>` +
          `<span class="tree-row-title">${escapeHtml(pageName)}</span>` +
          `<span class="meta tree-row-count">${countLabel}</span>` +
          (pageViewCandidate
            ? `<span class="page-pv-line">` +
              `<span class="tree-tier-pill pill-pageview">페이지뷰</span>` +
              `<span class="page-pv-label">${escapeHtml(pvLabel)}</span>` +
              `<span class="meta page-pv-hint">카/액/라 = 페이지명</span>` +
              `</span>`
            : "") +
          `<span class="page-url">${escapeHtml(page.page_url)}</span>`
      );
      pageLi.appendChild(pageMain);
      appendParamButton(pageLi, () => {
        const map = getCandidatesMapForPage(page.page_url, page.active_viewport);
        const pv = map[0];
        return pv
          ? buildDrawerContextFromCandidate(pv, {
              paramKey: pageParamKey,
              pageUrl: page.page_url,
              pageViewport: page.active_viewport,
              tagIds: [0],
              category: pv.page_category || pv.category || pageName,
              label: pv.label || pageName,
            })
          : null;
      });
      pageLi.addEventListener("click", (e) => {
        if (e.target.closest(".tree-select-cb")) return;
        e.stopPropagation();
        urlInput.value = page.page_url;
        showCapturePreview(page);
      });
      listEl.appendChild(pageLi);
      renderPageTree(page.page_url, filtered, page.active_viewport);

      updateSelectionSummary();
      restoreParamDrawerHighlight();
      applyPickSearchFilter();
    }

    function renderPageTree(pageUrl, filtered, pageViewport) {
      const rowViewport =
        pageViewport === "mo" ? "mo" : pageViewport === "pc" ? "pc" : viewportMode;
      if (!filtered?.categories?.length) {
        const li = document.createElement("li");
        li.className = "empty";
        li.style.padding = "24px 16px 24px 28px";
        li.textContent =
          (viewportMode === "mo" ? "MO" : "PC") + " 화면에서 추출된 클릭 항목이 없습니다.";
        listEl.appendChild(li);
        return;
      }

      for (const cat of filtered.categories) {
        const catKey = pageCollapseKey(pageUrl, cat.category_key);
        const catCollapsed = collapsedCategories.has(catKey);
        const catTagIds = [];
        for (const act of cat.actions) {
          if (isPageViewAction(act)) continue;
          for (const lg of act.label_groups) {
            catTagIds.push(...(lg.member_tag_ids || []));
          }
        }
        const catLi = document.createElement("li");
        catLi.className = "tree-category";
        catLi.dataset.catKey = catKey;
        if (!matchesSelectionFilter(pageUrl, catTagIds)) catLi.classList.add("filtered-hidden");
        const chev = catCollapsed ? "▸" : "▾";
        const catCb = createSelectCheckbox(pageUrl, catTagIds);
        catLi.appendChild(catCb);
        const catSpan = document.createElement("span");
        catSpan.className = "tree-row-body";
        catSpan.innerHTML =
          `<span class="tree-chevron">${chev}</span>` +
          `<span class="tree-tier-pill pill-category">카테고리</span>` +
          `<span class="tree-row-title">${escapeHtml(cat.display_category || cat.category)}</span>` +
          `<span class="meta tree-row-count">×${countLabelsInCategory(cat)}</span>`;
        catLi.appendChild(catSpan);
        catSpan.addEventListener("click", (e) => {
          if (e.target.closest(".tree-chevron")) {
            e.stopPropagation();
            if (collapsedCategories.has(catKey)) collapsedCategories.delete(catKey);
            else collapsedCategories.add(catKey);
            rerenderTree();
            return;
          }
          e.stopPropagation();
          const wasCollapsed = collapsedCategories.has(catKey);
          if (wasCollapsed) collapsedCategories.delete(catKey);
          const members = membersForCategory(cat, pageUrl, rowViewport);
          if (wasCollapsed) rerenderTree();
          const targetLi =
            (wasCollapsed && listEl.querySelector('li.tree-category[data-cat-key="' + CSS.escape(catKey) + '"]')) ||
            catLi;
          if (members.length) {
            highlightLabelGroup(
              members,
              targetLi,
              pageUrl,
              cat.display_category || cat.category,
              rowViewport
            );
          }
        });
        listEl.appendChild(catLi);

        if (catCollapsed) continue;

        for (const act of cat.actions) {
          if (isPageViewAction(act)) continue;
          const actKey = actionCollapseKey(pageUrl, cat, act);
          const actCollapsed = collapsedActions.has(actKey);
          const showActionRow = !act.flattened;

          if (showActionRow) {
            const actLi = document.createElement("li");
            actLi.className = "tree-action";
            actLi.dataset.actKey = actKey;
            const actTagIds = [];
            for (const lg of act.label_groups) {
              actTagIds.push(...(lg.member_tag_ids || []));
            }
            if (!matchesSelectionFilter(pageUrl, actTagIds)) actLi.classList.add("filtered-hidden");
            const chevA = actCollapsed ? "▸" : "▾";
            const actCb = createSelectCheckbox(pageUrl, actTagIds);
            actLi.appendChild(actCb);
            const actSpan = document.createElement("span");
            actSpan.className = "tree-row-body";
            actSpan.innerHTML =
              `<span class="tree-chevron">${chevA}</span>` +
              `<span class="tree-tier-pill pill-action">액션</span>` +
              `<span class="tree-row-title">${escapeHtml(act.display_action || act.action)}</span>` +
              `<span class="meta tree-row-count">×${countLabelsInAction(act)}</span>`;
            actLi.appendChild(actSpan);
            actSpan.addEventListener("click", (e) => {
              if (e.target.closest(".tree-chevron")) {
                e.stopPropagation();
                if (collapsedActions.has(actKey)) collapsedActions.delete(actKey);
                else collapsedActions.add(actKey);
                rerenderTree();
                return;
              }
              e.stopPropagation();
              const wasCollapsed = collapsedActions.has(actKey);
              if (wasCollapsed) collapsedActions.delete(actKey);
              const members = membersForAction(act, pageUrl, rowViewport);
              if (wasCollapsed) rerenderTree();
              const targetLi =
                (wasCollapsed &&
                  listEl.querySelector('li.tree-action[data-act-key="' + CSS.escape(actKey) + '"]')) ||
                actLi;
              if (members.length) {
                highlightLabelGroup(
                  members,
                  targetLi,
                  pageUrl,
                  act.display_action || act.action,
                  rowViewport
                );
              }
            });
            listEl.appendChild(actLi);
            if (actCollapsed) continue;
          }

          for (const lg of act.label_groups) {
            const mergedCount = (lg.member_tag_ids || []).length;
            const areaBadge = escapeHtml(act.display_action || act.action);
            const lblText = escapeHtml(lg.display_label || lg.label);
            const displayLabel = lblText;
            const showAreaBadge = !!act.flattened;

            const li = document.createElement("li");
            li.className = "label-row";
            const paramKey = pageKey(pageUrl) + "::" + lg.member_tag_ids.join(",");
            li.dataset.paramKey = paramKey;
            if (mergedCount > 1) li.dataset.lgKey = labelGroupKey(pageUrl, cat, act, lg);
            if (!matchesSelectionFilter(pageUrl, lg.member_tag_ids)) li.classList.add("filtered-hidden");
            const anySelected = (lg.member_tag_ids || []).some((id) =>
              isItemSelected(pageUrl, id)
            );
            if (!anySelected) li.classList.add("excluded");
            const rowMain = document.createElement("div");
            rowMain.className = "tree-item-main";
            const rowCb = createSelectCheckbox(pageUrl, lg.member_tag_ids);
            rowMain.appendChild(rowCb);
            rowMain.insertAdjacentHTML(
              "beforeend",
              `<span class="tree-tier-pill pill-label">요소</span>` +
              (showAreaBadge ? `<span class="tier-badge act">${areaBadge}</span>` : "") +
              ` <strong class="label-text">${displayLabel}</strong>`
            );
            li.appendChild(rowMain);
            appendParamButton(li, () => {
              const map = getCandidatesMapForPage(pageUrl, rowViewport);
              const primaryId = lg.member_tag_ids[0];
              const c = map[primaryId];
              return c
                ? buildDrawerContextFromCandidate(c, {
                    paramKey,
                    pageUrl,
                    tagIds: lg.member_tag_ids,
                    category: cat.display_category || cat.category,
                    area: act.display_action || act.action,
                    label: lg.display_label || lg.label,
                  })
                : null;
            });
            li.addEventListener("click", (e) => {
              e.stopPropagation();
              highlightLabelGroup(
                membersForLabelGroup(lg, pageUrl, rowViewport),
                li,
                pageUrl,
                lg.display_label || lg.label,
                rowViewport
              );
            });
            listEl.appendChild(li);
          }
        }
      }
      restoreParamDrawerHighlight();
    }

    function renderList(tree, groups, labelCount) {
      listEl.innerHTML = "";
      selectedLi = null;
      const modeLabel = viewportMode === "mo" ? "MO" : "PC";
      const filtered = filterTreeByViewport(tree, viewportMode);

      if (!filtered?.categories?.length) {
        countEl.textContent = "";
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = modeLabel + " 화면에서 추출된 항목이 없습니다.";
        listEl.appendChild(li);
        return;
      }

      const visibleLabels = countLabelsInTree(filtered) || labelCount || 0;
      countEl.textContent =
        filtered.category_count.toLocaleString() +
        "영역 · " +
        filtered.action_count.toLocaleString() +
        "동작 · " +
        visibleLabels.toLocaleString() +
        "개 라벨 (" +
        modeLabel +
        ")";

      renderPageTree("", filtered, viewportMode);
      updateSelectionSummary();
      applyPickSearchFilter();
    }

    function platformBadgeHtml(m) {
      const p = m.platform || "All";
      let cls = "platform-all";
      if (p === "PC") cls = "platform-pc";
      else if (p === "MO") cls = "platform-mo";
      return `<span class="tier-badge platform ${cls}">${escapeHtml(p)}</span>`;
    }

    function appendLabelRow(catBadge, lblText, m, pageUrl) {
      const li = document.createElement("li");
      li.className = "label-row";
      li.dataset.tagId = String(m.tag_id);
      li.innerHTML =
        `<span class="tier-badge cat">${catBadge}</span>` +
        platformBadgeHtml(m) +
        ` <span class="item-text">${lblText}</span>`;
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        highlightMember(m, li, pageUrl);
      });
      listEl.appendChild(li);
    }

    function appendLabelMemberRow(m, catBadge, lblText, pageUrl) {
      const li = document.createElement("li");
      li.className = "label-member-row";
      li.dataset.tagId = String(m.tag_id);
      li.innerHTML =
        `<span class="tier-badge cat">${catBadge}</span>` +
        platformBadgeHtml(m) +
        ` <span class="item-text">${lblText}</span>`;
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        highlightMember(m, li, pageUrl);
      });
      listEl.appendChild(li);
    }

    function findSessionPage(pageUrl, preferViewport) {
      const norm = normalizeUrlClient(pageUrl);
      const matches = sessionPages.filter((p) => normalizeUrlClient(p.page_url) === norm);
      if (!matches.length) return null;
      if (matches.length === 1) return matches[0];
      const vp = preferViewport === "mo" ? "mo" : "pc";
      return (
        matches.find((p) => (p.active_viewport === "mo" ? "mo" : "pc") === vp) ?? matches[0]
      );
    }

    function elementCaptureUrlFor(_pageEntry, _tagId, member) {
      return member?.element_capture_url || null;
    }

    function highlightLabelGroup(members, li, pageUrl, groupLabel, pageViewport) {
      const vp =
        pageViewport === "mo" ? "mo" : pageViewport === "pc" ? "pc" : viewportMode;
      const viewMembers = (members || []).filter(
        (m) => memberMatchesViewport(m) && memberHasConfirmedPosition(m)
      );
      const rawMembers = viewMembers.length ? viewMembers : members || [];
      const pageEntry = pageUrl ? findSessionPage(pageUrl, vp) : currentCapturePage;
      const highlightMembers = enrichHighlightMembers(rawMembers, pageUrl, vp);
      if (!highlightMembers.length) return;
      showAllPreviewPositions = false;
      if (previewShowAllBtn) previewShowAllBtn.textContent = "모든 위치 표시";

      if (selectedLi) selectedLi.classList.remove("selected");
      selectedLi = li;
      li.classList.add("selected");

      const primary = highlightMembers[0];
      lastHighlightMembers = highlightMembers;
      lastHighlightTagId = primary?.tag_id ?? null;

      // Always bind preview to THIS row's page before drawing boxes.
      // Missing this switch left the previous page PNG as the background.
      if (pageEntry) {
        lastAnalyzedPageUrl = pageEntry.page_url;
        lastAnalyzedViewport = pageEntry.active_viewport === "mo" ? "mo" : "pc";
        if (vp !== viewportMode) {
          viewportMode = vp;
          if (modePcBtn) modePcBtn.classList.toggle("active", vp === "pc");
          if (modeMoBtn) modeMoBtn.classList.toggle("active", vp === "mo");
          updateModeHint();
          renderSessionTree();
        }
        syncPreviewShellForPage(pageEntry);
      } else if (pageUrl) {
        setStatus("이 버튼이 속한 페이지 캡처를 찾지 못했습니다.", true);
      }

      if (primary?.tag_id === 0) {
        showCapturePreview(pageEntry);
        setBadge("done", "페이지뷰");
        setStatus("page_view — 전체 페이지 캡처", false);
        return;
      }

      const map = getCandidatesMapForPage(pageUrl, vp);
      const captureMember = map[primary.tag_id] ?? primary;

      if (candidateCaptureState(captureMember) === "capturing") {
        showPageBBoxPreview(pageEntry, highlightMembers, { capturing: true });
        setBadge("progress", "캡처 중");
        setStatus(
          `이미지 캡쳐중... · ${groupLabel || primary.label || primary.text || ""}`,
          false
        );
        return;
      }

      const state = candidateCaptureState(captureMember);
      const statusMsg =
        state === "failed" ? previewUnavailableMessage(captureMember) : null;

      showPageBBoxPreview(pageEntry, highlightMembers, { statusMsg });
      setBadge("done", "위치 표시");
      const n = highlightMembers.filter((m) => m.overlay_bbox?.w > 0).length;
      setStatus(
        (n > 1 ? `합친 영역 ${n}개 요소 · ` : "") +
          `전체 캡처 + 위치 · ${groupLabel || primary.label || primary.text || ""}`
      );
    }

    function highlightMember(m, li, pageUrl, pageViewport) {
      return highlightLabelGroup([m], li, pageUrl, m.label || m.text, pageViewport);
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function escapeAttr(s) {
      return escapeHtml(s).replace(/'/g, "&#39;");
    }

    function ensureCapturePreview(pageUrl, pageViewport) {
      const targetUrl = pageUrl || sessionPages[0]?.page_url || urlInput.value.trim();
      if (!targetUrl) {
        setStatus("분석된 페이지가 없습니다.", true);
        return null;
      }

      let page = null;
      if (pageViewport === "mo" || pageViewport === "pc") {
        page = sessionPages.find(
          (p) =>
            pageKey(p.page_url, p.active_viewport) === pageKey(targetUrl, pageViewport)
        );
      }
      if (!page) page = findSessionPage(targetUrl, pageViewport || viewportMode);

      if (!page) {
        setStatus("분석된 페이지를 찾을 수 없습니다.", true);
        return null;
      }

      lastAnalyzedPageUrl = page.page_url;
      lastAnalyzedViewport = page.active_viewport === "mo" ? "mo" : "pc";
      setViewportModeUI(lastAnalyzedViewport);
      showCapturePreview(page);
      setBadge("done", "미리보기");
      setStatus(
        (page.active_viewport === "mo" ? "MO" : "PC") +
          " · 캡처 미리보기" +
          (page.capture_url ? "" : " (스크린샷 없음)")
      );
      renderSessionTree();
      schedulePreviewLayout("capture");
      return page;
    }

    /** @deprecated use ensureCapturePreview */
    function ensureLivePreview(pageUrl, pageViewport) {
      return ensureCapturePreview(pageUrl, pageViewport);
    }

    /** @deprecated capture preview replaced live stream */
    function showLiveView(url) {
      if (url && currentCapturePage) return;
      ensureCapturePreview(lastAnalyzedPageUrl, lastAnalyzedViewport);
    }

    async function runAnalyze(url, opts = {}) {
      const targetUrl = (url || (urlInput && urlInput.value) || "").trim();
      if (!targetUrl) {
        setBadge("error", "오류");
        setStatus("URL을 입력하세요.", true);
        throw new Error("url required");
      }

      if (urlInput) urlInput.value = targetUrl;
      if (opts.viewport) setViewportModeUI(opts.viewport);

      if (analyzeBtn) analyzeBtn.disabled = true;
      setModeButtonsEnabled(false);
      activeJobId = null;
      stopPolling();
      resetPreviewSelection();
      setBadge("progress", "분석 중");
      setStatus((viewportMode === "mo" ? "MO" : "PC") + " 모드로 분석을 시작합니다…");
      if (!opts.silentProgress) showProgress(false);
      if (!opts.skipSkeleton) showSkeleton();
      if (liveShell) liveShell.hidden = true;
      if (liveEmpty) {
        liveEmpty.hidden = false;
        const p = liveEmpty.querySelector("p");
        const s = liveEmpty.querySelector("small");
        if (p) p.textContent = "세션을 여는 중입니다…";
        if (s) s.textContent = "잠시만 기다려 주세요.";
      }

      try {
        const res = await fetch("/api/dev/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: targetUrl,
            viewport: opts.viewport || viewportMode,
            session_id: opts.session_id ?? devSessionId,
            ...getLivePanelSize(),
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "HTTP " + res.status);
        }

        if (data.session_id) devSessionId = data.session_id;

        if (data.status === "started" && data.job_id) {
          return new Promise((resolve, reject) => {
            pollJobProgress(data.job_id, {
              onDone: (doneData) => {
                applyJobResult(doneData);
                if (!opts.skipLiveView) ensureCapturePreview();
                setBadge("done", "완료");
                if (analyzeBtn) analyzeBtn.disabled = false;
                setModeButtonsEnabled(true);
                refreshCredits();
                resolve(doneData);
              },
              onFail: (err) => {
                renderSessionTree();
                setBadge("error", "실패");
                setStatus(err.message, true);
                if (liveShell) liveShell.hidden = true;
                if (liveEmpty) {
                  liveEmpty.hidden = false;
                  const p = liveEmpty.querySelector("p");
                  const s = liveEmpty.querySelector("small");
                  if (p) p.textContent = "분석에 실패했습니다.";
                  if (s) s.textContent = err.message;
                }
                if (analyzeBtn) analyzeBtn.disabled = false;
                setModeButtonsEnabled(true);
                refreshCredits();
                reject(err);
              },
            });
          });
        }

        applyJobResult(data);
        if (!opts.skipLiveView) ensureCapturePreview();
        setBadge("done", "완료");
        const llmLabel = data.llm_source ? " · LLM " + data.llm_source : "";
        setStatus(
          formatLabelCount(resolveGroupCount(data)) +
          " · HTML " + Number(data.html_length).toLocaleString() + " chars" +
          (data.capture_url ? " · 캡처 준비됨" : "") +
          llmLabel
        );
        return data;
      } catch (err) {
        stopPolling();
        showProgress(false);
        renderSessionTree();
        setBadge("error", "실패");
        setStatus(err.message, true);
        if (liveShell) liveShell.hidden = true;
        if (liveEmpty) {
          liveEmpty.hidden = false;
          const p = liveEmpty.querySelector("p");
          const s = liveEmpty.querySelector("small");
          if (p) p.textContent = "분석에 실패했습니다.";
          if (s) s.textContent = err.message;
        }
        throw err;
      } finally {
        if (!pollTimer && analyzeBtn) {
          analyzeBtn.disabled = false;
          refreshCredits();
        }
      }
    }

    if (analyzeBtn) {
      analyzeBtn.addEventListener("click", () => void runAnalyze());
    }

    paramDrawerCloseBtn.addEventListener("click", closeParamDrawer);
    paramBackdropEl.addEventListener("click", closeParamDrawer);
    paramToggleJsonBtn.addEventListener("click", () => {
      paramDrawerJsonMode = !paramDrawerJsonMode;
      paramDrawerEditMode = false;
      renderParamDrawer();
    });
    if (paramToggleEditBtn) {
      paramToggleEditBtn.addEventListener("click", () => {
        paramDrawerEditMode = !paramDrawerEditMode;
        if (paramDrawerEditMode) paramDrawerJsonMode = false;
        renderParamDrawer();
      });
    }
    if (paramSaveBtn) {
      paramSaveBtn.addEventListener("click", () => void saveParamDrawerEdits());
    }
    paramCopyBtn.addEventListener("click", async () => {
      if (!paramDrawerContext?.payload) return;
      try {
        await navigator.clipboard.writeText(JSON.stringify(paramDrawerContext.payload, null, 2));
        setStatus("이벤트 payload가 클립보드에 복사되었습니다.");
      } catch (err) {
        setStatus("복사 실패: " + (err.message || "unknown"), true);
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && paramDrawerOpen) closeParamDrawer();
    });

    if (selectAllBtn) {
      selectAllBtn.addEventListener("click", () => {
        for (const page of sessionPages) {
          for (const c of page.candidates || []) {
            setItemSelected(page.page_url, c.tag_id, true);
          }
        }
        updateSelectionSummary();
        scheduleSelectionPersist();
        rerenderTree();
      });
    }

    if (selectNoneBtn) {
      selectNoneBtn.addEventListener("click", () => {
        for (const page of sessionPages) {
          for (const c of page.candidates || []) {
            setItemSelected(page.page_url, c.tag_id, false);
          }
        }
        updateSelectionSummary();
        scheduleSelectionPersist();
        rerenderTree();
      });
    }

    if (selectionFilterEl) {
      selectionFilterEl.addEventListener("change", () => {
        selectionFilter = selectionFilterEl.value;
        rerenderTree();
      });
    }

    if (confirmBtn) confirmBtn.addEventListener("click", () => void confirmSelection());

    const pickConfirmBtn = document.getElementById("pick-confirm-btn");
    if (pickConfirmBtn) {
      pickConfirmBtn.addEventListener("click", () => {
        // Prefer wizard next path (same confirmSelection + step advance).
        const wizardNext = document.getElementById("wizard-next");
        if (wizardNext && !wizardNext.disabled) {
          wizardNext.click();
          return;
        }
        void confirmSelection();
      });
    }

    const pickSearchInput = document.getElementById("pick-search");
    if (pickSearchInput) {
      pickSearchInput.addEventListener("input", () => applyPickSearchFilter());
    }

    if (previewShowAllBtn) {
      previewShowAllBtn.addEventListener("click", () => {
        setShowAllPositions(!showAllPreviewPositions);
      });
    }
    // AI 위치 검증 UI는 제거됨(혼동). API validateCurrentPagePositions는 내부용으로 유지.

    if (navAnalyzeEl) navAnalyzeEl.addEventListener("click", () => switchAppView("analyze"));
    if (navTaxonomyEl) navTaxonomyEl.addEventListener("click", () => switchAppView("taxonomy"));

    taxonomySearchEl.addEventListener("input", () => {
      taxonomySearch = taxonomySearchEl.value;
      renderTaxonomyTable();
    });

    if (taxonomyExportBtn) {
      taxonomyExportBtn.addEventListener("click", () => {
        if (!devSessionId || !taxonomyData) {
          setStatus("먼저 택소노미를 확정하세요.", true);
          return;
        }
        window.location.href =
          "/api/dev/taxonomy/export?session_id=" + encodeURIComponent(devSessionId);
      });
    }

    window.Workspace = {
      APP_VERSION,
      runAnalyze,
      pollJobProgress,
      applyJobResult,
      confirmSelection,
      renderSessionTree,
      renderTaxonomyView,
      countSelectionTotals,
      setViewportModeUI,
      getViewportMode: () => viewportMode,
      getSessionId: () => devSessionId,
      setSessionId: (id) => { devSessionId = id; },
      getSessionPages: () => sessionPages,
      getTaxonomyData: () => taxonomyData,
      setStatus,
      setBadge,
      refreshCredits,
      showLiveView,
      ensureLivePreview,
      ensureCapturePreview,
      showCapturePreview,
      stopPolling,
      /** Drop the loaded session so another project never shows stale pages. */
      resetSession() {
        stopPolling();
        devSessionId = null;
        sessionPages = [];
        selectionState = {};
        taxonomyData = null;
        lastCandidatesByTagId = {};
        activePickPageKey = null;
        collapsedPages.clear();
        collapsedCategories.clear();
        collapsedActions.clear();
        expandedLabelGroups.clear();
        treeActionsCollapsedOnce = false;
        lastAnalyzedPageUrl = null;
        currentCapturePage = null;
        renderSessionTree();
        updateSelectionSummary();
        renderTaxonomyView();
      },
      async loadSession(sessionId) {
        if (!sessionId) return null;
        const res = await fetch("/api/dev/sessions/" + encodeURIComponent(sessionId));
        const data = await res.json();
        if (!res.ok || !data.ok) return null;
        devSessionId = data.session_id;
        sessionPages = (data.pages || []).map((page) => {
          if (!page.positions?.length || !page.candidates?.length) return page;
          const posMap = buildPositionsMap(page.positions);
          const candidates = page.candidates.map((c) => mergeTagRecord(c, posMap[c.tag_id], null));
          return { ...page, candidates };
        });
        mergeSelectionFromServer(data.selection);
        if (data.taxonomy) taxonomyData = normalizeTaxonomyData(data.taxonomy);
        const active = sessionPages[0];
        if (active?.candidates?.length) {
          lastCandidatesByTagId = getCandidatesMapForPage(active.page_url, active.active_viewport);
        }
        renderSessionTree();
        if (taxonomyData) renderTaxonomyView();
        maybeStartCaptureWatch();
        return data;
      },
    };