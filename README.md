# 자동 태깅 (auto-tagging)

Firecrawl + LLM으로 웹 페이지 클릭/페이지뷰 후보를 잡고, 택소노미 초안을 만든 뒤 Excel로 내보내는 SaaS 마법사입니다.

## 현재 버전

**v3.5.0** — [`VERSION`](VERSION) · [`CHANGELOG.md`](CHANGELOG.md)

프롬프트/요구사항 변경 역사: [`docs/PROMPT_HISTORY.md`](docs/PROMPT_HISTORY.md)

## 빠른 시작

```bash
npm install
cp .env.example packages/backend/.env   # 키 채우기
npm run build
npm run dev:backend
```

기본: http://localhost:8080 (운영은 포트 3000 + nginx)

## 워크스페이스

| 패키지 | 역할 |
|--------|------|
| `packages/shared` | 이벤트 파라미터·택소노미·후보 공통 타입/로직 |
| `packages/backend` | API · 크롤/LLM 파이프라인 · 마법사 UI(`public/`) |

## 6단계

1. 프로젝트 선택  
2. 사이트 입력 (URL 발견 → 선택 확정)  
3. 분석 실행  
4. 태그 선택  
5. 택소노미 확인  
6. 보내기 (Excel)

## 비밀값

`.env`, Firecrawl 키 문서, OAuth 토큰, 캡처/DB 데이터는 git에 올리지 않습니다. `.env.example`만 참고하세요.
