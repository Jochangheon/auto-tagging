# Microsoft 로그인 구현 가이드

웹앱에 **Microsoft 계정 로그인**을 붙일 때 따라 하면 되는 순서입니다.  
(Azure AD / Microsoft Entra ID, OAuth 2.0 Authorization Code + PKCE)

---

## 무엇을 만들 것인가

사용자가 「Microsoft로 로그인」을 누르면:

1. Microsoft 로그인 화면으로 이동한다  
2. 로그인·동의가 끝나면 우리 서버로 돌아온다  
3. 서버가 사용자를 DB에 저장(또는 갱신)하고  
4. **세션 쿠키**를 심어 이후 API/페이지를 보호한다  

권장 방식은 **서버 사이드 Authorization Code + PKCE**입니다.  
프론트에 Client Secret을 두지 않고, 토큰 교환은 백엔드에서만 합니다.

---

## 전체 흐름 (개념)

```
[브라우저] → [내 서버 /login 시작]
                ↓
         Microsoft 로그인 페이지
                ↓
         [내 서버 /callback?code=...]
                ↓
         code → access_token 교환
                ↓
         프로필 조회 → DB 유저 upsert
                ↓
         세션 쿠키 발급 → 앱 홈으로 이동
```

---

## 순서 1. Azure에 앱 등록

1. [Azure Portal → Microsoft Entra ID → 앱 등록](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) 으로 이동  
2. **새 등록**  
   - 이름: 원하는 앱 이름  
   - 지원되는 계정 유형:  
     - 회사/학교만 → 해당 테넌트  
     - **개인 Microsoft 계정까지** 받으려면 「모든 Microsoft 계정 유형」 계열 + tenant `common`  
3. **리디렉션 URI** 추가  
   - 플랫폼: 기밀 웹앱이면 **웹**, 시크릿 없이 PKCE만 쓰면 **SPA**도 가능  
   - URI 예 (로컬):

     ```
     http://localhost:8080/api/auth/microsoft/callback
     ```

     배포 시에는 실제 HTTPS 콜백 URL을 **추가로** 등록합니다.  
     Azure에 넣은 문자열과 서버가 보내는 `redirect_uri`가 **한 글자도 다르면** 실패합니다.

4. 개요에서 **애플리케이션(클라이언트) ID**를 복사해 둡니다.  
5. (웹/기밀 클라이언트인 경우) **인증서 및 비밀** → 새 클라이언트 암호 만들기 → 값을 안전한 곳에 저장합니다.  
   - 공개 클라이언트(시크릿 없음)면 이 단계는 생략하고 **반드시 PKCE**를 씁니다.

### 권한(스코프)

토큰 요청 시 보통 아래를 사용합니다.

```
openid profile email User.Read offline_access
```

- `openid` / `profile` / `email`: ID 토큰·기본 프로필  
- `User.Read`: Graph `/me`로 메일·표시 이름 조회  
- `offline_access`: refresh token이 필요할 때 (세션만 쓰면 생략 가능)

API 권한 화면에서 Microsoft Graph `User.Read`를 추가하고, 필요하면 관리자 동의를 합니다.

---

## 순서 2. 서버에 넣을 설정

환경변수 예시:

| 변수 | 설명 |
|------|------|
| `AZURE_AD_CLIENT_ID` | 앱 등록의 Client ID (**필수**) |
| `AZURE_AD_CLIENT_SECRET` | 기밀 클라이언트일 때만 |
| `AZURE_AD_REDIRECT_URI` | Azure에 등록한 콜백 URL과 동일 |
| `AZURE_AD_TENANT` | `common`(다중) / `organizations` / `consumers` / 특정 tenant ID |

시크릿은 Git에 올리지 말고, 배포 환경의 secret 저장소를 사용하세요.

---

## 순서 3. DB 준비

로그인 사용자를 식별·유지하려면 최소 두 테이블이 필요합니다.

**users**

- `id` (내부 PK)  
- `microsoft_oid` (Azure 사용자 고유 ID, **UNIQUE**)  
- `email`, `display_name`  
- `created_at`, `updated_at`

**auth_sessions** (또는 동등한 세션 저장소)

- `id` (세션 토큰, 쿠키에 넣을 값)  
- `user_id` → users  
- `expires_at`  
- `created_at`

로그인할 때마다:

1. `microsoft_oid`로 upsert  
2. 새 세션 row 생성  
3. 그 `id`를 HttpOnly 쿠키로 내려줌  

JWT만 쓰고 싶다면 세션 테이블 대신 서명된 JWT를 쿠키/헤더에 둘 수 있지만, **로그아웃·만료 강제**는 서버 세션이 더 단순합니다.

---

## 순서 4. 백엔드에서 구현할 API

### 4-1. 로그인 시작 `GET /api/auth/microsoft`

1. 랜덤 **state** 생성 → 짧은 TTL 쿠키(또는 서버 저장)에 보관 (CSRF 방지)  
2. **PKCE**  
   - `code_verifier`: 랜덤 고엔트로피 문자열  
   - `code_challenge`: `BASE64URL(SHA256(code_verifier))`  
   - verifier도 HttpOnly 쿠키 등에 보관  
3. Microsoft authorize URL로 **302 리다이렉트**

Authorize URL 형태:

```
https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize
  ?client_id=...
  &response_type=code
  &redirect_uri=...
  &response_mode=query
  &scope=openid profile email User.Read offline_access
  &state=...
  &code_challenge=...
  &code_challenge_method=S256
```

### 4-2. 콜백 `GET /api/auth/microsoft/callback`

쿼리: `code`, `state` (또는 `error`)

1. `error` 있으면 로그인 페이지로 에러 메시지와 함께 리다이렉트  
2. 쿠키의 `state`와 쿼리 `state`가 **일치하는지** 확인  
3. 쿠키에서 `code_verifier` 꺼내기  
4. 토큰 엔드포인트로 POST:

```
POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

client_id=...
&code=...
&redirect_uri=...          ← authorize와 동일
&grant_type=authorization_code
&code_verifier=...
&scope=openid profile email User.Read offline_access
(+ 기밀 클라이언트면 client_secret=...)
```

5. 응답의 `access_token`(필요 시 `id_token`)으로 프로필 확보  
6. DB upsert → 세션 생성 → **세션 쿠키** Set-Cookie  
7. OAuth용 state/verifier 쿠키 삭제  
8. 앱 홈으로 리다이렉트  

### 4-3. 프로필 가져오기

권장 순서:

1. `id_token` JWT payload에서 `oid`(또는 `sub`), `email` / `preferred_username`, `name`  
2. 보강:  
   `GET https://graph.microsoft.com/v1.0/me`  
   Header: `Authorization: Bearer {access_token}`  

사용자를 구분하는 **안정 키**는 `oid`(Azure Object ID)입니다. 이메일은 바뀔 수 있으니 PK로 쓰지 마세요.

### 4-4. 현재 사용자 `GET /api/auth/me`

- 세션 쿠키 유효 → `{ authenticated: true, user: {...} }`  
- 아니면 `{ authenticated: false }`  

### 4-5. 로그아웃 `POST /api/auth/logout`

- DB 세션 삭제  
- 세션 쿠키 삭제  
- (선택) Microsoft 쪽 로그아웃 로그아웃 로그아웃까지 하려면 Entra 로그아웃 URL로 리다이렉트할 수 있음. 보통은 앱 세션만 끊어도 충분합니다.

---

## 순서 5. 쿠키·보안 체크리스트

| 항목 | 권장 |
|------|------|
| 세션 쿠키 | `HttpOnly`, `SameSite=Lax`(또는 Strict), Path=/ |
| 프로덕션 | `Secure` (HTTPS만) |
| state / PKCE verifier | HttpOnly, 짧은 만료(예: 10분), 콜백 후 즉시 삭제 |
| Client Secret | 서버(또는 secret manager)에만 보관 |
| CORS | 쿠키 쓰면 `Allow-Credentials` + 구체 Origin (와일드카드 `*` 금지) |

---

## 순서 6. 프론트에서 할 일

로그인 페이지에 버튼 하나면 됩니다.

```html
<a href="/api/auth/microsoft">Microsoft 계정으로 로그인</a>
```

페이지 로드 시:

1. `GET /api/auth/me` → 이미 로그인이면 홈으로  
2. 콜백에서 돌아온 `?error=...` 있으면 화면에 표시  

보호할 페이지/API:

- HTML: 미로그인 시 로그인 페이지로 리다이렉트  
- API: 세션 없으면 `401` + 로그인 URL  

---

## 순서 7. 미들웨어(요청마다)

모든 보호 API 앞에서:

1. 쿠키에서 세션 ID 읽기  
2. DB에서 만료되지 않은 세션 + 유저 조회  
3. `req.user`(또는 동등)에 붙이기  
4. 없으면 401 또는 로그인 페이지  

---

## 구현 체크리스트

- [ ] Azure 앱 등록 + 리디렉션 URI  
- [ ] Client ID (및 필요 시 Secret) 서버 설정  
- [ ] users / sessions 테이블  
- [ ] 로그인 시작 (state + PKCE + authorize 리다이렉트)  
- [ ] 콜백 (검증 → token → 프로필 → upsert → 세션 쿠키)  
- [ ] `/me`, logout  
- [ ] 페이지·API 가드  
- [ ] 로컬에서 실제 Microsoft 계정으로 1회 성공 확인  
- [ ] 배포 URL을 Azure 리디렉션에 추가 후 프로덕션 확인  

---

## 자주 나는 오류

| 증상 | 원인 | 대응 |
|------|------|------|
| redirect_uri mismatch | Azure 등록 URI ≠ 서버가 보낸 URI | 문자열을 완전히 동일하게 (http/https, 포트, path, trailing slash) |
| AADSTS7000218 / client_secret 요구 | 앱이 기밀인데 시크릿 없음 | Secret 발급 후 토큰 요청에 포함, 또는 공개+PKCE로 앱 유형 맞춤 |
| invalid_state | state 쿠키 유실·불일치 | SameSite/도메인/HTTPS 설정 확인, 짧은 TTL 내 완료 |
| missing PKCE / invalid_grant | verifier 없음·불일치 | authorize와 token에 같은 verifier/challenge 쌍 사용 |
| Graph 403 | 스코프/동의 부족 | `User.Read` + 동의 확인. id_token만으로도 최소 식별은 가능 |
| 로그인 직후 API 401 | 쿠키가 cross-site로 안 감 | same-origin으로 API 호출, credentials 포함 |

---

## 로컬 검증 순서

1. 서버 기동 (DB 마이그레이션 포함)  
2. Azure 리디렉션 = `http://localhost:{포트}/.../callback`  
3. 브라우저에서 로그인 페이지 → Microsoft 버튼  
4. 계정 선택·동의  
5. 홈으로 돌아온 뒤 `/api/auth/me`가 `authenticated: true`  
6. 로그아웃 후 다시 `false`  

---

## 설계 선택 요약

| 선택 | 이유 |
|------|------|
| Authorization Code + PKCE | SPA/공개 클라이언트에도 안전, Secret을 프론트에 안 둠 |
| 서버에서 토큰 교환 | Secret·토큰이 브라우저에 안 남음 |
| `microsoft_oid`로 유저 키 | 이메일보다 안정적 |
| HttpOnly 세션 쿠키 | XSS로 토큰 탈취 위험 감소, 서버에서 만료·로그아웃 가능 |

MSAL 라이브러리를 써도 되고, 위 엔드포인트만 직접 호출해도 됩니다.  
핵심은 **Azure 등록 → authorize → callback → token → 프로필 → 세션** 순서입니다.
