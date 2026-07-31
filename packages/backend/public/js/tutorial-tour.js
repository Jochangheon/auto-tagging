/**
 * Per-wizard-step 사용방법 — always shows SAMPLE fixtures, never the user's empty/real data.
 * Every tip advances only via the tour 「다음」 button (no sample UI clicks required).
 */
(function () {
  const DEMO_URL = "http://ibank-ax.com/";
  const DEMO_MY_PAGE = "http://ibank-ax.com/mypage";
  const DEMO_PROJECT = "ibank-ax 이벤트 설계";

  const WIZARD_NAMES = {
    0: "1단계 · 프로젝트",
    1: "2단계 · 사이트 입력",
    2: "3단계 · 분석 실행",
    3: "4단계 · 태그 선택",
    4: "5단계 · 택소노미 확인",
    5: "6단계 · 보내기",
  };

  const NEXT_HINT = "확인했으면 「다음」을 누르세요.";
  const NEXT_HINT_LAST = "이 단계 사용방법을 마치려면 「다음」을 누르세요.";

  const PREVIEW_SVG =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="720" viewBox="0 0 960 720">' +
        '<rect width="960" height="720" fill="#f8fafc"/>' +
        '<rect x="0" y="0" width="960" height="72" fill="#0f172a"/>' +
        '<text x="28" y="46" fill="#fff" font-family="sans-serif" font-size="20" font-weight="700">ibank-ax</text>' +
        '<rect x="220" y="20" width="88" height="32" rx="6" fill="#2563eb"/>' +
        '<text x="244" y="42" fill="#fff" font-family="sans-serif" font-size="14">제품</text>' +
        '<rect x="320" y="20" width="88" height="32" rx="6" fill="#334155"/>' +
        '<text x="340" y="42" fill="#fff" font-family="sans-serif" font-size="14">이벤트</text>' +
        '<rect x="420" y="20" width="88" height="32" rx="6" fill="#334155"/>' +
        '<text x="444" y="42" fill="#e2e8f0" font-family="sans-serif" font-size="14">지원</text>' +
        '<rect x="40" y="100" width="880" height="200" rx="14" fill="#cbd5e1"/>' +
        '<text x="70" y="200" fill="#475569" font-family="sans-serif" font-size="22" font-weight="600">메인 배너 · 캠페인</text>' +
        '<text x="70" y="235" fill="#64748b" font-family="sans-serif" font-size="14">샘플 페이지 캡처</text>' +
        '<text x="40" y="350" fill="#0f172a" font-family="sans-serif" font-size="18" font-weight="700">추천 상품</text>' +
        '<rect x="40" y="370" width="200" height="220" rx="12" fill="#e2e8f0"/>' +
        '<rect x="56" y="386" width="168" height="120" rx="8" fill="#94a3b8"/>' +
        '<text x="56" y="540" fill="#0f172a" font-family="sans-serif" font-size="13">상품 A</text>' +
        '<rect x="56" y="554" width="100" height="24" rx="6" fill="#2563eb"/>' +
        '<text x="68" y="571" fill="#fff" font-family="sans-serif" font-size="11">담기</text>' +
        '<rect x="260" y="370" width="200" height="220" rx="12" fill="#e2e8f0"/>' +
        '<rect x="276" y="386" width="168" height="120" rx="8" fill="#94a3b8"/>' +
        '<text x="276" y="540" fill="#0f172a" font-family="sans-serif" font-size="13">상품 B</text>' +
        '<rect x="276" y="554" width="100" height="24" rx="6" fill="#2563eb"/>' +
        '<text x="288" y="571" fill="#fff" font-family="sans-serif" font-size="11">담기</text>' +
        "</svg>"
    );

  /**
   * Tip catalog (wizard step → tips).
   * Progress within a step is only via tour 「다음」 / 「이전」.
   */
  const ALL_TIPS = [
    /* ——— 0. 프로젝트 ——— */
    {
      step: 0,
      target: "#panel-0 h2, #panel-0 .lead",
      title: "1. 이 단계에서 하는 일",
      body: "분석·태그는 프로젝트 단위로만 저장됩니다. 아래는 샘플 화면입니다. 「새 프로젝트」로 만들거나, 카드로 기존 프로젝트를 엽니다.",
      prepare: "project",
    },
    {
      step: 0,
      target: "#project-create-btn",
      title: "2. 새 프로젝트",
      body: "「새 프로젝트」를 누르면 만들기 창만 열립니다. 이 시점에는 아직 목록에 생기지 않습니다.",
      prepare: "project",
    },
    {
      step: 0,
      target: "[data-tour-demo='settings-panel']",
      title: "3. 저장해야 생성됨",
      body: "이름·설명을 입력한 뒤 「저장하고 프로젝트 열기」를 눌렀을 때만 DB에 만들어집니다. 「취소」나 닫기를 누르면 프로젝트가 생기지 않습니다.",
      prepare: "project-settings",
    },
    {
      step: 0,
      target: "[data-tour-demo='project-card']",
      title: "4. 목록에서 선택",
      body: "저장된 프로젝트는 카드로 보입니다. 실제 사용 시에는 카드를 눌러 그 프로젝트로 들어갑니다. 사용방법에서는 샘플을 누르지 마세요.",
      prepare: "project",
    },

    /* ——— 1. 사이트 입력 ——— */
    {
      step: 1,
      target: "#panel-1 h2, #panel-1 .lead",
      title: "1. 이 단계에서 하는 일",
      body: "사이트 주소를 넣고 페이지 URL을 불러온 뒤, 분석할 페이지만 선택·확정합니다. 이 단계에서는 분석을 실행하지 않습니다.",
      prepare: "site",
    },
    {
      step: 1,
      target: "#site-discover-card, #discover-urls-btn",
      title: "2. 페이지 URL 불러오기",
      body: "도메인만(예: ibank-ax.com) 넣어도 됩니다. 「페이지 불러오기」로 후보를 모읍니다. 서브도메인이 필요하면 체크하세요. 분석은 실행하지 않습니다.",
      prepare: "site",
    },
    {
      step: 1,
      target: "#discover-pick-card, #apply-discovered-btn",
      title: "3. 불러온 URL 선택·확정",
      body: "체크한 URL만 「선택 URL 확정」으로 분석 대상에 넣습니다. 전체를 돌리지 말고 필요한 페이지만 고르세요.",
      prepare: "site",
    },
    {
      step: 1,
      target: "[data-tour-demo='url-row']",
      title: "4. 확정 목록 · 별칭 · PC/MO",
      body: "확정된 URL의 별칭·PC/MO를 조정합니다. 직접 추가·붙여넣기도 가능합니다.",
      prepare: "site",
    },
    {
      step: 1,
      target: "#url-summary",
      title: "5. 등록 요약",
      body: "총 URL·PC/MO 건수가 요약됩니다. 「다음」을 누르면 2단계(분석 실행)로만 이동합니다. 분석은 2단계에서 시작합니다.",
      prepare: "site",
    },

    /* ——— 2. 분석 실행 ——— */
    {
      step: 2,
      target: "#job-cards, .analyze-page-list-title",
      title: "1. 분석 페이지 목록",
      body: "등록한 URL·뷰포트가 카드로 나타납니다(샘플). 미완료만 돌리고, 완료 항목은 아래 「완료된 분석」구역에 남습니다.",
      prepare: "analyze-idle",
    },
    {
      step: 2,
      target: "#start-analyze-btn",
      title: "2. 분석 시작",
      body: "「분석 시작」을 누르면 미완료 카드부터 「태깅 → 이름붙이기 → 이미지 캡쳐」순으로 진행됩니다.",
      prepare: "analyze-idle",
    },
    {
      step: 2,
      target: "[data-tour-demo='job-running']",
      title: "3. 태깅 중",
      body: "카드에 「태깅중…」과 진행 막대가 보입니다. 클릭 가능 요소를 수집하는 단계입니다.",
      prepare: "analyze-tagging",
    },
    {
      step: 2,
      target: "[data-tour-demo='job-naming']",
      title: "4. 이름붙이는 중",
      body: "「이름붙이는중…」은 카테고리·액션·라벨 후보를 붙이는 단계입니다. 카드마다 상태가 다를 수 있습니다.",
      prepare: "analyze-naming",
    },
    {
      step: 2,
      target: "[data-tour-demo='job-capturing']",
      title: "5. 이미지 캡쳐 중",
      body: "「이미지 캡쳐중… 8/24」처럼 진행이 표시됩니다. 태그 선택 미리보기에 쓸 이미지를 만듭니다.",
      prepare: "analyze-capturing",
    },
    {
      step: 2,
      target: "#global-analyze-bar, #global-stop-btn",
      title: "6. 전체 상태 · 중단",
      body: "상단 빨간 바로 전체 진행을 보고 「분석 중단」으로 멈출 수 있습니다. 이미 끝난 카드 결과는 유지됩니다.",
      prepare: "analyze-progress",
    },
    {
      step: 2,
      target: "[data-tour-demo='job-login']",
      title: "7. 로그인 필요",
      body: "/mypage 등 회원 페이지는 로그인 창이 자동으로 열릴 수 있습니다. 카드의 「로그인하기」로도 다시 열 수 있습니다.",
      prepare: "login",
    },
    {
      step: 2,
      target: "#interactive-login-complete, #interactive-login-bar",
      title: "8. 로그인 완료",
      body: "사이트에 로그인한 뒤 「로그인 완료」를 누르거나 창을 닫으면 세션이 저장됩니다. 이후 다시 분석하면 회원 페이지를 읽습니다.",
      prepare: "login",
    },
    {
      step: 2,
      target: "[data-tour-demo='job-reanalyze'], #retry-failed-btn",
      title: "9. 실패 · 다시 시도 · 다시 분석",
      body: "실패 카드는 「다시 시도」또는 「실패 항목만 다시 시도」입니다. 이미 완료된 카드는 「다시 분석」으로만 재실행됩니다.",
      prepare: "analyze-retry",
    },

    /* ——— 3. 태그 선택 ——— */
    {
      step: 3,
      target: "#panel-3 .pick-grid, #panel-3",
      title: "1. 이 단계에서 하는 일",
      body: "분석된 클릭 후보 중 택소노미에 넣을 것만 고릅니다. 왼쪽은 후보 트리, 오른쪽은 페이지 캡처 미리보기입니다(샘플).",
      prepare: "pick",
    },
    {
      step: 3,
      target: "#panel-3 .tree-legend-details, #panel-3 .list-card .card-head",
      title: "2. 페이지 › 카테고리 › 액션 › 요소",
      body: "트리 위 범례 순서입니다. 페이지=분석한 URL, 카테고리=페이지명(그룹), 액션=화면 영역(GNB·배너 등), 요소(라벨)=실제 클릭 버튼 이름입니다.",
      prepare: "pick",
    },
    {
      step: 3,
      target: "[data-tour-demo='tree-action-banner'], [data-tour-demo='chevron-collapsed']",
      title: "3. 목록 펼치기 · 접기",
      body: "행 앞 ▸는 접힌 상태, ▾는 펼친 상태입니다. ▸/▾ 또는 카테고리·액션 행을 누르면 아래 목록이 열리거나 닫힙니다. 샘플 「메인 배너」는 접혀 있어 안쪽 요소가 보이지 않습니다.",
      prepare: "pick-collapse",
    },
    {
      step: 3,
      target: "[data-tour-demo='tree-category']",
      title: "4. 카테고리란?",
      body: "카테고리는 페이지 단위 이름입니다(샘플: 「메인」). 같은 페이지의 클릭들이 이 아래에 모입니다. 체크하면 그 아래 액션·요소가 한꺼번에 선택됩니다.",
      prepare: "pick",
    },
    {
      step: 3,
      target: "[data-tour-demo='tree-action-gnb'], [data-tour-demo='tree-action-reco']",
      title: "5. 액션이란?",
      body: "액션은 화면 영역 이름입니다(샘플: GNB, 메인 배너, 추천 상품). 펼친 뒤 그 안의 클릭 요소를 확인합니다. 액션 체크는 그 영역 전체 선택입니다.",
      prepare: "pick",
    },
    {
      step: 3,
      target: "[data-tour-demo='label-product'], [data-tour-demo='label-detail']",
      title: "6. 요소(라벨)란?",
      body: "맨 아래 「요소」가 실제 클릭 태그입니다(샘플: 제품, 상품상세). #숫자(tag_id)가 붙고, #44, #49처럼 여러 개면 같은 라벨로 묶인 후보입니다.",
      prepare: "pick",
    },
    {
      step: 3,
      target: "#pick-confirm-dock, #select-all-btn, #select-none-btn, #selection-summary",
      title: "7. 체크 · 전체 선택 · 해제",
      body: "왼쪽 체크박스로 포함 여부를 정합니다. 「전체 선택」「전체 해제」로 일괄 처리하고, 상단에 선택 수 / 전체가 표시됩니다(샘플: 선택 4 / 전체 6).",
      prepare: "pick",
    },
    {
      step: 3,
      target: "#selection-filter, #pick-search",
      title: "8. 필터 · 검색",
      body: "필터에서 「선택된 것만」「제외된 것만」을 고르거나, 검색창에 라벨·이벤트 이름을 치면 트리에서 찾을 수 있습니다.",
      prepare: "pick",
    },
    {
      step: 3,
      target: "[data-tour-demo='preview-box'], #preview-shell",
      title: "9. 행 클릭 → 미리보기 주황 박스",
      body: "요소 행을 클릭하면 오른쪽 페이지 캡처에 주황 박스가 잡히고 그 위치로 스크롤됩니다. 박스 위 숫자는 tag_id입니다.",
      prepare: "pick",
    },
    {
      step: 3,
      target: "[data-tour-demo='tree-page']",
      title: "10. 페이지뷰",
      body: "페이지 행의 「페이지뷰」는 클릭 요소가 아니라 자동 수집되는 페이지 방문 이벤트입니다. 클릭 후보와 따로 표시됩니다.",
      prepare: "pick",
    },
    {
      step: 3,
      target: "[data-tour-demo='label-product'] [data-tour-demo='param-btn'], [data-tour-demo='param-btn']",
      title: "11. { } 버튼 위치",
      body: "요소 행 맨 오른쪽 「{ }」가 파라미터 보기 버튼입니다. 실제 작업에서는 이 버튼을 누르면 오른쪽 서랍이 열립니다.",
      prepare: "pick",
    },
    {
      step: 3,
      target: "#param-drawer.tour-elevated, #param-drawer-foot, #param-drawer",
      union: true,
      title: "12. 파라미터 서랍(샘플로 연 상태)",
      body: "오른쪽에서 이렇게 서랍이 펼쳐집니다. 표로 page_category·action·label 등을 보고, 아래 「JSON 보기」「복사」를 쓸 수 있습니다.",
      prepare: "pick-param",
    },
    {
      step: 3,
      target: "#param-edit-form, #param-drawer-foot, #param-drawer.tour-elevated",
      union: true,
      title: "13. 카테고리·액션·라벨 수정",
      body: "서랍 아래 「수정」을 누르면 입력폼이 펼쳐집니다(샘플). 카테고리·액션·라벨·이벤트명을 고친 뒤 「저장」합니다.",
      prepare: "pick-param-edit",
    },
    {
      step: 3,
      target: "#pick-confirm-btn, #selection-summary, #wizard-next",
      union: true,
      title: "14. 확정하고 다음",
      bodyHtml:
        "하단 「확정하고 다음」을 누르면 택소노미 초안이 만들어집니다.<br/>" +
        '<strong class="tour-warn">왼쪽 체크한 것만</strong> 들어갑니다. ' +
        '<strong class="tour-warn">체크 안 한 후보는 빠집니다.</strong> ' +
        "(샘플: 빨간 체크가 켜진 행만 해당)",
      prepare: "pick-confirm",
    },

    /* ——— 4. 택소노미 ——— */
    {
      step: 4,
      target: "#taxonomy-platform-tabs",
      title: "1. 공통 / PC / MO",
      body: "선택한 태그가 이벤트·카테고리·액션·라벨 표로 정리됩니다(샘플). 탭으로 플랫폼별 초안을 나눕니다.",
      prepare: "taxonomy",
    },
    {
      step: 4,
      target: "#taxonomy-search",
      title: "2. 검색",
      body: "event_name·label로 표를 걸러 볼 수 있습니다.",
      prepare: "taxonomy",
    },
    {
      step: 4,
      target: "#taxonomy-table-wrap, [data-tour-demo='tax-table']",
      title: "3. 초안 표 확인",
      body: "각 행이 하나의 이벤트 초안입니다. 실제 작업에서는 마법사 「다음」으로 보내기 단계로 이동합니다.",
      prepare: "taxonomy",
    },

    /* ——— 5. 보내기 ——— */
    {
      step: 5,
      target: "#export-stats, .export-done",
      title: "1. 완료 요약",
      body: "사이트·페이지·이벤트 수 요약입니다(샘플). 초안이 준비됐는지 확인하세요.",
      prepare: "export",
    },
    {
      step: 5,
      target: "#export-file-card, #taxonomy-export-btn",
      title: "2. Excel 다운로드",
      body: "「Excel 다운로드」로 공통·PC/MO 시트와 변수사전이 담긴 .xlsx 파일을 내려받습니다.",
      prepare: "export",
    },
    {
      step: 5,
      target: "#export-preview, .export-preview-card",
      title: "3. Excel 미리보기",
      body: "이벤트명·시점·카테고리·액션·라벨·설명 컬럼으로 내려받을 내용 일부가 표시됩니다.",
      prepare: "export",
    },
    {
      step: 5,
      target: "#new-wizard-btn",
      title: "4. 새 분석 시작",
      body: "다른 작업을 이어가려면 「새 분석 시작」을 누릅니다. 현재 프로젝트 초안은 DB에 남아 있습니다.",
      prepare: "export",
    },
  ];

  let root = null;
  let tipIndex = 0;
  let activeTips = [];
  let active = false;
  let wizardStep = 0;
  const uiSnapshots = [];
  /** Captured once per tour session — user's real DOM, restored on stop. */
  let captured = null;

  function $(sel, el) {
    return (el || document).querySelector(sel);
  }

  function $$(sel, el) {
    return Array.from((el || document).querySelectorAll(sel));
  }

  function currentWizardStep() {
    return Number(document.querySelector(".wizard-panel.active")?.dataset.step || 0);
  }

  function withNextHint(body, isLast) {
    const base = String(body || "").trim();
    const hint = isLast ? NEXT_HINT_LAST : NEXT_HINT;
    if (base.includes("「다음」")) return base;
    return base + " " + hint;
  }

  function snapShow(el) {
    if (!el) return;
    uiSnapshots.push({
      el,
      hidden: el.hidden,
      ariaHidden: el.getAttribute("aria-hidden"),
    });
    el.hidden = false;
    el.setAttribute("aria-hidden", "false");
  }

  function snapText(el, text) {
    if (!el) return;
    uiSnapshots.push({ el, text: el.textContent });
    el.textContent = text;
  }

  function restoreUi() {
    while (uiSnapshots.length) {
      const s = uiSnapshots.pop();
      if (!s?.el) continue;
      if ("hidden" in s) s.el.hidden = s.hidden;
      if ("ariaHidden" in s) {
        if (s.ariaHidden == null) s.el.removeAttribute("aria-hidden");
        else s.el.setAttribute("aria-hidden", s.ariaHidden);
      }
      if ("className" in s && s.className != null) s.el.className = s.className;
      if ("styleCss" in s) s.el.style.cssText = s.styleCss || "";
      if ("attrSrc" in s) {
        if (s.attrSrc == null) s.el.removeAttribute("src");
        else s.el.setAttribute("src", s.attrSrc);
      }
      if ("html" in s && s.html != null) s.el.innerHTML = s.html;
      else if ("text" in s && s.text != null) s.el.textContent = s.text;
      if ("disabled" in s) s.el.disabled = s.disabled;
    }
  }

  function captureDom() {
    const status = $("#project-list-status");
    const img = $("#preview-image");
    const overlay = $("#preview-overlay");
    captured = {
      projectList: $("#project-list")?.innerHTML ?? null,
      projectStatusHidden: status ? status.hidden : null,
      projectStatusText: status ? status.textContent : null,
      urlRows: $("#url-rows")?.innerHTML ?? null,
      urlSummary: $("#url-summary")?.innerHTML ?? null,
      jobCards: $("#job-cards")?.innerHTML ?? null,
      list: $("#list")?.innerHTML ?? null,
      taxonomy: $("#taxonomy-table-wrap")?.innerHTML ?? null,
      taxonomyEmptyHidden: $("#taxonomy-empty")?.hidden ?? null,
      taxonomyContentHidden: $("#taxonomy-content")?.hidden ?? null,
      previewEmptyHidden: $("#preview-empty")?.hidden ?? null,
      previewShellHidden: $("#preview-shell")?.hidden ?? null,
      previewImgSrc: img ? img.getAttribute("src") : null,
      overlayHtml: overlay ? overlay.innerHTML : null,
      exportStats: $("#export-stats")?.innerHTML ?? null,
      exportPreview: $("#export-preview")?.innerHTML ?? null,
      selectionSummary: $("#selection-summary")?.textContent ?? null,
    };
  }

  function restoreDom() {
    if (!captured) return;
    const c = captured;
    const list = $("#project-list");
    if (list && c.projectList != null) list.innerHTML = c.projectList;
    const status = $("#project-list-status");
    if (status) {
      if (c.projectStatusHidden != null) status.hidden = c.projectStatusHidden;
      if (c.projectStatusText != null) status.textContent = c.projectStatusText;
    }
    const rows = $("#url-rows");
    if (rows && c.urlRows != null) rows.innerHTML = c.urlRows;
    const summary = $("#url-summary");
    if (summary && c.urlSummary != null) summary.innerHTML = c.urlSummary;
    const cards = $("#job-cards");
    if (cards && c.jobCards != null) cards.innerHTML = c.jobCards;
    const tree = $("#list");
    if (tree && c.list != null) tree.innerHTML = c.list;
    const tax = $("#taxonomy-table-wrap");
    if (tax && c.taxonomy != null) tax.innerHTML = c.taxonomy;
    const taxEmpty = $("#taxonomy-empty");
    if (taxEmpty && c.taxonomyEmptyHidden != null) taxEmpty.hidden = c.taxonomyEmptyHidden;
    const taxContent = $("#taxonomy-content");
    if (taxContent && c.taxonomyContentHidden != null) taxContent.hidden = c.taxonomyContentHidden;
    const prevEmpty = $("#preview-empty");
    if (prevEmpty && c.previewEmptyHidden != null) prevEmpty.hidden = c.previewEmptyHidden;
    const shell = $("#preview-shell");
    if (shell && c.previewShellHidden != null) shell.hidden = c.previewShellHidden;
    const img = $("#preview-image");
    if (img) {
      if (c.previewImgSrc) img.setAttribute("src", c.previewImgSrc);
      else img.removeAttribute("src");
    }
    const overlay = $("#preview-overlay");
    if (overlay && c.overlayHtml != null) overlay.innerHTML = c.overlayHtml;
    const stats = $("#export-stats");
    if (stats && c.exportStats != null) stats.innerHTML = c.exportStats;
    const preview = $("#export-preview");
    if (preview && c.exportPreview != null) preview.innerHTML = c.exportPreview;
    const sel = $("#selection-summary");
    if (sel && c.selectionSummary != null) sel.textContent = c.selectionSummary;
    captured = null;
  }

  function fillJobs(html) {
    const cards = $("#job-cards");
    if (cards) cards.innerHTML = html;
  }

  function prepareProject() {
    const list = $("#project-list");
    const status = $("#project-list-status");
    if (status) {
      status.hidden = true;
      status.textContent = "";
    }
    if (!list) return;
    list.innerHTML =
      '<article class="project-card" data-tour-demo="project-card" role="presentation">' +
      '<div class="project-card-title">' +
      DEMO_PROJECT +
      "</div>" +
      '<div class="project-card-meta">분석 대상 2개 · 완료 1개</div>' +
      '<div class="project-card-updated">최근 저장 방금 전 (샘플)</div>' +
      '<button type="button" class="project-card-options-btn" tabindex="-1">옵션 설정</button>' +
      "</article>" +
      '<article class="project-card" data-tour-demo="project-card-2" role="presentation">' +
      '<div class="project-card-title">모바일 이벤트 점검</div>' +
      '<div class="project-card-meta">분석 대상 1개 · 완료 0개</div>' +
      '<div class="project-card-updated">최근 저장 어제 (샘플)</div>' +
      '<button type="button" class="project-card-options-btn" tabindex="-1">옵션 설정</button>' +
      "</article>";
  }

  function prepareProjectSettings() {
    prepareProject();
    const panel = $("#panel-0");
    if (!panel || panel.querySelector("[data-tour-demo='settings-panel']")) return;
    const box = document.createElement("div");
    box.setAttribute("data-tour-demo", "settings-panel");
    box.className = "tour-sample-settings";
    box.innerHTML =
      '<div class="tour-sample-settings-kicker">NEW PROJECT · 샘플</div>' +
      "<h3>새 프로젝트 만들기</h3>" +
      "<p>「저장하고 프로젝트 열기」를 눌러야 생성됩니다. 취소하면 만들어지지 않습니다.</p>" +
      '<label><span>프로젝트 이름</span><input type="text" value="' +
      DEMO_PROJECT +
      '" readonly /></label>' +
      "<label><span>설명</span><textarea readonly rows=\"2\">ibank-ax.com GNB·배너 이벤트 초안</textarea></label>" +
      '<div class="tour-sample-settings-actions">' +
      '<button type="button" class="btn-secondary" tabindex="-1">취소</button>' +
      '<button type="button" class="btn-primary" tabindex="-1">저장하고 프로젝트 열기</button>' +
      "</div>";
    panel.appendChild(box);
  }

  function prepareSite() {
    const seed = $("#seed-url-input");
    if (seed) seed.value = DEMO_URL;
    const pick = $("#discover-pick-card");
    const list = $("#discover-list");
    if (pick) pick.hidden = false;
    if (list) {
      list.innerHTML =
        '<label class="discover-item" data-tour-demo="discover-item">' +
        '<input type="checkbox" checked tabindex="-1" />' +
        '<span class="discover-item-text"><span class="discover-item-url">' +
        DEMO_URL +
        '</span><span class="discover-item-title">홈</span></span></label>' +
        '<label class="discover-item">' +
        '<input type="checkbox" checked tabindex="-1" />' +
        '<span class="discover-item-text"><span class="discover-item-url">' +
        DEMO_MY_PAGE +
        '</span><span class="discover-item-title">마이페이지</span></span></label>';
    }
    const pickCount = $("#discover-pick-count");
    if (pickCount) pickCount.textContent = "선택 2 / 전체 2";
    const status = $("#discover-status");
    if (status) {
      status.hidden = false;
      status.textContent = "불러옴 2개 (샘플). 분석할 페이지만 체크한 뒤 「선택 URL 확정」을 누르세요.";
      status.classList.remove("is-error");
    }

    const rows = $("#url-rows");
    if (rows) {
      rows.innerHTML =
        '<div class="url-row" data-tour-demo="url-row">' +
        '<input type="url" class="url-field" value="' +
        DEMO_URL +
        '" readonly />' +
        '<input type="text" class="alias-field" value="홈" readonly />' +
        '<div class="viewport-toggle" data-tour-demo="vp-toggle" role="group">' +
        '<button type="button" data-vp="pc" class="active" tabindex="-1">PC</button>' +
        '<button type="button" data-vp="mo" class="active" tabindex="-1">MO</button>' +
        "</div>" +
        '<button type="button" class="btn-secondary url-del" tabindex="-1">삭제</button>' +
        "</div>" +
        '<div class="url-row" data-tour-demo="url-row-2">' +
        '<input type="url" class="url-field" value="' +
        DEMO_MY_PAGE +
        '" readonly />' +
        '<input type="text" class="alias-field" value="마이페이지" readonly />' +
        '<div class="viewport-toggle" role="group">' +
        '<button type="button" data-vp="pc" class="active" tabindex="-1">PC</button>' +
        '<button type="button" data-vp="mo" tabindex="-1">MO</button>' +
        "</div>" +
        '<button type="button" class="btn-secondary url-del" tabindex="-1">삭제</button>' +
        "</div>";
    }
    const summary = $("#url-summary");
    if (summary) {
      summary.innerHTML =
        '<span class="chip">총 2개 URL</span>' +
        '<span class="chip">분석 3건</span>' +
        '<span class="chip">PC 2</span>' +
        '<span class="chip">MO 1</span>';
    }
  }

  function prepareAnalyzeIdle() {
    fillJobs(
      '<div class="job-card queued" data-tour-demo="job-card">' +
        '<div class="job-card-head">' +
        '<span class="job-card-index">1</span><span class="job-status-dot queued"></span>' +
        '<span class="job-card-url">ibank-ax.com/</span><span class="job-card-vp">PC</span></div>' +
        '<div class="job-card-meta">대기 중</div></div>' +
        '<div class="job-card queued" data-tour-demo="job-card-mo">' +
        '<div class="job-card-head">' +
        '<span class="job-card-index">2</span><span class="job-status-dot queued"></span>' +
        '<span class="job-card-url">ibank-ax.com/</span><span class="job-card-vp">MO</span></div>' +
        '<div class="job-card-meta">대기 중</div></div>' +
        '<div class="job-card queued" data-tour-demo="job-card-my">' +
        '<div class="job-card-head">' +
        '<span class="job-card-index">3</span><span class="job-status-dot queued"></span>' +
        '<span class="job-card-url">ibank-ax.com/mypage</span><span class="job-card-vp">PC</span></div>' +
        '<div class="job-card-meta">대기 중</div></div>'
    );
  }

  function prepareAnalyzeTagging() {
    fillJobs(
      '<div class="job-card running" data-tour-demo="job-running">' +
        '<div class="job-card-head">' +
        '<span class="job-card-index">1</span><span class="job-status-dot running"></span>' +
        '<span class="job-card-url">ibank-ax.com/</span><span class="job-card-vp">PC</span></div>' +
        '<div class="job-card-meta">태깅중…</div>' +
        '<div class="job-card-progress"><div class="job-card-progress-fill" style="width:42%"></div></div></div>' +
        '<div class="job-card queued">' +
        '<div class="job-card-head">' +
        '<span class="job-card-index">2</span><span class="job-status-dot queued"></span>' +
        '<span class="job-card-url">ibank-ax.com/</span><span class="job-card-vp">MO</span></div>' +
        '<div class="job-card-meta">대기 중</div></div>'
    );
    snapShow($("#global-analyze-bar"));
    snapText($("#global-analyze-text"), "분석 진행 중 · 태깅중… (샘플)");
    snapShow($("#global-stop-btn"));
  }

  function prepareAnalyzeNaming() {
    fillJobs(
      '<div class="job-card running" data-tour-demo="job-naming">' +
        '<div class="job-card-head">' +
        '<span class="job-card-index">1</span><span class="job-status-dot running"></span>' +
        '<span class="job-card-url">ibank-ax.com/</span><span class="job-card-vp">PC</span></div>' +
        '<div class="job-card-meta">이름붙이는중…</div>' +
        '<div class="job-card-progress"><div class="job-card-progress-fill" style="width:70%"></div></div></div>' +
        '<div class="job-card running">' +
        '<div class="job-card-head">' +
        '<span class="job-card-index">2</span><span class="job-status-dot running"></span>' +
        '<span class="job-card-url">ibank-ax.com/</span><span class="job-card-vp">MO</span></div>' +
        '<div class="job-card-meta">이름붙이는중…</div>' +
        '<div class="job-card-progress"><div class="job-card-progress-fill" style="width:55%"></div></div></div>'
    );
    snapShow($("#global-analyze-bar"));
    snapText($("#global-analyze-text"), "분석 진행 중 · 이름붙이는중… (샘플)");
  }

  function prepareAnalyzeCapturing() {
    fillJobs(
      '<div class="job-card done capture-phase" data-tour-demo="job-capturing">' +
        '<div class="job-card-head">' +
        '<span class="job-card-index">1</span><span class="job-status-dot capturing"></span>' +
        '<span class="job-card-url">ibank-ax.com/</span><span class="job-card-vp">PC</span></div>' +
        '<div class="job-card-meta">이미지 캡쳐중… 8/24</div>' +
        '<div class="job-card-progress"><div class="job-card-progress-fill phase2" style="width:33%"></div></div></div>'
    );
    snapShow($("#global-analyze-bar"));
    snapText($("#global-analyze-text"), "분석 진행 중 · 이미지 캡쳐중… (샘플)");
  }

  function prepareAnalyzeProgress() {
    fillJobs(
      '<div class="job-card running" data-tour-demo="job-running">' +
        '<div class="job-card-head">' +
        '<span class="job-card-index">1</span><span class="job-status-dot running"></span>' +
        '<span class="job-card-url">ibank-ax.com/</span><span class="job-card-vp">PC</span></div>' +
        '<div class="job-card-meta">태깅중…</div>' +
        '<div class="job-card-progress"><div class="job-card-progress-fill" style="width:42%"></div></div></div>' +
        '<div class="job-card running" data-tour-demo="job-naming">' +
        '<div class="job-card-head">' +
        '<span class="job-card-index">2</span><span class="job-status-dot running"></span>' +
        '<span class="job-card-url">ibank-ax.com/</span><span class="job-card-vp">MO</span></div>' +
        '<div class="job-card-meta">이름붙이는중…</div>' +
        '<div class="job-card-progress"><div class="job-card-progress-fill" style="width:68%"></div></div></div>'
    );
    snapShow($("#global-analyze-bar"));
    snapText($("#global-analyze-text"), "분석 진행 중 · 태깅 / 이름붙이기… (샘플)");
    snapShow($("#global-stop-btn"));
    snapShow($("#stop-analyze-btn"));
  }

  function prepareLogin() {
    fillJobs(
      '<div class="job-card done">' +
        '<div class="job-card-head">' +
        '<span class="job-card-index">1</span><span class="job-status-dot done"></span>' +
        '<span class="job-card-url">ibank-ax.com/</span><span class="job-card-vp">PC</span></div>' +
        '<div class="job-card-meta">완료 · 후보 24개</div></div>' +
        '<div class="job-card login_required" data-tour-demo="login-card">' +
        '<div class="job-card-head">' +
        '<span class="job-card-index">2</span><span class="job-status-dot login_required"></span>' +
        '<span class="job-card-url">ibank-ax.com/mypage</span><span class="job-card-vp">PC</span>' +
        '<button type="button" class="btn-secondary job-login" data-tour-demo="job-login" tabindex="-1">로그인하기</button></div>' +
        '<div class="job-card-meta">로그인 필요 · 요청 /mypage → 실제 / (샘플)</div></div>'
    );
    snapShow($("#interactive-login-bar"));
    snapShow($("#interactive-login-complete"));
    snapShow($("#interactive-login-cancel"));
    snapText(
      $("#interactive-login-status"),
      "로그인 창이 열림 · " + DEMO_MY_PAGE + " · 로그인 후 「로그인 완료」또는 창 닫기 (샘플)"
    );
  }

  function prepareAnalyzeRetry() {
    fillJobs(
      '<div class="job-card failed" data-tour-demo="job-failed">' +
        '<div class="job-card-head">' +
        '<span class="job-card-index">1</span><span class="job-status-dot failed"></span>' +
        '<span class="job-card-url">ibank-ax.com/</span><span class="job-card-vp">MO</span>' +
        '<button type="button" class="btn-secondary job-retry" data-tour-demo="retry" tabindex="-1">다시 시도</button></div>' +
        '<div class="job-card-meta">실패 · 시간 초과 (샘플)</div></div>' +
        '<div class="job-group-divider"><span>완료된 분석</span><small>다시 실행하려면 「다시 분석」</small></div>' +
        '<div class="job-card done" data-tour-demo="job-done">' +
        '<div class="job-card-head">' +
        '<span class="job-card-index">2</span><span class="job-status-dot done"></span>' +
        '<span class="job-card-url">ibank-ax.com/</span><span class="job-card-vp">PC</span>' +
        '<button type="button" class="btn-secondary job-reanalyze" data-tour-demo="job-reanalyze" tabindex="-1">다시 분석</button></div>' +
        '<div class="job-card-meta">완료 · 후보 24개</div></div>'
    );
    snapShow($("#retry-failed-btn"));
  }

  function pickCb(checked) {
    return (
      '<input type="checkbox" class="tree-select-cb" tabindex="-1"' +
      (checked ? " checked" : "") +
      " />"
    );
  }

  function pickParamBtn() {
    return (
      '<button type="button" class="param-btn" data-tour-demo="param-btn" tabindex="-1" ' +
      'aria-label="이벤트 파라미터 보기" title="이벤트 파라미터 보기">{ }</button>'
    );
  }

  /** Real tree HTML sample. bannerCollapsed=true hides banner children (▸). */
  function buildPickTreeHtml(bannerCollapsed) {
    const bannerChev = bannerCollapsed ? "▸" : "▾";
    const bannerChild =
      bannerCollapsed
        ? ""
        : '<li class="label-row" data-tour-demo="label-banner">' +
          '<div class="tree-item-main">' +
          pickCb(false) +
          '<span class="tree-tier-pill pill-label">요소</span> ' +
          '<strong class="label-text">메인 배너</strong> ' +
          '<span class="meta tag-id-meta">#21</span>' +
          "</div>" +
          pickParamBtn() +
          "</li>";

    return (
      '<li class="tree-page active-page" data-tour-demo="tree-page">' +
      '<div class="tree-item-main">' +
      pickCb(true) +
      '<span class="tree-chevron">▾</span>' +
      '<span class="tree-tier-pill pill-page">페이지</span>' +
      '<span class="tree-tier-pill pill-html" title="사이트 HTML 분석">HTML</span>' +
      '<span class="tree-row-title">홈</span>' +
      '<span class="meta tree-row-count">클릭 ×5 · 페이지뷰</span>' +
      '<span class="page-pv-line">' +
      '<span class="tree-tier-pill pill-pageview">페이지뷰</span>' +
      '<span class="page-pv-label">홈</span>' +
      '<span class="meta page-pv-hint">자동 수집 · 클릭 요소 아님</span>' +
      "</span>" +
      '<span class="page-url">' +
      DEMO_URL +
      "</span>" +
      "</div>" +
      pickParamBtn() +
      "</li>" +
      '<li class="tree-category" data-tour-demo="tree-category">' +
      pickCb(true) +
      '<span class="tree-row-body">' +
      '<span class="tree-chevron">▾</span>' +
      '<span class="tree-tier-pill pill-category">카테고리</span>' +
      '<span class="tree-row-title">메인</span>' +
      '<span class="meta tree-row-count">×5</span>' +
      "</span></li>" +
      '<li class="tree-action" data-tour-demo="tree-action-gnb">' +
      pickCb(true) +
      '<span class="tree-row-body">' +
      '<span class="tree-chevron">▾</span>' +
      '<span class="tree-tier-pill pill-action">액션</span>' +
      '<span class="tree-row-title">GNB</span>' +
      '<span class="meta tree-row-count">×2</span>' +
      "</span></li>" +
      '<li class="label-row selected" data-tour-demo="label-product">' +
      '<div class="tree-item-main">' +
      pickCb(true) +
      '<span class="tree-tier-pill pill-label">요소</span> ' +
      '<strong class="label-text">제품</strong> ' +
      '<span class="meta tag-id-meta">#12</span>' +
      "</div>" +
      pickParamBtn() +
      "</li>" +
      '<li class="label-row" data-tour-demo="label-event">' +
      '<div class="tree-item-main">' +
      pickCb(true) +
      '<span class="tree-tier-pill pill-label">요소</span> ' +
      '<strong class="label-text">이벤트</strong> ' +
      '<span class="meta tag-id-meta">#13</span>' +
      "</div>" +
      pickParamBtn() +
      "</li>" +
      '<li class="tree-action" data-tour-demo="tree-action-banner">' +
      pickCb(false) +
      '<span class="tree-row-body">' +
      '<span class="tree-chevron" data-tour-demo="chevron-collapsed">' +
      bannerChev +
      "</span>" +
      '<span class="tree-tier-pill pill-action">액션</span>' +
      '<span class="tree-row-title">메인 배너</span>' +
      '<span class="meta tree-row-count">×1</span>' +
      "</span></li>" +
      bannerChild +
      '<li class="tree-action" data-tour-demo="tree-action-reco">' +
      pickCb(true) +
      '<span class="tree-row-body">' +
      '<span class="tree-chevron">▾</span>' +
      '<span class="tree-tier-pill pill-action">액션</span>' +
      '<span class="tree-row-title">추천 상품</span>' +
      '<span class="meta tree-row-count">×2</span>' +
      "</span></li>" +
      '<li class="label-row" data-tour-demo="label-detail">' +
      '<div class="tree-item-main">' +
      pickCb(true) +
      '<span class="tree-tier-pill pill-label">요소</span> ' +
      '<strong class="label-text">상품상세</strong> ' +
      '<span class="meta tag-id-meta">#44, #49</span>' +
      "</div>" +
      pickParamBtn() +
      "</li>" +
      '<li class="label-row" data-tour-demo="label-cart">' +
      '<div class="tree-item-main">' +
      pickCb(true) +
      '<span class="tree-tier-pill pill-label">요소</span> ' +
      '<strong class="label-text">장바구니 담기</strong> ' +
      '<span class="meta tag-id-meta">#45, #50</span>' +
      "</div>" +
      pickParamBtn() +
      "</li>"
    );
  }

  function closeTourParamDrawer() {
    const drawer = $("#param-drawer");
    const backdrop = $("#param-drawer-backdrop");
    const tooltip = $("#tour-tooltip", root);
    if (drawer) {
      drawer.classList.remove("open", "tour-elevated");
      drawer.hidden = true;
      drawer.setAttribute("aria-hidden", "true");
      drawer.style.zIndex = "";
    }
    if (backdrop) {
      backdrop.classList.remove("open", "tour-elevated");
      backdrop.hidden = true;
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.style.zIndex = "";
    }
    if (tooltip) tooltip.classList.remove("tour-above-drawer");
  }

  function openTourParamDrawer(editMode) {
    const drawer = $("#param-drawer");
    const backdrop = $("#param-drawer-backdrop");
    const badge = $("#param-drawer-badge");
    const label = $("#param-drawer-label");
    const sub = $("#param-drawer-sub");
    const body = $("#param-drawer-body");
    const editBtn = $("#param-toggle-edit");
    const jsonBtn = $("#param-toggle-json");
    const saveBtn = $("#param-save-btn");
    const copyBtn = $("#param-copy-btn");
    const tooltip = $("#tour-tooltip", root);

    if (backdrop) {
      uiSnapshots.push({
        el: backdrop,
        hidden: backdrop.hidden,
        ariaHidden: backdrop.getAttribute("aria-hidden"),
        className: backdrop.className,
        styleCss: backdrop.style.cssText,
      });
      backdrop.hidden = false;
      backdrop.setAttribute("aria-hidden", "false");
      // Must use .open (slide-in). Also raise above tour dim (z-index 10000).
      backdrop.classList.add("open", "tour-elevated");
      backdrop.style.zIndex = "10040";
    }
    if (drawer) {
      uiSnapshots.push({
        el: drawer,
        hidden: drawer.hidden,
        ariaHidden: drawer.getAttribute("aria-hidden"),
        className: drawer.className,
        styleCss: drawer.style.cssText,
      });
      drawer.hidden = false;
      drawer.setAttribute("aria-hidden", "false");
      drawer.classList.add("open", "tour-elevated");
      drawer.style.zIndex = "10050";
    }
    if (tooltip) tooltip.classList.add("tour-above-drawer");
    if (badge) {
      uiSnapshots.push({ el: badge, className: badge.className, text: badge.textContent });
      badge.className = "param-event-badge click";
      badge.textContent = "click_gnb";
    }
    if (label) snapText(label, "제품");
    if (sub) snapText(sub, "tag_id 12 · 메인");
    if (editBtn) {
      uiSnapshots.push({
        el: editBtn,
        hidden: editBtn.hidden,
        text: editBtn.textContent,
        className: editBtn.className,
      });
      editBtn.hidden = false;
      editBtn.textContent = editMode ? "표 보기" : "수정";
      editBtn.classList.toggle("active", !!editMode);
    }
    if (jsonBtn) {
      uiSnapshots.push({
        el: jsonBtn,
        hidden: jsonBtn.hidden,
        text: jsonBtn.textContent,
      });
      jsonBtn.hidden = !!editMode;
      jsonBtn.textContent = "JSON 보기";
    }
    if (saveBtn) {
      uiSnapshots.push({ el: saveBtn, hidden: saveBtn.hidden });
      saveBtn.hidden = !editMode;
    }
    if (copyBtn) {
      uiSnapshots.push({ el: copyBtn, hidden: copyBtn.hidden });
      copyBtn.hidden = !!editMode;
    }
    if (body) {
      uiSnapshots.push({ el: body, html: body.innerHTML });
      if (editMode) {
        body.innerHTML =
          '<form class="param-edit-form" id="param-edit-form" data-tour-demo="param-edit">' +
          '<p class="param-edit-hint">카테고리·액션·라벨이 기존 그룹과 같으면 그 그룹으로 합쳐집니다.</p>' +
          '<label>카테고리 (page_category)<input name="page_category" value="메인" readonly tabindex="-1" /></label>' +
          '<label>액션 / 영역 (action)<input name="action" value="GNB" readonly tabindex="-1" /></label>' +
          '<label>라벨 (label)<input name="label" value="제품" readonly tabindex="-1" /></label>' +
          '<label>이벤트명 (event_name)<input name="event_name" value="click_gnb" readonly tabindex="-1" /></label>' +
          '<label>링크 URL (link_url)<input name="link_url" value="/products" readonly tabindex="-1" /></label>' +
          "</form>";
      } else {
        body.innerHTML =
          '<table class="param-kv-table" data-tour-demo="param-table"><tbody>' +
          "<tr><th>page_category</th><td>메인</td></tr>" +
          "<tr><th>action</th><td>GNB</td></tr>" +
          "<tr><th>label</th><td>제품</td></tr>" +
          "<tr><th>event_name</th><td>click_gnb</td></tr>" +
          "<tr><th>tag_id</th><td>12</td></tr>" +
          "<tr><th>link_url</th><td>/products</td></tr>" +
          "</tbody></table>";
      }
    }

    // Mark source row like the real UI
    const source = $("[data-tour-demo='label-product']");
    if (source) {
      uiSnapshots.push({ el: source, className: source.className });
      source.classList.add("selected", "param-source-active");
    }
  }

  function syncTourPreviewOverlay() {
    const img = $("#preview-image");
    const overlay = $("#preview-overlay");
    const stage = $("#preview-stage");
    if (!img || !overlay) return;
    const apply = () => {
      const w = img.clientWidth || 0;
      const h = img.clientHeight || 0;
      if (!w || !h) return;
      if (stage) {
        stage.style.width = w + "px";
        stage.style.height = h + "px";
      }
      overlay.style.width = w + "px";
      overlay.style.height = h + "px";
    };
    apply();
    if (!img.complete) {
      img.addEventListener("load", apply, { once: true });
    }
    requestAnimationFrame(apply);
  }

  function renderTourPreviewBoxes() {
    const overlay = $("#preview-overlay");
    if (!overlay) return;
    // Matches PREVIEW_SVG (960×720) + real .preview-highlight-box / .preview-box-label.
    // Only checked sample rows (배너 #21 제외).
    const box = (left, top, w, h, tagId) =>
      '<div class="preview-highlight-box" data-tour-demo="preview-box" style="left:' +
      left +
      "%;top:" +
      top +
      "%;width:" +
      w +
      "%;height:" +
      h +
      '%;">' +
      '<span class="preview-box-label">' +
      tagId +
      "</span></div>";
    overlay.innerHTML =
      box(22.9, 2.8, 9.2, 4.4, "12") + // GNB 제품
      box(33.3, 2.8, 9.2, 4.4, "13") + // GNB 이벤트
      box(4.2, 51.4, 20.8, 30.6, "44") + // 상품상세
      box(5.8, 76.9, 10.4, 3.3, "45"); // 담기
    syncTourPreviewOverlay();
  }

  function preparePickBase(opts) {
    const bannerCollapsed = !!(opts && opts.bannerCollapsed);
    closeTourParamDrawer();
    // Block Workspace from redrawing live bboxes onto the sample capture.
    window.__TOUR_LOCK_PREVIEW__ = true;

    const list = $("#list");
    if (list) list.innerHTML = buildPickTreeHtml(bannerCollapsed);

    snapText($("#selection-summary"), "포함 4 / 전체 6 (샘플)");
    const dock = $("#pick-confirm-dock");
    if (dock) dock.hidden = false;
    const countEl = $("#count");
    if (countEl) snapText(countEl, "카테고리 1 · 액션 3 · 요소 5");

    const empty = $("#preview-empty");
    if (empty) {
      uiSnapshots.push({ el: empty, hidden: empty.hidden });
      empty.hidden = true;
    }
    const shell = $("#preview-shell");
    if (shell) {
      uiSnapshots.push({
        el: shell,
        hidden: shell.hidden,
        className: shell.className,
      });
      shell.hidden = false;
      shell.classList.add("pc");
      shell.classList.remove("mo");
    }
    const img = $("#preview-image");
    if (img) {
      uiSnapshots.push({ el: img, attrSrc: img.getAttribute("src") });
      // Drop live onload handlers that would repaint 실제 분석 박스를 샘플 위에 덧그림
      img.onload = null;
      img.onerror = null;
      img.setAttribute("src", PREVIEW_SVG);
      img.addEventListener(
        "load",
        () => {
          if (!window.__TOUR_LOCK_PREVIEW__) return;
          renderTourPreviewBoxes();
        },
        { once: true }
      );
    }
    const overlay = $("#preview-overlay");
    if (overlay) {
      uiSnapshots.push({
        el: overlay,
        html: overlay.innerHTML,
        styleCss: overlay.style.cssText,
      });
      renderTourPreviewBoxes();
    }
    const stage = $("#preview-stage");
    if (stage) {
      uiSnapshots.push({ el: stage, styleCss: stage.style.cssText });
    }
    const msg = $("#preview-message");
    if (msg) {
      uiSnapshots.push({ el: msg, hidden: msg.hidden, text: msg.textContent });
      msg.hidden = true;
      msg.textContent = "";
    }
    const status = $("#status-text");
    if (status) snapText(status, "샘플 · 태그 선택 미리보기");
    const validation = $("#position-validation-panel");
    if (validation) {
      uiSnapshots.push({ el: validation, hidden: validation.hidden });
      validation.hidden = true;
    }
    const nextBtn = $("#wizard-next");
    if (nextBtn) {
      uiSnapshots.push({
        el: nextBtn,
        disabled: nextBtn.disabled,
        text: nextBtn.textContent,
      });
      nextBtn.disabled = false;
      nextBtn.textContent = "확정하고 다음";
    }
  }

  function preparePick() {
    document.body.classList.remove("tour-emphasize-checks");
    preparePickBase({ bannerCollapsed: false });
  }

  function preparePickCollapse() {
    document.body.classList.remove("tour-emphasize-checks");
    preparePickBase({ bannerCollapsed: true });
  }

  function preparePickConfirm() {
    preparePickBase({ bannerCollapsed: false });
    document.body.classList.add("tour-emphasize-checks");
    // Make checked vs unchecked obvious in the sample tree
    $$("#list .tree-select-cb").forEach((cb) => {
      const row = cb.closest("li");
      if (!row) return;
      if (cb.checked) row.classList.add("tour-check-on");
      else row.classList.add("tour-check-off");
    });
    snapText($("#selection-summary"), "포함 4 / 전체 6 · 체크한 것만 확정");
    const dockConfirm = $("#pick-confirm-dock");
    if (dockConfirm) dockConfirm.hidden = false;
  }

  function preparePickParam() {
    document.body.classList.remove("tour-emphasize-checks");
    preparePick();
    openTourParamDrawer(false);
    // Keep footer (수정·JSON·복사) in view for tips 12–13
    const foot = $("#param-drawer-foot");
    if (foot) foot.scrollIntoView({ block: "end", behavior: "auto" });
  }

  function preparePickParamEdit() {
    document.body.classList.remove("tour-emphasize-checks");
    preparePick();
    openTourParamDrawer(true);
    const foot = $("#param-drawer-foot");
    if (foot) foot.scrollIntoView({ block: "end", behavior: "auto" });
  }

  function prepareTaxonomy() {
    const empty = $("#taxonomy-empty");
    if (empty) empty.hidden = true;
    const content = $("#taxonomy-content");
    if (content) content.hidden = false;
    const wrap = $("#taxonomy-table-wrap");
    if (wrap) {
      wrap.innerHTML =
        '<table data-tour-demo="tax-table"><thead><tr>' +
        "<th>이벤트</th><th>카테고리</th><th>액션</th><th>라벨</th></tr></thead><tbody>" +
        "<tr><td>click_gnb</td><td>GNB</td><td>click</td><td>제품</td></tr>" +
        "<tr><td>click_gnb</td><td>GNB</td><td>click</td><td>이벤트</td></tr>" +
        "<tr><td>click_banner</td><td>배너</td><td>click</td><td>메인 배너</td></tr>" +
        "</tbody></table>";
    }
  }

  function prepareExport() {
    const stats = $("#export-stats");
    if (stats) {
      stats.innerHTML =
        '<div class="export-stat" data-tour-demo="stat"><div class="val">1</div><div class="lbl">사이트</div></div>' +
        '<div class="export-stat"><div class="val">2</div><div class="lbl">페이지</div></div>' +
        '<div class="export-stat"><div class="val">12</div><div class="lbl">이벤트</div></div>';
    }
    const preview = $("#export-preview");
    if (preview) {
      preview.innerHTML =
        "<table class='export-preview-table' data-tour-demo='export-preview'><thead><tr>" +
        "<th>이벤트명</th><th>시점</th><th>카테고리</th><th>액션</th><th>라벨</th><th>설명</th>" +
        "</tr></thead><tbody>" +
        "<tr><td>클릭</td><td>상단 GNB에서 '제품'을 클릭했을 때</td><td>GNB</td><td>GNB</td><td>제품</td><td>GNB 제품 클릭</td></tr>" +
        "<tr><td>페이지뷰</td><td>메인 페이지가 로드·노출되었을 때</td><td>-</td><td>-</td><td>-</td><td>메인 페이지 조회</td></tr>" +
        "</tbody></table>";
    }
  }

  function prepareStep(kind) {
    restoreUi();
    $$("[data-tour-demo='settings-panel']").forEach((el) => el.remove());
    if (kind === "project") prepareProject();
    else if (kind === "project-settings") prepareProjectSettings();
    else if (kind === "site") prepareSite();
    else if (kind === "analyze-idle") prepareAnalyzeIdle();
    else if (kind === "analyze-tagging") prepareAnalyzeTagging();
    else if (kind === "analyze-naming") prepareAnalyzeNaming();
    else if (kind === "analyze-capturing") prepareAnalyzeCapturing();
    else if (kind === "analyze-progress") prepareAnalyzeProgress();
    else if (kind === "login") prepareLogin();
    else if (kind === "analyze-retry") prepareAnalyzeRetry();
    else if (kind === "pick") preparePick();
    else if (kind === "pick-collapse") preparePickCollapse();
    else if (kind === "pick-confirm") preparePickConfirm();
    else if (kind === "pick-param") preparePickParam();
    else if (kind === "pick-param-edit") preparePickParamEdit();
    else if (kind === "taxonomy") prepareTaxonomy();
    else if (kind === "export") prepareExport();
  }

  function ensureRoot() {
    if (root) return root;
    root = document.createElement("div");
    root.id = "tutorial-tour-root";
    root.className = "tour-root";
    root.hidden = true;
    root.setAttribute("aria-modal", "true");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "사용방법");
    root.innerHTML = `
      <div class="tour-blocker" aria-hidden="true"></div>
      <div class="tour-spotlight" id="tour-spotlight" hidden></div>
      <div class="tour-tooltip" id="tour-tooltip" role="status">
        <div class="tour-tooltip-kicker">
          <span class="tour-sample-badge">샘플</span>
          <span id="tour-step-label">1 / N</span>
        </div>
        <h3 id="tour-title"></h3>
        <p id="tour-body"></p>
        <div class="tour-tooltip-actions">
          <button type="button" class="tour-btn ghost" data-tour-action="skip">닫기</button>
          <button type="button" class="tour-btn ghost" data-tour-action="prev" id="tour-prev">이전</button>
          <button type="button" class="tour-btn primary" data-tour-action="next" id="tour-next">다음</button>
        </div>
      </div>`;
    document.body.appendChild(root);

    root.addEventListener("click", (e) => {
      const action = e.target.closest("[data-tour-action]")?.dataset.tourAction;
      if (!action) return;
      if (action === "next") next();
      else if (action === "prev") prev();
      else if (action === "skip") stop();
    });

    window.addEventListener("resize", () => {
      if (active) positionSpotlight();
    });
    window.addEventListener(
      "scroll",
      () => {
        if (active) positionSpotlight();
      },
      true
    );
    return root;
  }

  function resolveTarget(selector) {
    const parts = String(selector || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const part of parts) {
      const el = document.querySelector(part);
      if (el && !el.hidden && el.getClientRects().length) return el;
    }
    for (const part of parts) {
      const el = document.querySelector(part);
      if (el) return el;
    }
    return null;
  }

  /** When tip.union is true, collect every matching selector for a combined spotlight. */
  function resolveTargetList(selector, union) {
    const parts = String(selector || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!union) {
      const one = resolveTarget(selector);
      return one ? [one] : [];
    }
    const out = [];
    const seen = new Set();
    for (const part of parts) {
      const el = document.querySelector(part);
      if (!el || el.hidden || !el.getClientRects().length) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
    if (!out.length) {
      const one = resolveTarget(selector);
      if (one) out.push(one);
    }
    return out;
  }

  function unionRect(els) {
    let top = Infinity;
    let left = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      top = Math.min(top, r.top);
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (!isFinite(top)) return null;
    return { top, left, right, bottom, width: right - left, height: bottom - top };
  }

  function positionSpotlight() {
    const tip = activeTips[tipIndex];
    const spotlight = $("#tour-spotlight", root);
    const tooltip = $("#tour-tooltip", root);
    if (!tip || !spotlight || !tooltip) return;

    $$(".tour-target-pulse").forEach((el) => el.classList.remove("tour-target-pulse"));

    const targets = resolveTargetList(tip.target, !!tip.union);
    if (!targets.length) {
      spotlight.hidden = true;
      tooltip.style.top = "22%";
      tooltip.style.left = "50%";
      tooltip.style.transform = "translateX(-50%)";
      return;
    }

    const isDrawerTarget = targets.some(
      (t) =>
        t.id === "param-drawer" ||
        t.id === "param-drawer-foot" ||
        t.id === "param-edit-form" ||
        !!t.closest("#param-drawer")
    );
    if (!isDrawerTarget) {
      targets[0].scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    }
    const pad = 6;
    const r = unionRect(targets);
    if (!r) {
      spotlight.hidden = true;
      return;
    }
    spotlight.hidden = false;
    spotlight.style.top = Math.max(4, r.top - pad) + "px";
    spotlight.style.left = Math.max(4, r.left - pad) + "px";
    spotlight.style.width = Math.max(24, r.width + pad * 2) + "px";
    spotlight.style.height = Math.max(24, r.height + pad * 2) + "px";
    targets.forEach((t) => t.classList.add("tour-target-pulse"));

    const tipW = tooltip.offsetWidth || 340;
    const tipH = tooltip.offsetHeight || 170;
    let top;
    let left;
    if (isDrawerTarget) {
      // Pin tip on the left half so the elevated drawer never covers 12–13 copy.
      left = 20;
      top = Math.min(Math.max(72, (window.innerHeight - tipH) / 2), window.innerHeight - tipH - 12);
      tooltip.classList.add("tour-above-drawer");
    } else if (r.left > window.innerWidth * 0.55) {
      left = Math.max(12, r.left - tipW - 16);
      top = Math.min(Math.max(12, r.top + 24), window.innerHeight - tipH - 12);
    } else {
      top = r.bottom + 12;
      left = Math.min(r.left, window.innerWidth - tipW - 12);
      if (top + tipH > window.innerHeight - 12) top = Math.max(12, r.top - tipH - 12);
      if (left < 12) left = 12;
      tooltip.classList.remove("tour-above-drawer");
    }
    // Keep tip readable above large union spotlights (tip 14 list+next).
    if (!isDrawerTarget && r.height > window.innerHeight * 0.55) {
      left = 20;
      top = 72;
    }
    tooltip.style.transform = "none";
    tooltip.style.top = top + "px";
    tooltip.style.left = left + "px";
  }

  function renderTip() {
    const tip = activeTips[tipIndex];
    if (!tip) return;
    prepareStep(tip.prepare);
    const isLast = tipIndex >= activeTips.length - 1;
    const name = WIZARD_NAMES[wizardStep] || "사용방법";
    $("#tour-step-label", root).textContent =
      name + " · " + (tipIndex + 1) + " / " + activeTips.length;
    $("#tour-title", root).textContent = tip.title;
    const bodyEl = $("#tour-body", root);
    if (tip.bodyHtml) {
      bodyEl.innerHTML = withNextHint(tip.bodyHtml, isLast);
    } else {
      bodyEl.textContent = withNextHint(tip.body, isLast);
    }
    const nextBtn = $("#tour-next", root);
    const prevBtn = $("#tour-prev", root);
    // Always 「다음」 — last tip also finishes by pressing 「다음」
    if (nextBtn) nextBtn.textContent = "다음";
    if (prevBtn) prevBtn.disabled = tipIndex === 0;
    const needsDrawerSettle =
      tip.prepare === "pick-param" || tip.prepare === "pick-param-edit";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        positionSpotlight();
        syncTourPreviewOverlay();
        // Wait for param-drawer slide-in (.open transform) before measuring.
        if (needsDrawerSettle) {
          window.setTimeout(() => {
            positionSpotlight();
          }, 280);
        }
      });
    });
  }

  function start(forWizardStep) {
    ensureRoot();
    wizardStep =
      forWizardStep != null && forWizardStep !== ""
        ? Number(forWizardStep)
        : currentWizardStep();
    activeTips = ALL_TIPS.filter((t) => t.step === wizardStep);
    if (!activeTips.length) {
      window.alert("이 단계의 사용방법이 아직 없습니다.");
      return;
    }
    if (active) stop();
    active = true;
    tipIndex = 0;
    captureDom();
    root.hidden = false;
    document.body.classList.add("tour-active");
    renderTip();
  }

  function stop() {
    if (!root) return;
    active = false;
    root.hidden = true;
    document.body.classList.remove("tour-active", "tour-emphasize-checks");
    window.__TOUR_LOCK_PREVIEW__ = false;
    restoreUi();
    closeTourParamDrawer();
    $$("[data-tour-demo='settings-panel']").forEach((el) => el.remove());
    restoreDom();
    $$(".tour-target-pulse").forEach((el) => el.classList.remove("tour-target-pulse"));
    activeTips = [];
    tipIndex = 0;
    // Sample fixtures replace innerHTML and wipe click handlers — ask wizard to rebind.
    try {
      if (typeof window.__WIZARD_AFTER_TOUR__ === "function") {
        window.__WIZARD_AFTER_TOUR__();
      }
    } catch (err) {
      console.error("[tutorial-tour] after-tour restore failed:", err);
    }
  }

  function next() {
    if (tipIndex >= activeTips.length - 1) {
      stop();
      return;
    }
    tipIndex += 1;
    renderTip();
  }

  function prev() {
    if (tipIndex <= 0) return;
    tipIndex -= 1;
    renderTip();
  }

  function bindLaunchers() {
    document.querySelectorAll("[data-open-tutorial], #wizard-tutorial-btn, .wizard-tutorial-link").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (el.tagName === "A") e.preventDefault();
        start(currentWizardStep());
      });
    });

    try {
      const params = new URLSearchParams(location.search);
      if (params.get("tutorial") === "1" || params.get("guide") === "1") {
        const url = new URL(location.href);
        url.searchParams.delete("tutorial");
        url.searchParams.delete("guide");
        history.replaceState({}, "", url.pathname + url.search + url.hash);
        setTimeout(() => start(currentWizardStep()), 500);
      }
    } catch {
      /* ignore */
    }
  }

  window.TutorialTour = {
    start,
    stop,
    next,
    prev,
    /** For docs/QA: tip catalog grouped by wizard step */
    listSteps: function () {
      const out = {};
      for (const tip of ALL_TIPS) {
        const key = tip.step;
        if (!out[key]) out[key] = { name: WIZARD_NAMES[key], tips: [] };
        out[key].tips.push({ title: tip.title, body: tip.body });
      }
      return out;
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindLaunchers);
  } else {
    bindLaunchers();
  }
})();
