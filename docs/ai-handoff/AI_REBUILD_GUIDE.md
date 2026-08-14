# 자동 태깅 (auto-tagging) — AI 재구현 가이드

> **목적:** 다른 AI/개발자가 이 문서만 읽고 **동일한 제품·코드 구조·운영 방식**을 재현할 수 있게 한다.  
> **기준 시점:** 2026-08-12 · **버전:** v3.5.0+  
> **저장소:** https://github.com/Jochangheon/auto-tagging (`main`)

---

## 1. 제품 한 줄 요약

Microsoft 로그인 → **프로젝트 선택** → **사이트 입력 & 자동 분석** → **영역 이미지가 포함된 택소노미 확인·수정·Excel 내보내기**.

웹 앱은 **Express 백엔드 + `public/` 정적 마법사 UI** (React/Vite 없음). 상태는 **localStorage가 아니라 DB**에 영속.

---

## 2. 저장소 구조

```
자동태깅3/
├── package.json              # workspaces: shared + backend, npm scripts
├── VERSION                   # 단일 버전 소스 (v3.5.0)
├── CHANGELOG.md
├── README.md
├── PLAN.md                   # 기획·파이프라인 상세 (한국어)
├── .env.example              # → packages/backend/.env 로 복사
├── docs/
│   ├── PROMPT_HISTORY.md     # 사용자 요구 변경 이력
│   ├── MICROSOFT-LOGIN.md
│   └── ai-handoff/           # ← 이 문서
└── packages/
    ├── shared/               # @autotag/shared — 타입·공통 로직
    │   ├── src/
    │   │   ├── taxonomy.ts
    │   │   ├── tagging-canonical.ts
    │   │   ├── event-params.ts
    │   │   ├── crawl-job.ts
    │   │   ├── candidate-merge.ts
    │   │   ├── element-location.ts
    │   │   └── ...
    │   └── dist/             # tsc 빌드 산출 (gitignore)
    └── backend/              # @autotag/backend — API + UI + 크롤
        ├── src/
        │   ├── server.ts
        │   ├── routes/       # dev-test, projects, auth, ...
        │   ├── crawl/        # Firecrawl, 캡처, 트리, job
        │   ├── taxonomy/     # 빌더, Excel, 액션 이미지
        │   ├── llm/
        │   ├── db/
        │   └── auth/
        ├── public/           # 마법사 UI (Vanilla JS)
        │   ├── index.html
        │   ├── login.html
        │   ├── css/
        │   └── js/
        │       ├── wizard-app.js      # 3단계 오케스트레이션
        │       ├── workspace-core.js  # 트리·택소노미·미리보기 핵심
        │       └── tutorial-tour.js
        ├── migrations/       # SQL (001~004)
        ├── data/             # 런타임 (captures, pglite — gitignore)
        └── scripts/
            └── copy-crawl-assets.mjs  # build 시 .mjs 복사 필수
```

**모노레포 규칙**
- `shared`를 먼저 빌드 → `backend`가 `@autotag/shared` import.
- backend `build` = `tsc` + `copy-crawl-assets.mjs` (polyfill/load-env/overlay 복사).
- 실행: `node --import ./src/polyfill.mjs dist/server.js` (또는 dev: `tsx watch`).

---

## 3. 기술 스택

| 영역 | 기술 |
|------|------|
| 런타임 | Node.js ≥18, ESM (`"type": "module"`) |
| API | Express 4, JSON body 12mb |
| DB | PGlite(기본) 또는 PostgreSQL (`DATABASE_URL`) |
| 크롤 | Firecrawl API, Playwright/CDP |
| 이미지 | sharp (페이지/요소/액션 크롭) |
| LLM | OpenRouter 또는 Gemini (`LLM_PROVIDER`) |
| Excel | exceljs |
| UI | Vanilla HTML/CSS/JS, Pretendard CDN |
| 인증 | Microsoft Azure AD OAuth |
| 배포 | PM2 + nginx (Ubuntu 22.04) |

---

## 4. 3단계 마법사 (UI)

| step | panel id | JS 담당 | 설명 |
|------|----------|---------|------|
| 0 | `panel-0` | `wizard-app.js` | 프로젝트 선택·생성 (`/api/projects`) |
| 1 | `panel-1` + 내부 `panel-2` | `wizard-app.js` | URL 발견·PC/MO 확정 + 배치 분석. 완료 후 전체 후보를 자동 포함·confirm |
| 2 | `panel-4` (`data-step=2`) | `workspace-core.js` | 영역 이미지가 포함된 택소노미 표, 인라인 수정, Excel 다운로드 |

`panel-3` 후보 트리 DOM은 `workspace-core.js` 호환을 위해 남아 있지만 사용자 단계에서는 숨긴다. 기존 `panel-5` 보내기 화면은 제거하고 다운로드를 택소노미 화면에 합쳤다.

1단계에서 「분석 대상 URL」 목록과 「분석 페이지 목록」은 한 목록으로 합쳤다. `renderUrlRows()`가 행 골격을, `updateUrlRowStatuses()`가 PC/MO 상태 칩·진행 바·행 단위 실행 버튼(분석 실행 / 다시 분석 / 다시 시도 / 로그인하기)을 갱신한다. `renderJobCards()`는 폴링마다 `updateUrlRowStatuses()`를 호출하고, 원래의 `#job-cards` 컨테이너는 내부 호환용으로 숨겨둔 채 유지한다.

**파일 역할 분리**
- `wizard-app.js`: 단계 전환, 프로젝트, URL 발견, 분석 배치, autosave, auth pill.
- `workspace-core.js`: `renderSessionTree`, `renderTaxonomyMatrixTable`, 미리보기 bbox, param drawer, taxonomy PATCH.
- `index.html`: 3단계 패널 마크업. 분석과 URL 입력, 택소노미와 Excel을 각각 한 화면으로 합침.

**캐시 버스팅:** `index.html`의 `?v=YYYYMMDDx` 를 CSS/JS 수정 시 반드시 bump. 서버는 `no-store` 헤더.

---

## 5. 도메인 모델 (필수 이해)

### 5.1 CAL (카테고리 · 액션 · 라벨)

공식 정의: `packages/shared/src/tagging-canonical.ts`

| 필드 | 의미 | 예 |
|------|------|-----|
| **page_category** / category (UI) | 페이지명(탭) | 메인, 상품상세 |
| **action** | 화면 영역 | GNB, 메인 배너 |
| **label** | 버튼/링크 이름 | App Store 다운로드 |

**페이지뷰 (tag_id=0):** 클릭 CAL 없음. 파라미터는 `page_name` 중심 (`category`/`action`/`label` 비움).

### 5.2 후보 트리 (내부 호환용·사용자 화면에서는 숨김)

계층: **페이지 → 카테고리 → 액션 → 요소(라벨)**

- `PageNode.tree`: `CandidateTree` (grouper가 candidates에서 생성)
- `label_group`: merge_label로 묶인 클릭 후보들 (`member_tag_ids[]`)
- **선택:** `selection[pageUrl::tagId]` — 기본 true, false면 택소노미 제외

**현재 동작 (2026-08-12)**
- 분석 완료 시 모든 후보를 자동 포함하고 `POST /api/dev/confirm`을 호출한다.
- 후보 선택 화면은 기본 사용자 흐름에 노출하지 않는다.
- 아래 UI는 호환·디버깅 목적으로 코드에 남아 있다.
- **▸/▾:** 펼치기/접기만 (chevron)
- **행 클릭:** 오른쪽 미리보기 하이라이트만 (자동 펼침 없음)
- **포함 체크:** 택소노미 포함/제외
- **다중 수정·일괄 수정·수정 체크·인라인 CAL 편집:** **제거됨** (택소노미 단계에서만 수정)
- `{ }` param drawer: 페이지뷰 「상세」만 soft drawer (배경 dim 없음)

### 5.3 택소노미 (Confirm 이후)

**빌더:** `packages/backend/src/taxonomy/taxonomy-builder.ts`

**행 합치기 규칙 (2026-08-07):**
- 같은 **카테고리 + 액션** 아래 모든 `label_group` → **1행**
- **라벨:** `{{버튼명}}` (`TAXONOMY_LABEL_BUTTON_VAR` in `shared/taxonomy.ts`)
- **members:** 해당 액션의 모든 선택된 tag_id 후보
- **공통 탭:** 모든 분석 화면(페이지×viewport)에 동일 카+액이면 자동 공통 (`taxonomyCalKey` = category+action만 비교, label 제외)

**UI (panel-4):**
- 컬럼: 체크 · **액션 이미지** · 이벤트 · 카테고리 · 액션 · 라벨 · 발생시점 · 설명
- **연결 요소 펼침/▸/member 행:** **제거됨**
- 인라인 수정 + 일괄 바 + 「변경 저장」 (`PATCH /api/dev/taxonomy/rows/batch`)
- link_url, direction, 값 목록 탭: **없음**

**액션 이미지:**
- `taxonomy-action-images.ts` + `element-capture.cropActionGroupFromPagePng`
- 페이지 PNG에서 **모든 member bbox를 포함하는 union 영역** 크롭
- **각 요소 bbox는 개별 주황 네모** (합쳐진 1박스 X)
- 저장: `data/captures/{job_id}/actions/{fileKey}.png`
- API: `GET /api/dev/captures/:jobId/actions/:fileName.png`
- Excel 7번째 열 「액션 이미지」에 삽입 (`taxonomy-excel.ts`)
- **크롭 소스 폴백:** `member.element_location`의 `capture_url`·`bbox`가 비어 있어도 이미지가 나오도록, `attachActionImagesToTaxonomy(taxonomy, pages)`에 세션 페이지를 넘겨 `page.job_id` → 후보 `overlay_bbox` → 디스크 `positions.json` 순으로 되짚는다. 저장된 프로젝트를 다시 열 때는 `onlyMissing: true`로 빠진 행만 다시 만든다 (`routes/projects.ts`). 결과는 `[taxonomy] action images attached=N missing=M` 로그로 확인.

---

## 6. 분석 파이프라인

```
URL × viewport(PC/MO) = job 1개
  → Firecrawl bootstrap (키 풀에서 job별 1키 고정)
  → viewport 설정 (PC 1920 / MO 390)
  → tagLiveDom ([data-tag-id], platform, menu_reveal_path)
  → positions.json + page_view fullPage PNG (pc.png | mo.png)
  → HTML + LLM extract → candidates + tree
  → [Phase 1 done → awaiting_pick]  ← 후보 UI 즉시 표시
  → Phase 2: 요소별 element capture (tags/{tag_id}.png)
  → persist PageNode → DB (page_analyses)
```

| 모듈 | 경로 |
|------|------|
| 오케스트레이션 | `crawl/job-orchestrator.ts`, `dev/batch-analyze-queue.ts` |
| Firecrawl | `firecrawl-interact.ts`, `firecrawl-key-pool.ts` |
| 페이지 캡처 | `page-capture.ts` → `captureAbsPath(jobId, viewport)` |
| 요소 캡처 | `element-capture.ts` |
| 액션 크롭 | `element-capture.cropActionGroupFromPagePng` |
| LLM 추출 | `extractors/`, `llm/extract-llm-batch.ts` |
| 트리 그룹 | `candidate-grouper.ts`, `shared/candidate-merge.ts` |
| DB 저장 | `db/persist-page.ts`, `db/page-analyses.ts` |

**캡처 디스크 경로:** `packages/backend/data/captures/{job_id}/`
- `pc.png` / `mo.png` — 풀페이지
- `positions.json` — bbox
- `tags/{tag_id}.png` — 요소별
- `actions/{fileKey}.png` — 택소노미 액션 이미지

**주의:** PNG는 DB에 넣지 않음. URL만 PageNode에 저장. 서버 이전 시 `data/captures/` 동반 필수.

---

## 7. API 요약

### 인증
- `GET /login.html` — Microsoft OAuth
- `/api/auth/*` — callback, me, logout
- `/api/dev/*` — `requireAuth` (**예외:** `GET /api/dev/captures/*` — img 태그용)

### 프로젝트 `/api/projects`
- CRUD + settings
- taxonomy JSONB는 `projects` 또는 session에 저장

### 마법사 `/api/dev/*` (`routes/dev-test.ts`)

| Method | Path | 용도 |
|--------|------|------|
| POST | `/site-map`, `/site-map-stream` | URL 발견 |
| POST | `/analyze`, `/batch-analyze` | 분석 시작 |
| GET | `/jobs/:id/progress`, `/batch/:id/progress` | 진행 |
| GET | `/sessions/:id` | 세션·pages·selection |
| PATCH | `/candidates` | 후보 CAL 수정 (현재 pick UI에서는 미사용) |
| POST | `/confirm` | selection → taxonomy 빌드 + LLM describe + action images |
| PATCH | `/taxonomy/rows`, `/taxonomy/rows/batch` | 표 수정 → candidate 동기 |
| GET | `/taxonomy`, `/taxonomy/export` | 조회·Excel |
| GET | `/captures/:jobId/pc.png\|mo.png` | 페이지 캡처 |
| GET | `/captures/:jobId/tags/:tagId.png` | 요소 캡처 |
| GET | `/captures/:jobId/actions/:fileName.png` | 액션 크롭 |

### Health
- `GET /api/v1/health`

---

## 8. 데이터베이스

마이그레이션: `packages/backend/migrations/001_init.sql` ~ `004_project_options.sql`

| 테이블 | 용도 |
|--------|------|
| `users`, `auth_sessions` | Microsoft 로그인 |
| `projects` | 프로젝트 메타, settings |
| `page_analyses` | `(project_id, url, viewport)` → PageNode JSONB, selection |

**PageNode** (`shared/crawl-job.ts`): `page_url`, `job_id`, `tree`, `candidates[]`, `capture_url`, `active_viewport`, ...

**PGlite:** `PGLITE_DATA_DIR` — **한글 경로 피할 것** (Windows 로컬 이슈).

---

## 9. 미리보기 (Pick 단계 오른쪽)

`workspace-core.js`:

- `showAllPreviewPositions = true` (기본): 모든 label_group을 **union bbox 1개씩** 표시
- 행 클릭 시: `showAllPreviewPositions = false`, 해당 그룹 union 하이라이트
- **tag_id 숫자 오버레이:** 표시 안 함
- page_view 행: 풀페이지 PNG
- 요소: 가능하면 `tags/{tag_id}.png`, 없으면 page PNG + bbox

---

## 10. Excel 내보내기

`packages/backend/src/taxonomy/taxonomy-excel.ts`

**시트:** `공통`, `PC_{페이지카테고리}`, `MO_{...}`, `변수사전`

**이벤트 시트 컬럼 (7열):**
1. 이벤트명
2. 시점
3. 카테고리
4. 액션
5. 라벨 (`{{버튼명}}`)
6. 설명
7. 액션 이미지 (PNG embed, 행 높이 ~72)

**표기:** FNB → Footer (`normalizedDisplay`)

---

## 11. 환경 변수 (`packages/backend/.env`)

```env
PORT=3000
NODE_ENV=production

# Microsoft OAuth (필수 — 운영)
AZURE_AD_CLIENT_ID=
AZURE_AD_CLIENT_SECRET=
AZURE_AD_REDIRECT_URI=https://auto-button-tagging.kro.kr/api/auth/microsoft/callback
AZURE_AD_TENANT=common

# Firecrawl (쉼표 구분 키 풀)
FIRECRAWL_API_URL=https://api.firecrawl.dev
FIRECRAWL_API_KEYS=

# LLM
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=
LLM_MODEL=google/gemini-3.5-flash

# DB (선택)
# DATABASE_URL=postgres://...
# PGLITE_DATA_DIR=/opt/autotag/data/pglite

# 큐 동시성 (Firecrawl ≤2 권장)
FIRECRAWL_QUEUE_CONCURRENCY=2
LLM_QUEUE_CONCURRENCY=4
CAPTURE_QUEUE_CONCURRENCY=3

# 로컬만: AUTH_DISABLED=1
```

**절대 git commit 금지:** `.env`, `FIRECRAWL_KEYS.md`, `data/captures/`, `data/pglite/`, OAuth JSON.

---

## 12. 운영 배포 (현재)

| 항목 | 값 |
|------|-----|
| 서버 | `49.247.40.177` (Ubuntu 22.04) |
| 앱 경로 | `/opt/autotag` |
| PM2 | `autotag` → `packages/backend/dist/server.js` |
| Node | nvm global |
| 도메인 | https://auto-button-tagging.kro.kr |
| nginx | `/` → `127.0.0.1:3000`, SSL Let's Encrypt |

**배포 절차 (프론트만):**
1. `packages/backend/public/{index.html,css/,js/}` 수정
2. `?v=` bump
3. SCP → `/opt/autotag/packages/backend/public/...`
4. `pm2 restart autotag`

**백엔드 변경 시:**
1. `npm run build` (shared → backend)
2. SCP `dist/`, `src/` 해당 파일
3. `pm2 restart autotag`

**ecosystem (참고):**
```js
{
  name: "autotag",
  cwd: "/opt/autotag/packages/backend",
  script: "dist/server.js",
  interpreter: "node",
  node_args: "--import ./src/polyfill.mjs",
  env: { NODE_ENV: "production", PORT: "3000" }
}
```

---

## 13. 빌드·로컬 실행

```bash
npm install
cp .env.example packages/backend/.env   # 키 입력
npm run build                           # shared → backend
npm run dev:backend                     # tsx watch, PORT from .env
```

로컬 기본 포트: README는 8080 언급, `.env.example`은 3000 — **`.env`의 PORT가 실제값**.

---

## 14. 코딩 규칙·주의사항

### 14.1 반드시 지킬 것

1. **shared 먼저** 수정·빌드 후 backend.
2. **캡처 GET은 auth 제외** — `<img src="/api/dev/captures/...">` 가 401 JSON이면 깨짐.
3. **정적 자산 수정 후 `?v=` bump** + 배포.
4. **택소노미 표 수정**은 `PATCH /taxonomy/rows` → 내부적으로 **모든 member candidate** 동기 + taxonomy 재빌드.
5. **페이지뷰** 행에 category/action/label 넣지 말 것.
6. **공통 탭**은 이름 allowlist(GNB/Footer) **사용 안 함** — 전 화면 동일 카+액이면 자동.
7. **ExcelJS addImage** buffer 타입: `Buffer.from(buf) as ExcelJS.Buffer` (TS 호환).
8. **backend build** 후 `dist/load-env.mjs`, `dist/polyfill.mjs` 존재 확인 (`copy-crawl-assets.mjs`).

### 14.2 하지 말 것

- Chrome extension / `/api/v2` formal REST (비범위).
- wizard 상태를 localStorage에 저장 (DB hydrate만).
- taxonomy에 link_url/direction/값목록/연결요소 펼침 UI **다시 추가하지 말 것** (사용자가 제거 요청).
- pick 단계에 **수정 체크·일괄 수정·인라인 CAL** **다시 넣지 말 것** (사용자가 제거·롤백함).
- `git push --force` to main, `.env` commit.
- 캡처 API에 JSON error body on 404 for PNG routes (브라우저 broken image).

### 14.3 UX 의사결정 기록 (2026-08)

| 주제 | 결정 |
|------|------|
| 3단계 축소 | 프로젝트 → 사이트 입력·분석 → 택소노미 확인·수정. Pick/보내기는 사용자 단계에서 제거 |
| 후보 선택 | 모든 후보를 자동 포함하고 분석 완료 후 자동 confirm |
| 택소노미 행 | **액션 단위 1행**, label=`{{버튼명}}` |
| 액션 이미지 | union 크롭 + **요소별 네모 각각** |
| Pick 펼침 UX 실험 | 경로바/한칸만열기 → **롤백** (체크박스만 늘어난다는 피드백) |
| 택소노미 요소 UI | 연결 요소/member expand → **제거** |

---

## 15. 핵심 파일 맵 (수정 시 어디를 볼지)

| 작업 | 파일 |
|------|------|
| 택소노미 행 생성·합치기 | `taxonomy/taxonomy-builder.ts` |
| 액션 이미지 attach | `taxonomy/taxonomy-action-images.ts` |
| Excel | `taxonomy/taxonomy-excel.ts` |
| Confirm API | `routes/dev-test.ts` → POST `/confirm` |
| Pick 트리 UI | `public/js/workspace-core.js` → `renderSessionTree`, `renderPageTree` |
| Taxonomy 표 UI | `workspace-core.js` → `renderTaxonomyMatrixTable` |
| 마법사 단계 | `public/js/wizard-app.js`, `public/index.html` |
| CAL 의미 | `shared/tagging-canonical.ts` |
| 이벤트 파라미터 | `shared/event-params.ts` |
| 후보 merge | `shared/candidate-merge.ts`, `crawl/candidate-grouper.ts` |
| bbox/위치 | `shared/element-location.ts`, `crawl/positions-file.ts` |
| 페이지/요소 PNG | `crawl/page-capture.ts`, `crawl/element-capture.ts` |

---

## 16. Git·버전

- **브랜치:** `main`
- **버전 파일:** `VERSION` → `package.json` workspaces 동기
- **UI badge:** `index.html` `#app-version` → `v{MAJOR}.{MINOR}`
- **최근 커밋 예:** `feat: simplify taxonomy and pick-stage CAL editing` (58e81ab) — 이후 로컬에 pick 롤백·taxonomy merge·action image 추가 (커밋 전일 수 있음)

---

## 17. 동일 제품 재구현 체크리스트

1. [ ] monorepo `shared` + `backend` workspaces
2. [ ] Microsoft OAuth + project scope DB
3. [ ] 3단계 wizard HTML/JS (프로젝트 → 사이트·분석 → 택소노미·Excel)
4. [ ] Firecrawl key pool + batch analyze queue
5. [ ] Phase1 후보 생성 / Phase2 element capture
6. [ ] Candidate tree + selection map (내부 유지, UI에서는 자동 전체 포함)
7. [ ] POST `/confirm` → taxonomy builder + LLM describe + action images
8. [ ] Taxonomy UI: inline edit, batch PATCH, action thumb column
9. [ ] Excel 7 columns + embedded action PNG
10. [ ] Capture routes without auth
11. [ ] PM2 + nginx deploy pattern
12. [ ] `.gitignore` for secrets and runtime data

---

## 18. 참고 문서 (저장소 내)

| 파일 | 내용 |
|------|------|
| `PLAN.md` | 파이프라인·API·DB 상세 |
| `docs/PROMPT_HISTORY.md` | 사용자 요구 변경 타임라인 |
| `docs/MICROSOFT-LOGIN.md` | Azure AD 설정 |
| `CHANGELOG.md` | v3.5.0 릴리스 노트 |
| `.env.example` | env 템플릿 |

---

## 19. 연락·메타

- **제품명:** Analytics SaaS / 자동 태깅 / auto-tagging
- **언어:** UI·택소노미·Excel 헤더 **한국어**
- **Primary user flow:** 비개발 마케터 — URL 넣고 → 체크 → Excel 받기

---

*이 문서는 코드와 운영 상태를 AI에게 넘기기 위한 스냅샷이다. 코드 변경 시 §5.3·§14·§15를 우선 갱신할 것.*
