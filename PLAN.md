# 자동 태깅 — 기획·구현 기준 (2026-07-15)

로컬 검증용. 프로젝트 선택 → URL 분석 → 태그 선택 → 택소노미 초안 → Excel.  
실행: `npm run dev:backend` → http://localhost:8080  
비개발자용 설명: [`순서도.md`](순서도.md)

---

## 제품

| | |
|---|---|
| **사용자** | Microsoft 로그인 → 프로젝트 선택 → URL·PC/MO → 후보 체크 → 택소노미 수정 → Excel |
| **시스템** | Firecrawl(키 풀) · tag_id · LLM 이름 · 캡처 · taxonomy · DB 영속 |
| **UI** | `packages/backend/public/` **6단계** 마법사 (0~5) |
| **데이터** | 분석 JSON → **DB** (`page_analyses`, `projects`) · PNG → **디스크** (`data/captures/`) |

---

## 6단계 마법사

| # | 패널 | 내용 |
|:---:|---|---|
| 0 | 프로젝트 선택 | 생성·선택. 이후 URL·분석·후보·택소노미는 **project_id** 스코프 |
| 1 | 사이트 입력 | URL, 별칭(비우면 AI 자동), PC/MO |
| 2 | 분석 실행 | 배치 job. 완료 job은 하단·**다시 분석** 버튼만 재실행 |
| 3 | 태그 선택 | 트리 + 캡처 미리보기(스크롤·전체 위치·AI bbox 검증) |
| 4 | 택소노미 초안 | **공통 / PC / MO** 탭 · GNB·Footer는 공통 · 표 수정 → candidate JSON 동기 |
| 5 | 검토 & 보내기 | Excel (공통·PC·MO 시트) |

**인증:** Azure AD OAuth · 세션 14일 · `requireAuth` on project/analysis API

**영속:** wizard 상태 **localStorage 사용 안 함** — 프로젝트·세션은 DB에서 hydrate

---

## 3단계(태그 선택) 화면

- **왼쪽:** 후보 트리 (페이지 → 액션 → 라벨, PC/MO 배지)
- **오른쪽:** 캡처 미리보기 (내부 스크롤, 클릭 시 bbox 위치로 이동)
  - **page_view** → 풀페이지 PNG
  - **요소** → `tags/{tag_id}.png` (bbox 포함)
  - 캡처 전 → 「이미지 캡쳐중…」
- **도구:** 전체 위치 표시 · AI 위치 검증 (ok / suspicious / wrong)

page_view는 트리 액션 목록에 넣지 않음.

---

## 분석 파이프라인 (URL × viewport = job 1개)

**Phase 1** (후보 화면 즉시 공개) · **Phase 2** (백그라운드 요소 캡처)

```
Firecrawl bootstrap (키 풀에서 job별 1키 고정)
  → viewport PC 1920 / MO 390
  → 메뉴 탐색 + tagLiveDom ([data-tag-id], platform, menu_reveal_path)
  → positions.json + page_view fullPage PNG
  → HTML + LLM extract → candidate tree
  → [Phase 1 done → awaiting_pick]
  → 요소별: menu replay → bbox paint → clip PNG (Phase 2)
  → capture QA → persist PageNode
```

| 단계 | 모듈 |
|------|------|
| Firecrawl 키 풀 | `firecrawl-key-pool.ts`, `firecrawl-interact.ts` |
| 오케스트레이션 | `job-orchestrator.ts`, `batch-analyze-queue.ts` |
| 탐색·태깅 | `explore-recursive-menu.ts`, `tag-live-dom.ts` |
| page 캡처 | `page-capture.ts` |
| 요소 캡처 | `element-capture.ts` |
| LLM | `extract-pipeline.ts`, `extract-llm-batch.ts` |
| bbox AI 검증 | `position-vision-verify.ts` |
| 트리 | `candidate-grouper.ts` |
| QA | `capture-verify.ts` |
| DB 저장 | `persist-page.ts`, `page-analyses.ts`, `projects.ts` |

캡처 파일: `packages/backend/data/captures/{job_id}/`  
DB payload: `page_analyses.payload` (PageNode JSONB, capture **URL**만 포함)

---

## Firecrawl 키 풀

- env: `FIRECRAWL_API_KEYS=키1,키2,...` (단일 `FIRECRAWL_API_KEY`는 레거시 fallback)
- 분석 시작: **미사용 키 중 잔량 최대** 할당 · job 종료까지 동일 키
- UI `/api/dev/credits`: 키별 잔량 + **합계**
- 키 목록: [`FIRECRAWL_KEYS.md`](FIRECRAWL_KEYS.md)

---

## PC / MO / 공통

- URL마다 PC·MO **별도 job**
- platform 분류 + viewport 필터
- Taxonomy · Excel: **공통**(GNB·Footer) / **PC** / **MO** 탭·시트
- UI 표기 FNB → **Footer**

---

## 요소 식별

```
1. [data-tag-id]   — Pick·export primary key
2. selector_hint
3. selectors_fallback[]
4. overlay_bbox
```

---

## API

### 프로젝트 `/api/projects`

| | |
|---|---|
| GET/POST | `/` |
| GET/PUT/DELETE | `/:id` |
| PATCH | `/:id/settings` |

### 개발·마법사 `/api/dev/*`

| | |
|---|---|
| POST | `/analyze`, `/batch-analyze`, `/batch/:id/stop` |
| GET | `/jobs/:id/progress`, `/batch/:id/progress` |
| GET | `/sessions/:id`, `/credits` |
| PUT | `/selection` |
| PATCH | `/candidates`, `/taxonomy/rows` |
| POST | `/confirm`, `/positions/validate` |
| GET | `/taxonomy`, `/taxonomy/export` |
| GET | `/captures/:jobId/pc.png`, `/captures/:jobId/tags/:tagId.png` |

### 인증 `/api/auth/*`

Microsoft OAuth, `/me`, `/logout`

라우트: `routes/dev-test.ts`, `routes/projects.ts`, `auth/routes.ts`

---

## DB 스키마 (요약)

| 테이블 | 용도 |
|---|---|
| `users`, `auth_sessions` | Microsoft 로그인 |
| `projects` | 프로젝트 메타, taxonomy JSONB |
| `page_analyses` | project_id + url + viewport → PageNode payload, selection |

마이그레이션: `packages/backend/migrations/`

---

## 패키지

```
packages/shared/     타입, selector, taxonomy, viewport
packages/backend/    crawl, llm, taxonomy, db, public UI
```

---

## 완료 / 미완

**동작함**
- 6단계 마법사, Microsoft 로그인, 프로젝트 DB 스코프
- 배치 분석(완료 job 하단·재분석 버튼), PC/MO/공통 taxonomy
- Phase 1 즉시 후보 · Phase 2 백그라운드 캡처
- Firecrawl 키 풀, alias AI 자동, taxonomy 표 수정 ↔ candidate 동기
- 미리보기 스크롤·전체 bbox·AI 위치 검증
- taxonomy Excel (공통/PC/MO 시트)

**미완·불안정**
- 요소별 캡처 성공률 (CDP timeout)
- element capture fullPage crop fallback 미흡
- 캡처 PNG 디스크 의존 (DB에 바이너리 없음 → 서버 이전 시 폴더 동반 필요)
- VPS 배포·운영 systemd/pm2 미정

---

## 비범위

- Chrome extension
- live view iframe 주 미리보기
- `/api/v2/jobs` formal REST

---

## env (`packages/backend/.env`)

| 변수 | 용도 |
|---|---|
| `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `AZURE_AD_REDIRECT_URI`, `AZURE_AD_TENANT` | Microsoft 로그인 |
| `FIRECRAWL_API_KEYS` | Firecrawl 키 풀 (쉼표 구분) |
| `FIRECRAWL_API_URL` | Firecrawl API (기본 cloud) |
| `OPENROUTER_API_KEY` 또는 `GEMINI_API_KEY` | LLM |
| `LLM_PROVIDER`, `LLM_MODEL` | LLM 선택 |
| `PGLITE_DATA_DIR` | PGlite 경로 (한글 경로 회피) |
| `DATABASE_URL` | (선택) PostgreSQL |

예시: `.env.example` · 키 목록: `FIRECRAWL_KEYS.md`
