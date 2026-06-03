# 결제 통합 가이드 — PayApp + Cloudflare Worker + Airtable

> 새 앱에 결제 시스템을 적용할 때 **시행착오 없이** 작업하기 위한 통합 가이드.
> OnePage Study(`onepage-user`)에서 검증된 v2 아키텍처를 다른 앱(예: `memoryking-user.html`)에도 동일하게 적용 가능.

## 📚 사전 읽기

- [ONEPAGE_FEATURES.md §5](ONEPAGE_FEATURES.md#5-결제-자동화-파이프라인-worker-rest--airtable) — 결제 자동화 파이프라인 개요
- [ONEPAGE_SCHEMA.md](ONEPAGE_SCHEMA.md) — Airtable 테이블 스키마

---

## 목차
1. [전체 아키텍처와 핵심 결정](#1-전체-아키텍처와-핵심-결정)
2. [반드시 알아야 할 시행착오 10가지 🚨](#2-반드시-알아야-할-시행착오-10가지-)
3. [PayApp 사전 준비](#3-payapp-사전-준비)
4. [Airtable 스키마 (5개 테이블)](#4-airtable-스키마-5개-테이블)
5. [Worker 환경 변수](#5-worker-환경-변수)
6. [Worker 엔드포인트 (코드 그대로 복사 가능)](#6-worker-엔드포인트-코드-그대로-복사-가능)
7. [학생 앱 구현](#7-학생-앱-구현)
8. [Airtable Automation C1 — 자동 권한 갱신](#8-airtable-automation-c1--자동-권한-갱신)
9. [관리자 수동 권한 관리 (CRM)](#9-관리자-수동-권한-관리-crm)
10. [단계별 검증 체크리스트 ✅](#10-단계별-검증-체크리스트-)
11. [마이그레이션 — memoryking-user.html 등 새 앱에 적용](#11-마이그레이션--memoryking-userhtml-등-새-앱에-적용)

---

## 1. 전체 아키텍처와 핵심 결정

### 🌊 전체 흐름

```
사용자(학생)              학생 앱(Vercel)        Cloudflare Worker        PayApp           Airtable

  ① 결제 버튼  ──────►  POST /payment/request ────►  PayApp REST API ───►  결제창 생성
                       (chapter_id + JWT)
                                                                            │
                                                                            ▼
                       ◄────  { payurl }  ◄────  ────  결제 세션 (mul_no)
                          │
                          ▼
  ② 새 탭 결제 ──────────────────────────────────────►  결제완료
                                                            │
                                                            ▼ webhook POST
                                                  /payapp/webhook
                                                       ① 보안 검증 (userid)
                                                       ② pay_state=4 필터
                                                       ③ 멱등성 (3 테이블)
                                                       ④ var1=chapter_id 추출
                                                       ⑤ Airtable INSERT  ─────►  OnepagePayments
                                                       ⑥ 'SUCCESS' 응답              (행 추가)
                                                            │                          │
                                                            ▼                          ▼
                                                       (페이앱 retry 0회)        Automation C1 발사
                                                                                   (Run a script)
                                                                                       │
                                                                                       ▼
                                                                                 OnepageChapterAccess
                                                                                   (D+30일 갱신)
  ③ 학생 새로고침 ──►  GET /auth/me        ────►  Airtable 조회 ◄──────────────────
                       (ChapterAccess)
                          │
                          ▼
                       챕터 카드 D-30 표시
```

### 🎯 핵심 결정 사항

| 결정 | 이유 |
|---|---|
| **PayApp + Cloudflare Worker (직접 통합)** | PayApp이 webhook 응답에 정확히 `"SUCCESS"` 텍스트를 요구. Pabbly Connect Catch Webhook과 Airtable Inbound Webhook은 응답 본문을 커스터마이즈 못 함 → 매 결제마다 10회 retry 발생. Worker만이 정확한 `SUCCESS`를 반환 가능 |
| **REST API (동적 세션) vs 정적 QR** | 정적 QR은 페이앱 콘솔에 상품 사전 등록 필요 + 가격 변경 시 양쪽 동기화 필요. REST API는 결제 시점에 동적으로 모든 정보를 생성 → 사전 등록 불필요 |
| **`var1` = chapter_id 직접 전달** | `goodname` 텍스트 매칭은 오타 1글자에 실패. var1에 chapter_id를 정수로 보내면 100% 정확 |
| **3개 테이블 멱등성 검사** | mul_no가 OnepagePayments/UnknownPayments/FailedPayments 어디든 있으면 중복 → 안전 |
| **`feedbackurl`을 결제마다 동적 지정** | 멀티-base 운영 시 PayApp 콘솔의 공통 통보 URL에 의존하면 라우팅 불가. 결제 요청에서 결정하면 각 base별 다른 Worker로 보낼 수 있음 |

---

## 2. 반드시 알아야 할 시행착오 10가지 🚨

이 섹션을 **무조건** 먼저 읽으세요. OnePage 통합 과정에서 직접 부딪힌 사고들.

### 🔥 #1 — PayApp은 응답 본문이 정확히 `"SUCCESS"` 5글자여야 함

```
HTTP 200 + body "SUCCESS"   → 페이앱: "OK" (retry 안 함)
HTTP 200 + body "{}"        → 페이앱: "SUCCESS 못 받음" (retry 10회 발사)
```

→ Pabbly/Airtable 단독 사용 불가. Worker 같은 커스텀 응답 가능 서비스 필수.

### 🔥 #2 — `skip_cstpage=y` 옵션은 returnurl에 POST로 redirect

매출전표(영수증) 페이지를 건너뛰고 returnurl로 직행할 때 **POST 방식**. Vercel·GitHub Pages 같은 정적 호스팅은 POST 안 받음 → HTTP 405 발생.

**해결**: `skip_cstpage=y`를 **빼면** 매출전표 페이지 표시 → 사용자가 "확인" 클릭 → GET 방식 redirect → 정상 작동.

### 🔥 #3 — PayApp 최소 결제 금액 1,000원

100원 등 1,000원 미만 금액으로 호출하면 PayApp REST API가 `errno=50054`로 거부. 테스트 시에도 최소 1,000원.

### 🔥 #4 — `linkkey`/`linkval` 시크릿 silent skip 위험

페이앱 webhook은 `linkkey`/`linkval` 필드를 함께 보냄. 우리 시크릿 값이 페이앱 콘솔의 진짜 값과 다르면 보안 검증에서 silent skip → 응답은 SUCCESS인데 Airtable에 행 추가 안 됨.

**해결**: 
- 옵션 A — `linkkey`/`linkval` 검증 제거 (userid + mul_no 멱등성만 신뢰)
- 옵션 B — 페이앱 콘솔의 정확한 값을 secret으로 등록 (오타 X)

권장 코드:
```javascript
// 일치하면 좋지만 강제 안 함 — 로그만 WARN으로 남기고 처리 진행
if (env.PAYAPP_LINKKEY && fields.linkkey && fields.linkkey !== env.PAYAPP_LINKKEY) {
    console.log('[webhook] WARN: linkkey mismatch');
    // return 안 함 — 처리 계속
}
```

### 🔥 #5 — `userid`는 페이앱 로그인 아이디 (대표자명 X)

페이앱 콘솔 로그인 시 쓰는 ID. 예: `magicmemory`. 사업자 등록 이름 또는 결제창에 보이는 "김유신" 같은 대표자명이 아님.

### 🔥 #6 — 결제창의 "판매자명 + 상품명" 자동 prepend

NICE PAY 등 PG가 자동으로 가맹점 정보를 상품명 앞에 붙임:
- 우리가 보낸 goodname: `"수열 극한 미분 적분"`
- 결제창 표시: `"김유신 수열 극한 미분 적분"` (판매자명 자동 prepend)

이게 싫으면 페이앱 콘솔에서 판매자 정보를 사업자명으로 변경 (개인 사업자 등록 필요할 수 있음).

### 🔥 #7 — `var1`은 string으로 전달되지만 chapter_id로 쓰려면 Number 변환

```javascript
// webhook 핸들러에서:
const chapter_id = parseInt(fields.var1, 10) || 0;   // ✅
// const chapter_id = fields.var1;                    // ❌ (문자열 "3"이라 비교 시 의문 발생)
```

### 🔥 #8 — `mul_no`는 페이앱이 발급 (우리가 만들면 안 됨)

REST API `payrequest` 응답의 `mul_no`는 페이앱이 자동 발급. 우리는 그걸 받아 보존만 함.

### 🔥 #9 — 멱등성 검사는 **3 테이블 모두** 해야 함

| 시나리오 | 1차 webhook 처리 결과 | 2차 webhook (retry) |
|---|---|---|
| 정상 | OnepagePayments 행 1개 | OnepagePayments에서 발견 → skip |
| 미매칭 상품 | UnknownPayments 행 1개 | OnepagePayments엔 없음 → 처리 진행 → UnknownPayments 행 2개 ⚠️ |

→ OnepagePayments만 검사하면 폴백 케이스에서 중복 발생. 3 테이블 모두 검사가 정답.

### 🔥 #10 — Airtable Automation C1 트리거는 5~60초 지연

OnepagePayments 행 추가 후 C1이 바로 발사되지 않을 수 있음. Airtable 내부 polling 주기 때문에 최대 1분 지연. 학생에게 "결제 후 1분 안에 D-30 표시됩니다" 안내.

---

## 3. PayApp 사전 준비

### 가맹점 가입
- [payapp.kr](https://payapp.kr) 가입
- 사업자/개인 결제 선택 (개인이라도 가능, 단 정산 한도 있음)

### 콘솔에서 확인할 3가지
**페이앱 콘솔 → 설정 → 연동정보**:

| 항목 | 의미 | Worker secret 이름 |
|---|---|---|
| 판매자 아이디 | 로그인 ID (예: `magicmemory`) | `PAYAPP_USERID` |
| 연동 KEY | 가맹점별 발급 키 (10자 내외) | `PAYAPP_LINKKEY` (선택) |
| 연동 VALUE | 가맹점별 발급 값 (30~40자) | `PAYAPP_LINKVAL` (선택) |

### 공통 통보 URL
**비워둠** (또는 안전망으로 Worker URL 등록). 우리는 결제 요청 시 `feedbackurl`을 동적 지정하므로 공통 URL 의존 X.

### 발신번호 등록 (선택)
SMS 발송이 필요하면 발신번호 사전 등록 (KISA 규정).

---

## 4. Airtable 스키마 (5개 테이블)

### 필수 — 결제 처리 3 테이블

#### `Payments` (또는 `OnepagePayments`)
페이앱 결제 원장. **Worker가 채움**.

| 필드 | 타입 | 비고 |
|---|---|---|
| `mul_no` | Single line text | **멱등성 키** (페이앱 발급) |
| `user_phone` | Single line text | 숫자만 (var2에서) |
| `user_email` | Email | buyer_email |
| `chapter_id` | Number → Integer | **var1에서 직접** |
| `chapter_title` | Single line text | nocodebackend에서 보강 |
| `amount` | Currency (KRW, 소수점 0) | price |
| `paid_at` | Date (include time) | KST 시각 |
| `raw` | Long text | 원본 페이로드 JSON |
| `status` | Single select (`paid`, `refunded`, `failed`) | |

#### `UnknownPayments`
상품 매핑 실패한 결제 (var1 누락 등). **운영 시 0행 유지 목표**.

| 필드 | 타입 | 비고 |
|---|---|---|
| `mul_no` | Single line text | |
| `goodname` | Single line text | |
| `phone` | Single line text | |
| `email` | Email | |
| `amount` | Currency | |
| `raw` | Long text | |
| `received_at` | **Created time** (auto) | |
| `notes` | Long text | |
| `resolved` | Checkbox | 수동 처리 표시 |

#### `FailedPayments`
Airtable 쓰기 실패한 결제 (네트워크 등). **안전망. 운영 시 0행이 정상**.

| 필드 | 타입 | 비고 |
|---|---|---|
| `mul_no` | Single line text | |
| `goodname` | Single line text | |
| `phone` | Single line text | |
| `email` | Email | |
| `amount` | Currency | |
| `raw` | Long text | |
| `error_message` | Long text | |
| `retry_count` | Number → Integer | 수동 재실행 카운트 |
| `created_at` | **Created time** (auto) | |
| `resolved` | Checkbox | |

> ⚠️ `received_at`/`created_at`은 반드시 **Created time** 자동 필드로. 일반 Date 타입으로 만들면 Worker가 자동으로 못 채움.

### 권장 — 권한·사용자 2 테이블

#### `ChapterAccess` (또는 `OnepageChapterAccess`)
사용자×챕터별 만료일.

| 필드 | 타입 | 비고 |
|---|---|---|
| `user_phone` | Single line text | |
| `chapter_id` | Number → Integer | |
| `chapter_title` | Single line text | |
| `expires_at` | Date (include time) | **게이트 기준** |
| `last_payment_id` | Single line text | mul_no (수동 지급은 ADMIN-... 형식) |
| `source` | Single select | `purchase`, `point_redeem`, `admin_grant` |
| `created_at` | Created time | |
| `updated_at` | Last modified time | |

#### `Users` (또는 `OnepageUsers`)
회원 마스터. (회원제 앱이면 필수, 비회원제 결제면 생략 가능)

---

## 5. Worker 환경 변수

### Cloudflare Workers Secrets 등록
```bash
cd worker-folder
npx wrangler secret put AIRTABLE_TOKEN     # Airtable Personal Access Token
npx wrangler secret put AIRTABLE_BASE      # Base ID (appXXXXXXXXXXXXXX)
npx wrangler secret put JWT_SECRET         # JWT 서명 키 (랜덤 32바이트)
npx wrangler secret put PAYAPP_USERID      # 페이앱 판매자 아이디
npx wrangler secret put PAYAPP_LINKKEY     # 페이앱 연동 KEY (선택)
npx wrangler secret put PAYAPP_LINKVAL     # 페이앱 연동 VALUE (선택)
```

> `PAYAPP_LINKKEY`/`PAYAPP_LINKVAL`은 등록 안 해도 작동 (보안 한 단계 약해질 뿐). 등록할 거면 페이앱 콘솔의 정확한 값으로.

### Airtable PAT 발급
- [airtable.com/create/tokens](https://airtable.com/create/tokens)
- Scopes: `data.records:read`, `data.records:write`
- Access: 사용할 base 추가
- 토큰 발급 후 **즉시 wrangler secret으로 옮김** (외부 노출 금지)

---

## 6. Worker 엔드포인트 (코드 그대로 복사 가능)

### 6-1. 공통 헬퍼

```javascript
const AT_BASE_URL = 'https://api.airtable.com/v0';
const AT_PAYMENTS = 'OnepagePayments';     // 앱별로 테이블명 조정
const AT_UNKNOWN = 'UnknownPayments';
const AT_FAILED = 'FailedPayments';
const AT_ACCESS = 'OnepageChapterAccess';
const PAYAPP_API_URL = 'https://api.payapp.kr/oapi/apiLoad.html';
const STUDENT_APP_ORIGIN = 'https://your-app.vercel.app';   // 학생 앱 origin

function atH(env) {
  return {
    'Authorization': `Bearer ${env.AIRTABLE_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function atFindOne(env, table, formula) {
  const url = `${AT_BASE_URL}/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const r = await fetch(url, { headers: atH(env) });
  const j = await r.json();
  return (j.records && j.records[0]) || null;
}

async function atCreate(env, table, fields) {
  const url = `${AT_BASE_URL}/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}`;
  const r = await fetch(url, {
    method: 'POST', headers: atH(env),
    body: JSON.stringify({ fields, typecast: true }),
  });
  return r.json();
}

// KST 시간
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function kstISOString() { return kstNow().toISOString(); }
function kstDateTime() { return kstNow().toISOString().slice(0, 19).replace('T', ' '); }
function addDays(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// PayApp 응답 헬퍼
function payAppOk() {
  return new Response('SUCCESS', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
function payAppRetry(reason) {
  return new Response(String(reason || 'INTERNAL_ERROR'), {
    status: 500,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// form-urlencoded 파싱
function parseFormUrlEncoded(text) {
  const out = {};
  if (!text) return out;
  for (const pair of text.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = decodeURIComponent(pair.slice(0, eq));
    const v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}
```

### 6-2. `/payment/request` — 결제 세션 생성

```javascript
async function handlePaymentRequest(request, env) {
  const auth = await verifyAuth(request, env);   // JWT 검증, { phone, ... } 반환
  if (!auth) return json({ error: 'unauthenticated' }, 401, request);
  if (!env.PAYAPP_USERID) return json({ error: 'payapp_not_configured' }, 500, request);

  const b = await request.json().catch(() => ({}));
  const itemId = Number(b.chapter_id);   // 또는 b.product_id 등 앱별 명칭
  if (!itemId) return json({ error: 'item_id required' }, 400, request);

  // DB에서 상품(챕터) 정보 조회 — 앱별 구현
  const item = await loadItemFromDB(env, itemId);
  if (!item) return json({ error: 'item_not_found' }, 404, request);

  const price = Number(item.price) || 3000;       // 최소 1,000원 보장
  const title = String(item.title || '').slice(0, 100);
  const userPhone = String(auth.phone || '').replace(/\D/g, '');

  const workerOrigin = new URL(request.url).origin;
  const params = new URLSearchParams({
    cmd: 'payrequest',
    userid: env.PAYAPP_USERID,
    goodname: title,
    price: String(price),
    recvphone: userPhone,
    feedbackurl: workerOrigin + '/payapp/webhook',
    var1: String(itemId),          // ⭐ 매칭 키
    var2: userPhone,                // ⭐ 사용자 식별
    smsuse: 'n',
    checkretry: 'y',
    // skip_cstpage: 'y' ← ⚠️ 절대 넣지 마세요 (Vercel 405 발생)
    returnurl: STUDENT_APP_ORIGIN + '/?paid=1&item=' + itemId,
  });

  let r;
  try {
    r = await fetch(PAYAPP_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (e) {
    return json({ error: 'payapp_unreachable', message: String(e.message || e) }, 502, request);
  }

  const text = await r.text();
  const result = parseFormUrlEncoded(text);

  if (result.state !== '1') {
    return json({
      error: 'payapp_request_failed',
      errno: result.errno || '',
      message: result.errorMessage || 'unknown',
    }, 500, request);
  }

  return json({ ok: true, payurl: result.payurl, mul_no: result.mul_no }, 200, request);
}
```

### 6-3. `/payapp/webhook` — 결제 완료 수신

```javascript
async function handlePayAppWebhook(request, env) {
  const text = await request.text();
  const fields = parseFormUrlEncoded(text);

  // 디버그 로그 (운영 안정화 후 제거 가능)
  console.log('[webhook] fields:', JSON.stringify({
    userid: fields.userid,
    pay_state: fields.pay_state,
    mul_no: fields.mul_no,
    var1: fields.var1, var2: fields.var2,
    price: fields.price,
  }));

  // 1. 보안 검증 — userid만 엄격, linkkey/linkval은 경고만 (silent skip 방지)
  if (env.PAYAPP_USERID && fields.userid && fields.userid !== env.PAYAPP_USERID) {
    console.log('[webhook] SKIP: userid mismatch');
    return payAppOk();
  }
  if (env.PAYAPP_LINKKEY && fields.linkkey && fields.linkkey !== env.PAYAPP_LINKKEY) {
    console.log('[webhook] WARN: linkkey mismatch (계속 진행)');
  }
  if (env.PAYAPP_LINKVAL && fields.linkval && fields.linkval !== env.PAYAPP_LINKVAL) {
    console.log('[webhook] WARN: linkval mismatch (계속 진행)');
  }

  // 2. pay_state=4(완료)만 처리
  if (fields.pay_state !== '4') return payAppOk();

  const mul_no = String(fields.mul_no || '').trim();
  if (!mul_no) return payAppOk();

  const phone = String(fields.var2 || fields.recvphone || '').replace(/\D/g, '');
  const email = String(fields.buyer_email || '').toLowerCase().trim();
  const amount = parseInt(fields.price, 10) || 0;
  const goodname = String(fields.goodname || '').trim();
  const item_id = parseInt(fields.var1, 10) || 0;
  const raw_json = JSON.stringify(fields);

  // 3. 멱등성 검사 — 3 테이블 모두
  const mulNoEsc = mul_no.replace(/"/g, '');
  try {
    for (const t of [AT_PAYMENTS, AT_UNKNOWN, AT_FAILED]) {
      const dup = await atFindOne(env, t, `{mul_no}="${mulNoEsc}"`);
      if (dup) return payAppOk();
    }
  } catch (e) {
    return payAppRetry('LOOKUP_FAILED');
  }

  // 4. 챕터 제목 보강
  let item_title = goodname;
  if (item_id > 0) {
    try {
      const item = await loadItemFromDB(env, item_id);
      if (item && item.title) item_title = item.title;
    } catch (e) {}
  }

  // 5. 저장 분기
  try {
    if (item_id > 0) {
      const created = await atCreate(env, AT_PAYMENTS, {
        mul_no,
        user_phone: phone,
        user_email: email,
        chapter_id: item_id,
        chapter_title: item_title,
        amount,
        paid_at: kstDateTime(),
        status: 'paid',
        raw: raw_json,
      });
      if (created && created.error) throw new Error(created.error.message || 'create_failed');
    } else {
      const created = await atCreate(env, AT_UNKNOWN, {
        mul_no,
        goodname,
        phone, email, amount,
        raw: raw_json,
        notes: 'var1 missing — item_id not provided',
      });
      if (created && created.error) throw new Error(created.error.message || 'create_failed');
    }
    return payAppOk();
  } catch (err) {
    // 6. 안전망 — FailedPayments
    try {
      const failed = await atCreate(env, AT_FAILED, {
        mul_no, goodname, phone, email, amount,
        raw: raw_json,
        error_message: String(err.message || err).slice(0, 500),
      });
      if (failed && failed.error) return payAppRetry('AIRTABLE_DOWN');
      return payAppOk();
    } catch (e2) {
      return payAppRetry('AIRTABLE_DOWN');
    }
  }
}
```

### 6-4. 라우트 등록

```javascript
// route() 함수 안에:
// 공개 (인증 X)
if (m === 'POST' && path === '/payapp/webhook') return handlePayAppWebhook(request, env);

// 학생 인증 필수
if (m === 'POST' && path === '/payment/request') return handlePaymentRequest(request, env);
```

---

## 7. 학생 앱 구현

```javascript
// 학생 앱의 결제 버튼 핸들러
async function goPayment(itemId) {
  closeModal();
  try {
    toast('결제 페이지로 이동 중…');
    const r = await api('POST', '/payment/request', { chapter_id: itemId });
    if (!r.payurl) throw new Error('payurl missing');
    window.open(r.payurl, '_blank');
    toast('결제 후 잠시 후 갱신됩니다.');
  } catch (e) {
    toast('결제 세션 생성 실패: ' + e.message, true);
  }
}

// api 헬퍼는 JWT 자동 첨부:
async function api(method, path, body) {
  const opts = { method, headers: {} };
  const token = localStorage.getItem('user_token');
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(API_BASE + path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
```

---

## 8. Airtable Automation C1 — 자동 권한 갱신

### Trigger
- **When a record is created**
- Table: `OnepagePayments`
- (선택) Condition: `status = "paid"`

### Action — Run a script

**Input variables** (4개, 트리거 필드에서 매핑):

| Script 변수명 | 트리거 필드 |
|---|---|
| `user_phone` | OnepagePayments.user_phone |
| `chapter_id` | OnepagePayments.chapter_id |
| `chapter_title` | OnepagePayments.chapter_title |
| `mul_no` | OnepagePayments.mul_no |

**Script 코드** (그대로 복사 가능):

```javascript
const config = input.config();
const userPhone    = String(config.user_phone || "").trim();
const chapterId    = Number(config.chapter_id);
const chapterTitle = String(config.chapter_title || "").trim();
const mulNo        = String(config.mul_no || "").trim();
const ADD_DAYS = 30;

if (!userPhone || !chapterId) {
    console.log(`⚠️ 필수 누락 — user_phone='${userPhone}', chapter_id='${chapterId}'`);
    return;
}

const table = base.getTable("OnepageChapterAccess");
const query = await table.selectRecordsAsync({
    fields: ["user_phone", "chapter_id", "chapter_title", "expires_at"],
});

const existing = query.records.find(r =>
    String(r.getCellValue("user_phone")) === userPhone &&
    Number(r.getCellValue("chapter_id")) === chapterId
);

// 활성이면 누적, 만료/신규면 NOW + N일
const now = new Date();
let baseDate = now;
if (existing) {
    const current = existing.getCellValue("expires_at");
    if (current) {
        const currentDate = new Date(current);
        if (currentDate > now) baseDate = currentDate;
    }
}

const newExpires = new Date(baseDate);
newExpires.setUTCDate(newExpires.getUTCDate() + ADD_DAYS);
const newExpiresIso = newExpires.toISOString();

if (existing) {
    await table.updateRecordAsync(existing.id, {
        "chapter_title": chapterTitle,
        "expires_at": newExpiresIso,
        "last_payment_id": mulNo,
        "source": { name: "purchase" },
    });
    console.log(`✓ 갱신: ${userPhone} × #${chapterId} → ${newExpiresIso.slice(0, 10)}`);
} else {
    await table.createRecordAsync({
        "user_phone": userPhone,
        "chapter_id": chapterId,
        "chapter_title": chapterTitle,
        "expires_at": newExpiresIso,
        "last_payment_id": mulNo,
        "source": { name: "purchase" },
    });
    console.log(`+ 신규: ${userPhone} × #${chapterId} → ${newExpiresIso.slice(0, 10)}`);
}
```

> ⚠️ **API 차이 주의**: Airtable Automation 스크립트는 `console.log()` 사용. `output.text()`는 Scripting Extension용 (Automation에선 작동 X).
>
> ⚠️ **Single select 필드**: `"source": { name: "purchase" }` 객체 형태로. 문자열 직접 X.

---

## 9. 관리자 수동 권한 관리 (CRM)

### Worker 엔드포인트

```javascript
// POST /admin/access/grant — 권한 지급/연장
async function handleAdminAccessGrant(request, env, admin) {
  const b = await request.json().catch(() => ({}));
  const userPhone = String(b.user_phone || '').replace(/\D/g, '');
  const chapterId = Number(b.chapter_id);
  const days = Number(b.days);
  const reason = String(b.reason || 'admin_grant').slice(0, 100);
  
  if (!userPhone || !chapterId || !days) {
    return json({ error: 'invalid_parameters' }, 400, request);
  }
  
  // 챕터 제목 보강
  let chapter_title = '';
  try {
    const ch = await loadItemFromDB(env, chapterId);
    if (ch && ch.title) chapter_title = ch.title;
  } catch (e) {}
  
  // 기존 행 검색
  const phoneEsc = userPhone.replace(/"/g, '');
  const existing = await atFindOne(env, AT_ACCESS,
    `AND({user_phone}="${phoneEsc}", {chapter_id}=${chapterId})`);
  
  // 새 만료일 (활성이면 기존+N, 만료/신규면 NOW+N)
  const nowIso = kstISOString();
  const baseIso = existing && existing.fields.expires_at && existing.fields.expires_at > nowIso
    ? existing.fields.expires_at
    : nowIso;
  const newExpires = addDays(baseIso, days);
  
  const fields = {
    user_phone: userPhone,
    chapter_id: chapterId,
    chapter_title,
    expires_at: newExpires,
    source: 'admin_grant',     // ⭐ 진짜 결제와 구분
    last_payment_id: `ADMIN-${admin.phone}-${Date.now().toString(36)}`,
  };
  
  let result;
  if (existing) {
    result = await atUpdate(env, AT_ACCESS, existing.id, fields);
  } else {
    result = await atCreate(env, AT_ACCESS, fields);
  }
  
  return json({ ok: true, expires_at: newExpires }, 200, request);
}

// DELETE /admin/access/:phone/:chapter_id — 권한 회수
async function handleAdminAccessRevoke(request, env, admin, phone, chapterIdStr) {
  const userPhone = String(decodeURIComponent(phone)).replace(/\D/g, '');
  const chapterId = Number(chapterIdStr);
  
  const phoneEsc = userPhone.replace(/"/g, '');
  const existing = await atFindOne(env, AT_ACCESS,
    `AND({user_phone}="${phoneEsc}", {chapter_id}=${chapterId})`);
  
  if (!existing) return json({ error: 'not_found' }, 404, request);
  
  // atDelete 헬퍼:
  // const url = `${AT_BASE_URL}/${env.AIRTABLE_BASE}/${encodeURIComponent(AT_ACCESS)}/${existing.id}`;
  // await fetch(url, { method: 'DELETE', headers: atH(env) });
  
  await atDelete(env, AT_ACCESS, existing.id);
  
  return json({ ok: true }, 200, request);
}
```

### CRM UI (사용자 상세 모달)

```html
<!-- 챕터 구독 섹션 헤더 -->
<h4 style="display:flex;justify-content:space-between">
  <span>📚 챕터 구독</span>
  <button onclick="openGrantAccess(phone)">🎁 새 권한 지급</button>
</h4>

<!-- 각 챕터 행 -->
<tr>
  <td>${title}</td>
  <td><span class="pill active">D-${days}</span></td>
  <td>${expires_at}</td>
  <td>
    <button onclick="openGrantAccess(phone, chapterId, title)">+일</button>
    <button onclick="revokeAccess(phone, chapterId, title)">🗑️</button>
  </td>
</tr>
```

### 핵심 — `source` 필드로 구분

| source 값 | 발생 | 자동화 |
|---|---|---|
| `purchase` | 실제 결제 | C1 자동 갱신 |
| `point_redeem` | 포인트 사용 | Worker가 직접 처리 |
| `admin_grant` | 관리자 수동 지급 | Worker가 직접 처리 (C1 안 발사) |

→ 진짜 결제(매출 통계용)와 무료 부여를 정확히 분리.

---

## 10. 단계별 검증 체크리스트 ✅

### Phase 1 — 인프라
- [ ] Cloudflare Workers 계정 생성, wrangler 설치
- [ ] Airtable Base + 5개 테이블 생성 (스키마 §4 참조)
- [ ] PayApp 가맹점 가입
- [ ] Airtable PAT 발급
- [ ] PayApp 콘솔에서 userid·linkkey·linkval 확인

### Phase 2 — Worker 배포
- [ ] worker.js 작성 (코드 §6 복사)
- [ ] `wrangler secret put` 시크릿 6개 등록
- [ ] `wrangler deploy` 배포
- [ ] 30초 컷 ping 테스트:
  ```bash
  curl -X POST https://your-worker.workers.dev/payapp/webhook --data "pay_state=2&mul_no=PING"
  # 기대: "SUCCESS"
  ```

### Phase 3 — Webhook 시뮬레이션
- [ ] 정상 케이스:
  ```bash
  curl -X POST .../payapp/webhook --data "userid=YOUR&pay_state=4&mul_no=TEST-001&var1=3&var2=01012345678&price=1000&goodname=테스트"
  ```
  → OnepagePayments에 행 추가 확인
- [ ] 멱등성: 같은 명령 2번 → 행 1개만
- [ ] var1 누락: var1='' → UnknownPayments에 행 추가
- [ ] pay_state=2: 변화 없음, SUCCESS 응답

### Phase 4 — Airtable Automation
- [ ] C1 Automation 빌드 (스크립트 §8 복사)
- [ ] Input variables 4개 매핑
- [ ] Test trigger로 신규/갱신 케이스 검증

### Phase 5 — 실전 결제
- [ ] 학생 앱 `goPayment` 함수 구현 (§7)
- [ ] 챕터 가격 1,000원으로 임시 변경 (PayApp 최소 금액)
- [ ] 본인 카드로 실전 결제
- [ ] 다음 5가지 자동 흐름 확인:
  1. Worker `/payment/request` 응답 200 + payurl
  2. 페이앱 페이지에 정확한 상품명·금액 표시
  3. 결제 후 Worker `/payapp/webhook` SUCCESS 응답
  4. OnepagePayments 새 행 + ChapterAccess D-30
  5. 학생 앱 새로고침 시 D-30 표시
- [ ] 가격 원래대로 복구

### Phase 6 — 정리 + 운영
- [ ] 테스트 결제 페이앱 콘솔에서 취소
- [ ] 테스트 잔재 모두 삭제 (Payments + ChapterAccess + Unknown + Failed)
- [ ] 페이앱 콘솔 공통 통보 URL 비움
- [ ] 운영 모니터링: 매일 FailedPayments 0행 확인

---

## 11. 마이그레이션 — memoryking-user.html 등 새 앱에 적용

OnePage의 패턴을 그대로 옮길 수 있습니다. **앱별로 다른 부분**과 **공통인 부분**을 명확히 분리.

### ✅ 공통 (그대로 사용 가능)

| 컴포넌트 | 그대로? |
|---|---|
| Worker `/payapp/webhook` 핸들러 (§6-3) | ✅ |
| `payAppOk()`, `payAppRetry()`, `parseFormUrlEncoded()` 헬퍼 | ✅ |
| Airtable Automation C1 Script (§8) | ✅ |
| Worker `/admin/access/grant`, `revoke` (§9) | ✅ |
| 시행착오 10가지 (§2) | ✅ 모두 동일하게 적용 |

### 🔄 앱별 조정 필요

| 항목 | 조정 |
|---|---|
| 테이블 이름 | `OnepagePayments` → `MemorykingPayments` 등 |
| DB 조회 (`loadItemFromDB`) | nocodebackend 콘텐츠 테이블 변경 |
| 학생 앱 URL | `onepage-study.vercel.app` → `memoryking-user.vercel.app` |
| 상품(item) ID 의미 | OnePage는 chapter_id, memoryking은 deck_id 등 |
| C1 Script의 `+30일` 기본값 | 앱 정책에 맞게 (예: 60일 패키지) |
| 결제 모달의 UX | 앱 디자인에 맞춰 |

### 📋 마이그레이션 체크리스트

#### Step 1 — 사전 결정
- [ ] 상품 단위: chapter / deck / set / lesson 어느 것?
- [ ] 가격 모델: 월 구독 / 일시불 / 연 구독?
- [ ] 권한 기간: 30일 / 60일 / 무기한?
- [ ] 회원제: 학생 JWT 인증 있음/없음?

#### Step 2 — Airtable 준비
- [ ] 새 Base 또는 기존 Base에 5 테이블 추가 (§4)
- [ ] 테이블 이름은 앱 prefix로 (예: `MemorykingPayments`)
- [ ] Worker secret `AIRTABLE_BASE`에 새 Base ID

#### Step 3 — Worker 추가/복제
- 옵션 A: **기존 Worker에 새 라우트 추가** (단일 Worker)
- 옵션 B: **새 Worker 별도 배포** (memoryking-api.workers.dev)
- 멀티-앱 운영이면 옵션 B가 깔끔

#### Step 4 — 코드 복사 + 조정
- [ ] §6 코드 복사
- [ ] 테이블명·DB 조회 로직 교체
- [ ] 학생 앱 URL 상수 교체
- [ ] (필요시) C1 Script의 ADD_DAYS 변경

#### Step 5 — 학생 앱 결제 함수
- [ ] `goPayment(itemId)` 함수 학생 앱에 추가
- [ ] API base URL을 새 Worker로

#### Step 6 — 페이앱 등록
- [ ] **같은 페이앱 계정 사용** (별도 가맹점 가입 불필요)
- [ ] 새 앱 결제 시 동적 feedbackurl로 새 Worker 가리킴

#### Step 7 — 검증 (§10 Phase 5)
- [ ] curl SUCCESS 응답
- [ ] 본인 카드 1,000원 실전 결제
- [ ] Airtable 자동 처리 확인

#### Step 8 — 운영
- [ ] 매일 FailedPayments 0행 확인
- [ ] (선택) CRM에 새 앱 결제도 통합 표시

### 🎯 멀티-앱 페이앱 결제 라우팅

같은 페이앱 계정에서 OnePage와 Memoryking 결제를 모두 받지만 **다른 Airtable Base에 저장**하려면:

```
학생 앱 (Vercel)              Worker                     Airtable Base
─────────────────────────────────────────────────────────────────────
OnePage 학생 앱  ──►  onepage-api.workers.dev    ──►  메모리킹 앱 마스터DB
                      /payment/request               (OnepagePayments)
                      /payapp/webhook
                      ↑ feedbackurl 동적 지정

Memoryking 학생 앱  ──►  memoryking-api.workers.dev  ──►  메모리킹 헬스 마스터DB
                         /payment/request                 (MemorykingPayments)
                         /payapp/webhook
                         ↑ feedbackurl 동적 지정
```

→ **PayApp 계정 1개, Worker 2개, Base 2개**. PayApp 콘솔의 공통 통보 URL은 비워둠. 각 앱의 결제 요청 시 자기 Worker URL을 `feedbackurl`로 보내면 자동으로 분기.

---

## 🎓 마무리 — 핵심 한 줄

> **PayApp REST API + Cloudflare Worker + Airtable + 자동화 C1.**
> 이 네 가지 조합이 검증됐고 작동합니다.
> §2의 시행착오 10가지만 피하면 새 앱 통합은 **약 1일 작업**으로 가능합니다.

질문·이슈는 OnePage 작업 시 발견된 추가 사례를 이 문서에 누적해 가세요.
