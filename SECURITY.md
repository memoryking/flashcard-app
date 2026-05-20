# Flashcard-User 보안 구조 가이드

## 전체 아키텍처

```
사용자 브라우저
    │
    ▼
┌──────────────────────────────────┐
│  vipup.site (아임웹)              │
│  └─ <iframe> flashcard-user.html │
└──────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────┐
│  GitHub Pages                     │
│  memoryking.github.io             │
│  └─ flashcard-user.html           │
│     ├─ 1단계: 접속 제한 (JS)      │
│     ├─ IndexedDB (로컬 저장)      │
│     └─ fetch 요청                 │
└──────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────┐
│  Cloudflare Workers               │
│  airtable-proxy.memoryking        │
│  .workers.dev                     │
│  ├─ 2단계: Origin 검사            │
│  ├─ 3단계: 경로 제한              │
│  ├─ 4단계: 메서드 제한            │
│  └─ API 키로 Airtable 호출       │
└──────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────┐
│  Airtable API                     │
│  └─ 실제 단어 데이터 저장소       │
└──────────────────────────────────┘
```

---

## 왜 Airtable Proxy가 필요한가?

### 문제: API 키 노출

Airtable에서 데이터를 가져오려면 API 키가 필요합니다.

```
Authorization: Bearer patXXXXXXXXXXXXXX
```

flashcard-user.html은 GitHub Pages에 호스팅된 **정적 HTML 파일**입니다.
이 파일에 API 키를 직접 넣으면:

1. 브라우저 개발자 도구에서 **누구나 API 키를 볼 수 있음**
2. API 키로 Airtable 데이터를 **읽기/수정/삭제** 가능
3. 키가 유출되면 전체 데이터가 위험

### 해결: Proxy (중간 서버)

```
❌ 직접 호출 (위험)
flashcard-user.html → Airtable API (API 키가 HTML에 노출)

✅ 프록시 경유 (안전)
flashcard-user.html → Cloudflare Workers → Airtable API
                      (API 키는 여기에만 저장)
```

Cloudflare Workers가 중간에서:
- API 키를 **환경 변수**로 안전하게 보관
- 허용된 도메인에서 온 요청만 통과
- 읽기(GET)만 허용 (수정/삭제 불가)
- 허용된 테이블만 접근 가능

---

## 1단계: 클라이언트 접속 제한 (flashcard-user.html)

### 위치
`flashcard-user.html` — `<script>` 태그 시작 직후, 앱 클래스 정의 전

### 코드
```javascript
(function() {
    const ALLOWED_ORIGINS = [
        'vipup.site',
        'www.vipup.site',
        'memoryking.github.io',
        'localhost',
        '127.0.0.1'
    ];

    function isAllowed() {
        if (window.self === window.top) {
            // 직접 접속 — hostname 검사
            const host = window.location.hostname;
            return ALLOWED_ORIGINS.some(d => host === d || host.endsWith('.' + d));
        }
        // iframe 내부 — referrer 검사
        const ref = document.referrer;
        if (!ref) return false;
        try {
            const refHost = new URL(ref).hostname;
            return ALLOWED_ORIGINS.some(d => refHost === d || refHost.endsWith('.' + d));
        } catch(e) { return false; }
    }

    if (!isAllowed()) {
        document.body.innerHTML = '접속이 제한되었습니다...';
        throw new Error('Unauthorized origin');
    }
})();
```

### 동작 방식

| 접속 방법 | 검사 대상 | 예시 |
|-----------|-----------|------|
| 직접 URL 접속 | `window.location.hostname` | 브라우저에서 `memoryking.github.io/...` 직접 입력 |
| iframe으로 로드 | `document.referrer` | `vipup.site` 페이지 안의 iframe |

### 차단 시 동작
- 화면 전체를 "접속이 제한되었습니다" 메시지로 대체
- `throw new Error()`로 이후 모든 JS 실행 중단
- 앱 클래스(`WordMemorizationApp`)가 생성되지 않음

### 허용 도메인 설명

| 도메인 | 용도 |
|--------|------|
| `vipup.site` | 실제 서비스 페이지 (아임웹) |
| `www.vipup.site` | www 포함 접속 |
| `memoryking.github.io` | GitHub Pages 직접 접속 (개발/테스트용) |
| `localhost` | 로컬 개발용 |
| `127.0.0.1` | 로컬 개발용 |

### 한계
- **클라이언트 측 검사**이므로 개발자 도구로 우회 가능
- 하지만 우회해도 2단계(프록시)에서 데이터 접근이 차단됨

---

## 2단계: Airtable Proxy Origin 검사

### 위치
`airtable-proxy/airtable-proxy/src/index.js`

### 코드
```javascript
const origin = request.headers.get('Origin') || '';
const allowedOrigins = [
    'https://vipup.site',
    'https://www.vipup.site',
    'https://memoryking.github.io'
];
const isAllowed = allowedOrigins.some(o => origin.startsWith(o));
```

### 동작 방식
- 브라우저가 fetch 요청 시 자동으로 `Origin` 헤더를 포함
- `Origin` 헤더는 브라우저가 관리하므로 **JavaScript로 위조 불가**
- 허용 목록에 없는 origin → `403 Forbidden` 반환

### 허용되지 않을 때
```json
{ "error": "Forbidden" }  // HTTP 403
```

### 프록시 vs 클라이언트 허용 목록 차이

| | 클라이언트 (flashcard-user.html) | 프록시 (Workers) |
|---|---|---|
| localhost | ✅ 허용 | ❌ 차단 |
| 프로토콜 | 미검사 | https만 허용 |
| 우회 가능 | JS로 가능 | 브라우저 수준에서 불가 |

→ localhost에서 개발 시 **화면은 보이지만 데이터는 못 가져옴** (프록시가 차단)

---

## 3단계: 경로 제한 (Path Whitelisting)

### 코드
```javascript
const allowedPaths = {
    '/': env.AIRTABLE_TABLE_NAME,     // 메인 단어 테이블
    '/page_config': 'page_config'      // 페이지 설정 테이블
};
const tableName = allowedPaths[url.pathname];
if (!tableName) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
}
```

### 동작 방식
- `/` 또는 `/page_config` 경로만 허용
- 다른 경로 → `404 Not Found`
- 즉, Airtable에 다른 테이블이 있어도 **프록시를 통해 접근 불가**

### 매핑

| 프록시 경로 | Airtable 테이블 | 용도 |
|-------------|-----------------|------|
| `/` | `env.AIRTABLE_TABLE_NAME` (환경변수) | 단어 데이터 |
| `/page_config` | `page_config` | 페이지별 카테고리 설정 |

---

## 4단계: HTTP 메서드 제한

### 코드
```javascript
if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ... } });
}
if (request.method !== 'GET') {
    return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { status: 405 }
    );
}
```

### 허용 메서드

| 메서드 | 허용 | 용도 |
|--------|------|------|
| OPTIONS | ✅ | CORS preflight (브라우저 자동 전송) |
| GET | ✅ | 데이터 읽기 |
| POST | ❌ | 데이터 생성 차단 |
| PUT/PATCH | ❌ | 데이터 수정 차단 |
| DELETE | ❌ | 데이터 삭제 차단 |

→ 프록시를 통해서는 **읽기만 가능**, Airtable 데이터 변조 불가

---

## 5단계: API 키 보호

### Cloudflare Workers 환경 변수

```javascript
env.AIRTABLE_API_KEY    // Airtable Personal Access Token
env.AIRTABLE_BASE_ID    // Airtable Base ID
env.AIRTABLE_TABLE_NAME // 메인 테이블명
```

### 설정 방법 (Cloudflare Dashboard)

1. Cloudflare Dashboard → Workers & Pages → `airtable-proxy` 선택
2. Settings → Variables and Secrets
3. 환경 변수 추가:
   - `AIRTABLE_API_KEY`: `patXXXXXXXXXX` (Airtable에서 발급)
   - `AIRTABLE_BASE_ID`: `appXXXXXXXXXX` (Airtable Base ID)
   - `AIRTABLE_TABLE_NAME`: 테이블 이름

### 또는 wrangler CLI로 설정

```bash
npx wrangler secret put AIRTABLE_API_KEY
npx wrangler secret put AIRTABLE_BASE_ID
npx wrangler secret put AIRTABLE_TABLE_NAME
```

### 보안 특성
- 환경 변수는 Workers 런타임에서만 접근 가능
- 클라이언트 응답에 절대 포함되지 않음
- Cloudflare Dashboard에서도 설정 후 값 확인 불가 (Secret 타입)

---

## CORS 헤더 처리

### CORS가 필요한 이유
flashcard-user.html은 `memoryking.github.io`에서 로드되고,
프록시는 `airtable-proxy.memoryking.workers.dev`에 있습니다.
**도메인이 다르므로** 브라우저가 CORS 정책을 적용합니다.

### Preflight 요청 (OPTIONS)
```
브라우저 → 프록시: "이 origin에서 GET 요청해도 되나요?"
프록시 → 브라우저: "허용된 origin이면 OK, 아니면 빈 값"
```

```javascript
// 프록시 응답
'Access-Control-Allow-Origin': isAllowed ? origin : '',
'Access-Control-Allow-Methods': 'GET, OPTIONS',
'Access-Control-Allow-Headers': 'Content-Type',
'Access-Control-Max-Age': '86400',  // 24시간 동안 캐시
```

### 일반 응답
```javascript
'Access-Control-Allow-Origin': origin,  // 허용된 origin만 여기 도달
'Cache-Control': 'no-store',            // 브라우저 캐시 방지
```

### 허용되지 않은 origin의 경우
`Access-Control-Allow-Origin`이 빈 문자열 → 브라우저가 **응답 자체를 차단**

---

## 로컬 데이터 저장 (보안 관점)

### IndexedDB
```
DB명: MemorykingDB_User (버전 6)
Origin: memoryking.github.io
```

| 스토어 | 내용 | 민감도 |
|--------|------|--------|
| `contents` | 단어장 데이터 (제목, 내용, 마인드맵) | 중 |
| `highlights` | 하이라이트 표시 | 낮 |
| `word_progress` | 학습 진행도 (known, 학습일 등) | 낮 |

- 동일 origin(`memoryking.github.io`)의 모든 페이지가 **같은 DB를 공유**
- 다른 도메인에서는 접근 불가 (브라우저 Same-Origin Policy)
- 사용자 기기에만 저장, 서버 전송 없음

### localStorage

| 키 | 내용 |
|----|------|
| `quizTimeLimit` | 퀴즈 시간 제한 (ms) |
| `notMemorizedMode` | 미암기 모드 (test/memorize) |
| `wordLimitRemaining` | 남은 단어 제한 수 |
| `wordLimitNotMemorized` | 미암기 단어 제한 수 |
| `wordLimitMemorized` | 암기 단어 제한 수 |
| `lastViewedContentId` | 마지막 본 콘텐츠 ID |

- 민감 정보 없음 (설정값만 저장)
- API 키, 토큰 등은 저장하지 않음

---

## 보안 계층 요약

```
[보호 대상]                    [보호 방법]
──────────────────────────────────────────────
화면 접근                  →  JS referrer/hostname 검사
데이터 접근                →  프록시 Origin 헤더 검사
Airtable 테이블 접근       →  경로 화이트리스트 (/ 와 /page_config만)
데이터 변조                →  GET 메서드만 허용
API 키                     →  Workers 환경 변수 (클라이언트 비노출)
CORS                       →  조건부 Access-Control-Allow-Origin
로컬 학습 데이터           →  브라우저 Same-Origin Policy
```

### 각 계층이 뚫렸을 때

| 시나리오 | 결과 |
|----------|------|
| JS 접속 제한 우회 | 화면은 보이지만 프록시가 데이터 차단 |
| 프록시 Origin 우회 (curl 등) | 브라우저 외 도구로만 가능, 읽기만 가능 |
| 프록시 자체 해킹 | Cloudflare Workers 보안에 의존 |
| API 키 유출 | Airtable에서 키 재발급 후 환경 변수 교체 |

---

## 배포 시 체크리스트

- [ ] `flashcard-user.html`의 `ALLOWED_ORIGINS`에 실제 서비스 도메인 포함 확인
- [ ] 프록시의 `allowedOrigins`에 실제 서비스 도메인 포함 확인
- [ ] 프로덕션에서 `localhost`, `127.0.0.1` 제거 고려
- [ ] Cloudflare Workers 환경 변수 (API_KEY, BASE_ID, TABLE_NAME) 설정 확인
- [ ] Airtable API 키 권한이 **읽기 전용**인지 확인
- [ ] GitHub Pages에서 flashcard-user.html 최신 버전 배포 확인
