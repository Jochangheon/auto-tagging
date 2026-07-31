# Changelog

이 프로젝트는 [Semantic Versioning](https://semver.org/)을 따릅니다.  
UI에 표시되는 `vX.Y`는 `VERSION` 파일과 동기화합니다.

## [3.5.0] — 2026-07-31

첫 GitHub 공개 스냅샷. 운영 서버(`49.247.40.177` / `auto-button-tagging.kro.kr`)에 배포 중이던 상태를 기준으로 합니다.

### 제품
- 6단계 마법사: 프로젝트 → 사이트 입력 → 분석 → 태그 선택 → 택소노미 확인 → 보내기
- Microsoft 로그인 · 프로젝트 스코프 DB 영속 · Firecrawl + LLM 자동 태깅
- Excel 택소노미 내보내기 (공통 / PC·MO / 변수사전)

### 이번 릴리스에 포함한 주요 개선
- URL 발견: 사이트맵/맵 스트리밍, 타임아웃 시 중단, 시드 기본 선택, 서브도메인 옵션 설명
- 공통 택소노미: 이름 allowlist 제거 → 전 화면 동일 카/액/라 자동 공통
- 페이지뷰: `category`/`action`/`label` 제거, `page_name` 추가
- 택소노미 UI: link_url·direction·수·값 목록 제거, 공통 발생시점/설명 보강
- 태그 선택: 페이지 탭, tag_id 오버레이 제거, 다중 멤버 union bbox
- 단계·보내기 UI: 얇은 진행 스테퍼, Excel 다운로드 중심 완료 화면
- 프로젝트 전환 시 사이트 입력/발견 세션 초기화

### 버전 관리 규칙
- `VERSION` — 단일 소스
- `package.json` / `packages/*/package.json` — 동일 버전 유지
- UI `version-badge` — 배포 시 `v{MAJOR}.{MINOR}` 표기
- 이후 변경은 `CHANGELOG.md`에 Added / Changed / Fixed로 기록
