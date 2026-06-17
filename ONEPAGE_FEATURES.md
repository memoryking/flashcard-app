# 원페이지 학습 — 전체 기능 가이드

원페이지 학습 서비스의 모든 기능을 한눈에. 다음 작업·인수인계·운영 시 참고용 문서.

## 목차
1. [시스템 개요](#1-시스템-개요)
2. [4가지 앱 + 백엔드](#2-4가지-앱--백엔드)
3. [계층 구조](#3-계층-구조)
4. [결제 모델 (챕터별)](#4-결제-모델-챕터별)
5. [결제 자동화 파이프라인 (PayApp → Pabbly → Airtable)](#5-결제-자동화-파이프라인-payapp--pabbly--airtable)
6. [포인트 시스템](#6-포인트-시스템)
7. [추천 시스템](#7-추천-시스템)
8. [학습 인터페이스 — 플래시카드 모드](#8-학습-인터페이스--플래시카드-모드)
9. [콘텐츠 정렬 규칙](#9-콘텐츠-정렬-규칙)
10. [위치 고정 — 학습 중 스크롤 안 밀림](#10-위치-고정--학습-중-스크롤-안-밀림)
11. [선생님 — 콘텐츠 관리](#11-선생님--콘텐츠-관리)
12. [일괄 입력 (TSV)](#12-일괄-입력-tsv)
13. [이미지 처리](#13-이미지-처리)
14. [보안 — 워터마크·캡쳐 차단](#14-보안--워터마크캡쳐-차단)
15. [라이브 학습자 카운트](#15-라이브-학습자-카운트)
15-B. [사용법 가이드 페이지](#15-b-사용법-가이드-페이지-guidehtml)
16. [관리자 CRM 대시보드](#16-관리자-crm-대시보드)
17. [마케팅 어트리뷰션 + QR 생성기 (UTM)](#17-마케팅-어트리뷰션--qr-생성기-utm)
18. [캐페인 발송 (Pabbly 웹훅)](#18-캐페인-발송-pabbly-웹훅)
19. [KST 시간 처리](#19-kst-시간-처리)
20. [데이터 모델](#20-데이터-모델)
21. [Worker 엔드포인트](#21-worker-엔드포인트)
22. [Cloudflare Workers 청크 처리](#22-cloudflare-workers-청크-처리)

---

## 1. 시스템 개요

**한 페이지에 한 단원 전체.** 학생은 챕터별 월 구독으로 콘텐츠 열람.

| 구성 | 역할 |
|---|---|
| 학생 앱 | 챕터 카드 → 트리 학습 → 플래시카드 모드 |
| 선생님 앱 | 트리 CRUD + Ctrl+V 이미지 + TSV 일괄 입력 |
| **CRM** | 관리자 — 사용자/매출/콘텐츠/캐페인 + UTM 어트리뷰션 + QR 생성기 |
| 랜딩페이지 | 마케팅, 인터랙티브 데모, 결제 진입 (GitHub Pages → 아임웹 iframe) |
| Worker (API) | 인증·게이트·콘텐츠 CRUD·결제 외 모든 처리 |

---

## 2. 4가지 앱 + 백엔드

```
┌──────────────────────────────────────────────────────────────┐
│  학생:   https://onepage-study.vercel.app                     │   ← Vercel
│  선생님: github.io/flashcard-app/onepage-teacher.html         │   ← GitHub Pages
│  CRM:    onepage-crm-*.vercel.app                             │   ← Vercel (teacher 전용)
│  랜딩:   vipup.site/onepage-study (아임웹 페이지에 iframe)      │
│          ↳ iframe src = github.io/flashcard-app/onepage-landing.html
└─────────────────────────┬────────────────────────────────────┘
                          │
                          ▼
              onepage-api.memoryking.workers.dev
                          │
                ┌─────────┴─────────┐
                ▼                   ▼
            Airtable             nocodebackend
           (사람·돈)            (콘텐츠 6개 테이블)
```

- **Airtable**: 사용자·결제·포인트·캐페인 (5 테이블)
- **nocodebackend**: 챕터·콘텐츠·진도 (6 테이블)
- **PayApp**: 결제 (사용자님 자체 webhook → Airtable)
- **Airtable Automations**: 추천 보너스 자동 지급
- **Pabbly Connect**: CRM이 보낸 캐페인 페이로드 → ChatGPT 본문 생성 → SOLAPI(SMS) · Gmail(이메일) 분기 발송

---

## 3. 계층 구조

```
챕터 (Chapter)              ← 결제 단위, 월별 구독
  └ 목차 (Topic)          ← is_free=1이면 무료 열람
     └ 학습 카드 (Subtopic)    ← 학습 단위 (=플래시카드 1장)
        ├ 대표 이미지        ← 항상 보임 (표지)
        └ 내용 블록 (Items)  ← text/image, 펼침 시 표시
```

각 챕터는 `subject` (과목) 컬럼으로 그룹핑 — 수학·영어·한국사 등.

---

## 4. 결제 모델 (챕터별)

- **챕터당 월 3,000원~** (`monthly_price` 컬럼, 챕터마다 다른 가격 가능)
- 결제 후 **30일** 동안 그 챕터 전체 열람
- **자동결제 X** — 매월 본인이 직접 결제
- 만료 후 자동으로 무료 사용자 (그 챕터의 무료 목차만)

저장: Airtable `OnepageChapterAccess` (user×chapter 행마다 expires_at)

### 챕터별 페이앱 결제 링크 (`pay_url`)
- 각 챕터마다 자체 페이앱 결제 URL을 `op_chapters.pay_url`에 저장
- 학생 앱 "결제" 버튼 클릭 → 그 챕터의 `pay_url`로 직접 이동 (파라미터 없음)
- 빈 값이면 결제 버튼이 비활성화됨 (포인트 사용은 가능)
- 선생님 앱 챕터 편집 모달에 입력 칸 있음

### 미구매 챕터도 진입 가능 — 무료 목차 미리보기
- 챕터 카드 본문 클릭 → 트리 진입 (구매 안 했어도)
- `is_free=1`인 목차만 열람 가능, 나머지는 🔒 표시
- 결제 유도 동선 자연스럽게 — "둘러보기 → 마음에 들면 결제"

> 결제 → 학습기간 연장은 **Worker `/payapp/webhook` + Airtable Automation C1**이 자동 처리 (Pabbly 결제 라우터는 v2에서 제거됨).
> Worker는 `OnepageChapterAccess.expires_at`을 **읽기만** 함 (쓰기는 C1 Automation).
> 자세한 흐름은 § 5 [결제 자동화 파이프라인](#5-결제-자동화-파이프라인-payapp--pabbly--airtable) 참조.

---

## 5. 결제 자동화 파이프라인 (Worker REST + Airtable)

학생 결제 한 번 → 약 1분 안에 학습기간 자동 30일 연장. 페이앱 콘솔에 상품을 미리 등록할 필요 없이 **Worker가 결제 시점에 동적으로** 세션 생성.

### 전체 흐름 (현재 — Worker 기반)

```
학생 앱 (Vercel)
   │ ① 결제 버튼 → POST /payment/request { chapter_id }
   ▼
Cloudflare Worker — 결제 세션 생성
   │ a. JWT 인증 검증 (학생 phone 추출)
   │ b. nocodebackend op_chapters에서 chapter 조회 (title, price)
   │ c. PayApp REST API 호출 (api.payapp.kr/oapi/apiLoad.html)
   │    cmd=payrequest, userid, goodname, price, recvphone,
   │    feedbackurl=worker/payapp/webhook,
   │    var1=chapter_id (⭐ 매칭 키), var2=user_phone,
   │    checkretry=y, skip_cstpage=y
   │ d. PayApp 응답: { mul_no, payurl } (동적 생성)
   ▼
Worker → 학생 앱에 { payurl } 반환
   ▼
학생: window.open(payurl) → 페이앱 결제 페이지
   │ ② 카드/카카오페이/계좌이체 결제 완료
   ▼
PayApp → Worker /payapp/webhook (POST form-urlencoded)
   │ payload: mul_no, var1=3, var2=01098..., pay_state=4, price, ...
   ▼
Worker /payapp/webhook 처리
   ① 보안 검증 — userid/linkkey/linkval 일치 확인
   ② pay_state=4 외엔 SUCCESS만 (요청취소·승인취소·결제대기 무시)
   ③ 멱등성 검사 — 3 테이블(OnepagePayments/UnknownPayments/FailedPayments)에서 mul_no 검색
       중복 발견 → 즉시 SUCCESS
   ④ var1 → chapter_id 직접 (goodname 매칭 불필요!)
   ⑤ nocodebackend에서 chapter.title로 chapter_title 보강
   ⑥ Airtable OnepagePayments INSERT
   ⑦ HTTP 200 + body "SUCCESS" 응답 (PayApp retry-storm 방지)
   │
   ▼ OnepagePayments에 신규 행 생성
   │
   ▼ Airtable Automation C1 자동 트리거 (5~60초 지연)
Airtable Run a script (C1)
   │ 1. user_phone × chapter_id로 OnepageChapterAccess 검색
   │ 2. 기준일 결정: 활성이면 기존 expires_at, 만료/신규면 NOW
   │ 3. 기준일 + 30일 = 새 expires_at
   │ 4. upsert (기존 행 갱신 또는 신규 행 생성)
   ▼
학생 앱 새로고침
   │ GET /auth/me → Worker가 ChapterAccess 조회
   ▼
챕터 카드에 D-30 활성 표시 ✅
```

**총 소요 시간**: 페이앱 결제 완료 시점 + 1분 이내

### 이전 아키텍처 (deprecated — Pabbly 라우터)

**v1 (옛 방식)**: 페이앱 콘솔에 상품 미리 등록 → 정적 QR(`https://qr.payapp.kr/...`)을 `pay_url`에 저장 → 페이앱 공통 webhook URL을 Pabbly Connect로 → Pabbly 5단계 라우터 → goodname 키워드 매칭 → Airtable.

**v2로 마이그레이션 이유**:
- PayApp이 요구하는 `SUCCESS` 텍스트 응답을 Pabbly가 못 함 → 매번 10회 retry 발생
- goodname 키워드 매칭 실패 위험
- Pabbly에 Airtable PAT 평문 노출 위험
- 새 챕터마다 페이앱 콘솔에서 결제 링크 미리 만들어야 했음

**v2 (현재 — Worker REST)** 의 장점:
- ✅ `SUCCESS` 정확 응답 — retry 0회
- ✅ `var1=chapter_id` 직접 전달 — 매칭 실패 0%
- ✅ PAT 노출 없음 (Worker secret으로만 사용)
- ✅ 페이앱 콘솔 사전 등록 불필요 — 챕터 추가 시 선생님 앱에서 제목·가격만
- ✅ 멀티-base — 결제 요청 시 `feedbackurl` 동적 지정 (헬스 base 등 자유롭게 추가)

### Worker 엔드포인트 2개 (v2 핵심)

#### `POST /payment/request` — 결제 세션 생성 (학생 앱 호출)

학생이 결제 버튼 클릭 시 학생 앱에서 호출. JWT 인증 필요.

**요청**: `{ chapter_id: 3 }`

**Worker 동작**:
1. JWT에서 학생 phone 추출
2. nocodebackend `op_chapters`에서 챕터 조회 (title, monthly_price)
3. PayApp REST API 호출 (`https://api.payapp.kr/oapi/apiLoad.html`):
   ```
   cmd=payrequest
   userid={env.PAYAPP_USERID}
   goodname={chapter.title}
   price={chapter.monthly_price}
   recvphone={user.phone}
   feedbackurl={Worker self}/payapp/webhook   ← 동적 지정
   var1={chapter_id}                          ← 매칭 키
   var2={user_phone}
   checkretry=y
   skip_cstpage=y
   returnurl={STUDENT_APP_ORIGIN}/?paid=1&chapter={chapter_id}
   ```
4. PayApp 응답 `state=1&mul_no=...&payurl=...` 파싱
5. **응답**: `{ ok: true, payurl, mul_no }` → 학생 앱이 `window.open(payurl)`

#### `POST /payapp/webhook` — 결제 완료 수신 (PayApp 호출)

PayApp이 결제 완료 시 직접 호출. 공개 엔드포인트.

**Worker 동작**:
1. **보안 검증** — `userid` / `linkkey` / `linkval`이 Worker secret과 일치 확인. 불일치 시 silent SUCCESS (재시도 폭주 방지).
2. **상태 필터** — `pay_state=4`(결제완료)만 처리. 그 외(요청취소·승인취소·결제대기) SUCCESS만.
3. **멱등성 검사** — 3 테이블(OnepagePayments / UnknownPayments / FailedPayments)에서 `mul_no` 검색. 중복이면 즉시 SUCCESS.
4. **데이터 추출** — `var1 → chapter_id` (직접 사용, 매칭 불필요), `var2 → user_phone`
5. **챕터 제목 보강** — nocodebackend에서 `chapter.title` 가져와서 chapter_title 정확화
6. **저장 분기**:
   - `chapter_id > 0` → **OnepagePayments INSERT**
   - `chapter_id == 0` (var1 누락) → **UnknownPayments INSERT**
   - Airtable 에러 → **FailedPayments INSERT** (안전망)
7. **응답** — HTTP 200 + body `"SUCCESS"` (정확한 문자열 — PayApp이 retry 안 함)
   - 모든 저장 실패 시에만 HTTP 500 (retry 유도, Airtable 복구 후 다음 시도 성공)

### 6가지 검증 시나리오 (운영 전 필수)

| 테스트 | 페이로드 | 기대 결과 |
|---|---|---|
| A. 정상 결제 | `pay_state=4`, `var1=3` | OnepagePayments +1 (chapter_id=3), `SUCCESS` |
| B. 멱등성 | A를 한 번 더 발사 | 행 추가 없음, `SUCCESS` |
| C. var1 누락 | `pay_state=4`, `var1=` | UnknownPayments +1, `SUCCESS` |
| D. 결제 미완료 | `pay_state=2` | 변화 없음, `SUCCESS` |
| E. userid 불일치 | `userid=fake` | 변화 없음, `SUCCESS` (보안 silent skip) |
| F. Airtable 완전 다운 | (테스트 시뮬레이션) | HTTP 500, PayApp retry → 복구 후 다음 시도 성공 |

### Airtable Automation C1 — Payment → ChapterAccess +30일

**트리거**: OnepagePayments에 신규 행 생성 (`status = paid` 조건)

**액션**: `Run a script` (단일 액션)

**Input variables** (4개):
| Script 변수명 | 트리거 필드 |
|---|---|
| `user_phone` | OnepagePayments.user_phone |
| `chapter_id` | OnepagePayments.chapter_id |
| `chapter_title` | OnepagePayments.chapter_title |
| `mul_no` | OnepagePayments.mul_no |

**Script 핵심 로직**:
```javascript
const ADD_DAYS = 30;

// 1. 기존 행 검색
const existing = query.records.find(r =>
    r.user_phone === userPhone && r.chapter_id === chapterId
);

// 2. 기준일 결정 (활성이면 누적, 만료/신규면 NOW)
const now = new Date();
let baseDate = now;
if (existing) {
    const current = existing.getCellValue("expires_at");
    if (current) {
        const currentDate = new Date(current);
        if (currentDate > now) baseDate = currentDate;
    }
}

// 3. +30일
const newExpires = new Date(baseDate);
newExpires.setUTCDate(newExpires.getUTCDate() + ADD_DAYS);

// 4. upsert
if (existing) {
    await table.updateRecordAsync(existing.id, { expires_at, last_payment_id, source });
} else {
    await table.createRecordAsync({ user_phone, chapter_id, chapter_title, expires_at, ... });
}
```

**시나리오별 결과**:

| 학생 상황 | 기존 expires_at | 새 expires_at |
|---|---|---|
| 첫 결제 (신규) | (행 없음) | 오늘 + 30일 |
| 활성 중 재결제 (D-12) | 12일 후 | 12일 후 + 30일 = D-42 (누적) |
| 만료 후 재결제 | 30일 전 (만료) | 오늘 + 30일 (재시작) |
| 같은 결제 retry | — | 트리거 안 됨 (Pabbly에서 멱등성 차단) |

### Pabbly 라우터 멱등성·재전송 검증 시나리오

운영 들어가기 전 검증해야 할 6가지 케이스:

| 테스트 | 페이로드 | 기대 결과 |
|---|---|---|
| A. 정상 결제 | `goodname=수열...`, `pay_state=4` | OnepagePayments +1, result="created" |
| B. 멱등성 | A를 한 번 더 발사 | result="duplicate_skipped", 행 추가 없음 |
| C. 알 수 없는 상품 | `goodname=라면` | UnknownPayments +1, result="unknown_product" |
| D. 결제 미완료 | `pay_state=2` | 무시, 모든 테이블 변화 없음 |
| E. PayApp 실전 필드명 | `recvphone`/`buyer_email`/`price` | A와 동일 결과, 필드 정상 매핑 |
| F. 강제 Airtable 실패 | (테스트 시 base ID 변형) | FailedPayments +1, result="failed" |

### 트러블슈팅 매트릭스 — "결제했는데 안 열려요"

| OnepagePayments | OnepageChapterAccess | 원인 | 조치 |
|---|---|---|---|
| 행 없음 | — | Worker webhook 미도달 | `wrangler tail`로 실시간 로그 확인 + 페이앱 콘솔의 결제내역 확인 |
| 행 있음 (UnknownPayments) | — | `var1=chapter_id` 누락 | Worker `/payment/request`가 var1을 정확히 보내는지 확인 |
| 행 있음 (FailedPayments) | — | Airtable 일시 장애 | `error_message` 확인 + 수동 재처리 (OnepagePayments에 재투입) |
| 행 있음 (OnepagePayments) | 행 없음 | C1 Automation 미작동 | Automation 토글 ON 확인 + Run history 에서 에러 확인 |
| 행 있음 | 행 있는데 expires_at 비어있음 | C1 Script 에러 | Run history 로그 + Input variables 매핑 확인 |
| 모두 정상 | 모두 정상 | 학생 새로고침 안 함 | Pull-to-refresh 안내 |

### 페이앱 콘솔 설정

- **상품 등록**: 불필요 (Worker가 매번 동적으로 결제 세션 생성)
- **공통 통보 URL**: 비워둠 (개별 `feedbackurl`이 결제 요청 시 동적 지정됨)
- **연동 KEY/VALUE**: 설정 → 연동정보에서 확인 → Worker secret `PAYAPP_LINKKEY` / `PAYAPP_LINKVAL`에 등록

### Worker Secrets

```bash
cd onepage-worker
npx wrangler secret put PAYAPP_USERID    # 페이앱 판매자 아이디
npx wrangler secret put PAYAPP_LINKKEY   # 연동 KEY
npx wrangler secret put PAYAPP_LINKVAL   # 연동 VALUE
```

### 멀티-base 확장 (헬스 등 다른 사업 추가 시)

같은 페이앱 계정에서 여러 base를 운영하려면:
1. 각 base별로 Worker 인스턴스 또는 엔드포인트 분리
2. 학생 앱(또는 헬스 앱)이 결제 요청 시 자기 Worker URL을 호출
3. 각 Worker가 자기 base의 OnepagePayments에 저장
4. PayApp `feedbackurl`이 결제 요청 시 동적 지정되므로 자연스럽게 분기

페이앱 콘솔의 공통 통보 URL은 여전히 비워둠 — 개별 URL이 항상 우선.

### 운영 시 정기 점검

| 주기 | 점검 항목 |
|---|---|
| 매일 | FailedPayments 행 수가 0인지 |
| 매주 | UnknownPayments 검토 (var1 누락된 결제) |
| 매월 | 결제 건수(OnepagePayments) vs 활성 ChapterAccess 일치 + 페이앱 콘솔 정산 금액 일치 |

---

## 6. 포인트 시스템

### 환율
**`REDEEM_COST` P = 챕터 30일 연장** (현재 상수 3,000P. 향후 챕터별 가변 가능성 있음)

### 적립
- 친구가 내 추천으로 가입 + 첫 결제 → **양쪽 모두 +1,000P**
- 트리거: Airtable Automation이 `OnepagePayments` 신규 행 감지 → `first_paid_at` 비었으면 첫 결제로 판단 → 양쪽 +1000P + `OnepagePointTx` 행 추가

### 사용 (학생 앱)
- 홈에서 **💰 포인트 칩 클릭** → 포인트 모달
- 챕터별 4개 박스로 시각화:
  - 적립: 친구 1명 결제 = +1,000P
  - 사용: `REDEEM_COST` P → +30일
  - 유료 갱신: D-12 → D-42 (잔여 + 30)
  - 미구매 시작: → D-30
- 챕터 선택 → `REDEEM_COST` P 차감 + ChapterAccess 30일 연장
- 잔액이 또 `REDEEM_COST` 이상이면 모달 자동 재오픈 (연속 구매 편의)

> ⚠️ **UI 정책**: 사용자에게 보이는 문구에서 "3,000P = 챕터 1개월" 같은 고정 환율 표현 사용 금지. 챕터 가격은 1,000원짜리도 있어 혼동 우려. "포인트로 챕터 30일 연장" 처럼 가변 친화적 문구 권장.

### 워커 처리 (`POST /access/redeem`)
```js
// 활성 챕터면 잔여 + 30, 만료/미구매면 오늘 + 30
const base = curr && new Date(curr) > new Date(nowIso) ? curr : nowIso;
newExpires = addDays(base, 30);
// 포인트 차감 + PointTx 행 + ChapterAccess upsert
```

---

## 7. 추천 시스템

### 추천 코드
- 회원가입 시 Worker가 **6자리 base36 랜덤** 생성 (`MathUsers.referral_code`)
- 중복 시 재시도

### 추천 링크
```
https://vipup.site/onepage?ref=ABC123
```
- 학생 앱 헤더 **👥 추천 버튼** → 모달
- "📋 링크 복사" 버튼으로 클립보드 복사
- 친구가 링크 통해 가입 시 `referred_by_code` 컬럼에 기록

### 보너스 지급
**Airtable Automation에서** (워커는 관여 X):
1. `OnepagePayments` 신규 행 추가 감지
2. `MathUsers`에서 결제자 찾기
3. `first_paid_at`이 비었으면 (= 첫 결제)
4. `referred_by_code`로 추천인 찾기
5. 양쪽 `point += 1000`, `OnepagePointTx`에 2행 추가
6. 결제자 `first_paid_at`를 NOW()로

→ 1명 추천 = 1,000P, 모이면 포인트로 챕터 30일 연장

---

## 관심 주제 (interests)

학습자별 노출 챕터를 좁히는 개인화 필터. 한자·기술사·토익·수능 등 카탈로그가 커져도 본인 관심 분야만 보이게.

### 데이터 모델
- `OnepageUsers.interests` — 콤마 구분 과목 문자열 (예: `"수능,토익"`)
- 빈 값 또는 미설정 → 전체 챕터 노출 (필터 OFF가 기본)

### 학생 앱 동작
- 우상단 **👤 계정** 모달 → **🎯 관심 주제 → 편집** 모달에서 체크박스로 선택 + 필터 토글
- 필터 ON + interests 비어있지 않으면 그 과목의 챕터만 홈에 표시
- 필터 OFF 또는 interests 빈 값 → 전체 노출
- 필터 토글 상태는 `localStorage` 에 phone별로 저장 (새로고침해도 유지)

### URL 파라미터 자동 캡쳐 (마케팅용)
```
https://onepage-study.vercel.app/?interest=수능,토익
https://onepage-study.vercel.app/?interest=수능&interest=한자
```
- `captureUtmFromUrl()` 이 `?interest=` 파라미터를 파싱해 `localStorage`(30일 TTL)에 누적 저장
- 다중 방문 시 **누적(union, 중복 제거)** — 한자 광고 클릭 후 영어 광고 클릭 = 둘 다 캡쳐
- 가입 시 body.interests로 Worker 전송 → `OnepageUsers.interests` 에 저장
- 로그인된 사용자가 같은 URL 재방문해도 본인의 Airtable 값은 변경 X (localStorage만 갱신, 다른 사람 가입 대비)

### 우선순위
| 상황 | 진실의 출처 |
|---|---|
| 신규 가입 직전 | localStorage (URL 캡쳐) |
| 가입·로그인 이후 모든 시점 | **Airtable** (`/auth/me` 응답) |
| 모달에서 편집 | `PUT /auth/me/interests` → Airtable 즉시 업데이트 |

---

## 내 계정 모달 (학생 앱 우상단 👤)

홈 헤더 우상단 **👤** 버튼 → 종합 계정 모달.

### 구성
- **기본 정보**: 이름·이메일·전화·추천 코드 (노란 강조)
- **💰 포인트**: 잔액 + `사용하기 →` (포인트 모달로 이동)
- **📚 내 구독**: 활성 챕터 카드 (D-N 배지, D-7 이하 주황 경고) + 만료일 KST + 만료 챕터 3개 미리보기. 선생님 role은 `🛠 관리자 — 모든 챕터 무제한`
- **🎯 관심 주제**: 현재 선택 태그 표시 + `편집 →` (관심 모달로 이동)
- **🔒 보안**: `비밀번호 변경 →` (변경 모달)
- **푸터**: 🚪 로그아웃(빨강) + 닫기

### 비밀번호 변경
- 모달: 현재/새/확인 3칸. 6자 이상 + 확인 일치 검증
- Worker `POST /auth/change-password`:
  - `verifyPassword(old_password, password_hash)` → 틀리면 401
  - `hashPassword(new_password)` 로 PBKDF2 재해시 후 Airtable 업데이트
  - 변경 후 토큰은 그대로 유지 (재로그인 불필요)

### 비밀번호 찾기 — SMS 6자리 코드

로그인 화면 "비밀번호를 잊으셨나요?" 링크에서 진입. 2단계 모달.

**Step 1 — 이메일 입력**
- 로그인 폼의 이메일이 있으면 자동 채워 넣음
- `POST /auth/forgot-password { email }` 호출
- 서버: `findUserByEmail` → 6자리 코드 생성(`Math.random()`로 000000~999999) → KST 만료시각(+10분) → `atUpdate(AT_USERS, { reset_code, reset_code_expires_at })` → Pabbly 웹훅으로 SMS 발송
- **보안 — 이메일 enumeration 차단**: 미존재 이메일이어도 200 `{ ok:true, sent:false }` 반환. UI는 동일하게 "코드를 보냈습니다" 안내
- 존재 시 `phone_masked` (010\*\*\*\*5678) 반환 → UI에 표시

**Step 2 — 코드 + 새 비밀번호**
- 6자리 코드 + 새 비번 + 확인 입력
- `POST /auth/reset-password { email, code, new_password }`
- 서버 검증: `storedCode === code` && `expires_at > kstISOString()` && 새 비번 6자 이상 + 6자리 숫자
- 성공 시 `password_hash` 갱신 + `reset_code`/`reset_code_expires_at` 클리어
- UI: 로그인 화면 복귀, 이메일 자동 채움, 비번 칸에 포커스

**Pabbly 웹훅 운영**
- 환경변수 `PABBLY_RESET_WEBHOOK_URL` 우선, 없으면 기존 `PABBLY_WEBHOOK_URL` 폴백
- **권장**: 비밀번호 재설정 전용 워크플로우(Webhook → SOLAPI) 별도 구성. ChatGPT 단계 우회 — 보안 코드가 변형될 위험과 발송 지연 차단
- 페이로드: `{ template: 'password_reset', channel: 'sms', phone, custom_message: '[원페이지] 비밀번호 재설정 코드: 123456 (10분 유효)...' }`

---

### 다지기 모드 — 간격 반복(Leitner SRS)

챕터 헤더 우측 **● 다지기** 버튼 → 챕터 전체에서 ● 등록한 학습 카드만 모아 보여주는 화면. 단순한 리스트가 아니라 **카드별 due 일정**으로 그룹화돼서 학습 흐름이 자연스럽게 가이드됩니다.

**Leitner 6박스 (간격 2배수 증가)**:
| 박스 | 다음 due | 의미 |
|---|---|---|
| 1 | +1일 | 처음 ● 등록 |
| 2 | +2일 | 1차 회상 성공 |
| 3 | +4일 | 2차 |
| 4 | +8일 | 3차 |
| 5 | +16일 | 4차 |
| 6 | +32일 | 졸업 박스 — Box 6 이상 진행 안 함 |

**그룹 표시 (정확한 일수)**:
- 📍 **오늘 다지기** (빨강 강조) — overdue + today
- **내일 다지기** (주황)
- **2일 후 다지기** (주황)
- **N일 후 다지기** (3~7일=노랑, 8+=회색)
- 비어 있는 일수는 출력 안 함

**동작**:
- 안 펼치고 ⤴ 패스 = 회상 성공 → `POST /understood/advance` → Box +1, next_review_at 갱신
- 펼친 뒤 ⤴ 패스 = 회상 실패 → 기존 `silentUnmarkUnderstood` → 행 삭제 → 다음 챕터 회에서 미암기로 재등장
- 진입 시 스냅샷(`memoSnapshotIds`)에 모든 ● 카드 고정 → 펼쳐서 미암기 처리돼도 이번 회 시각적 깜빡임 없음
- 모두 패스되면 🎉 축하 폭죽 → snapshot 재빌드 + passedSet 정리 → 다음 회 시작

**marked_at·review_box·next_review_at**:
- 서버 `op_understood`: 토글 시 `marked_at=kstDateTime()`, `review_box=1`, `next_review_at=내일`
- `/understood/advance`: 박스 진행 + due 갱신
- 클라이언트 state: `understoodMarkedAt` / `understoodBox` / `understoodNextReview` 3 맵
- 옛 데이터(NULL next_review_at): "오늘 다지기" 그룹으로 분류 → 처음 패스 시 정상 진행

**꾹누르기 토스트**: "● 다지기 추가" / "다지기 해제" — 버튼·그룹 라벨과 일관성

## 8. 학습 인터페이스 — 플래시카드 모드

학생 앱의 **핵심 학습 흐름**. 스크롤 없이 단어를 연속으로 학습.

### 화면 구성
```
▼ 일상/대화 ⑫           [        ⤴ 패스         ]  ← 목차 헤더
  🟠 appointment                                    ← 학습 대상 (주황)
  ○ reservation
  ○ cancel
  ...
  ● therapy                                         ← 학습완료 (아래로)
  ● recover
```

목차 헤더 구성:
- **▶/▼** 화살표 — 펼침/접힘 표시
- **제목** — 목차 이름
- **⑫ 카운트 배지** — 제목 바로 뒤에 원형 표시 (학습 카드 총 개수, 학습 동기 부여)
- **⤴ 패스 버튼** — 헤더 오른쪽 끝까지 확장 (손가락으로 누르기 편함)

### 학습 동작 — 버튼 1개 + 꾹누르기 1개

| 동작 | 트리거 | 결과 | 저장 |
|---|---|---|---|
| **펼치기/접기** | 학습 카드 짧게 탭 | 내용 표시 (아코디언). 챕터 내 `everExpandedSet`에 기록됨 | — |
| **패스** | 목차 헤더의 **⤴ 패스** 버튼 | 맨 위 학습 카드가 이번 회에서 빠짐 + 펼침 이력 따라 자동 ●/미암기 분류 | localStorage (챕터 단위, 영구) + 서버 |
| **완료/다시 토글** | 학습 카드를 600ms 꾹누르기 | 학습완료 ● 표시 ↔ 미학습 토글 (수동) | DB (`op_understood`) |

→ 버튼 1개 + 꾹누르기 1개로 모든 학습 흐름 처리. 버튼은 단순하고 크게, 동작은 직관적으로.

### 패스 버튼 자동 분류 (v2 핵심 UX)

패스 버튼은 단순히 "건너뛰기"가 아니라 **챕터 안에서의 펼침 이력**을 보고 학습 상태를 자동 갱신합니다.

| 현재 상태 | 챕터 내 펼친 적 | 패스 결과 |
|---|---|---|
| 미암기 | ✅ 있음 | 미암기 그대로 (다음 회에 다시 등장) |
| 미암기 | ❌ 없음 | **자동 ● 암기** ("안다" 신호) |
| ● 암기 | ✅ 있음 | **미암기로 전환** ("다시 봐야 했다", 다음 회에 다시 등장) |
| ● 암기 | ❌ 없음 | ● 그대로 유지 |

**구현 메커니즘:**
- `state.everExpandedSet` (Set, 챕터 단위) — `subClick`의 펼침 분기에서 추가
- `studyPass`가 호출되면 `wasOpened = everExpandedSet.has(subId)` 판정
- `wasOpened === true` → `silentUnmarkUnderstood()` (펼친 → 미암기 자동)
- `wasOpened === false` → `silentMarkUnderstood()` (안 펼친 → ● 자동)
- 두 silent 함수 모두 화면 갱신·토스트 없이 백그라운드로 서버 동기화 (실패 시 롤백)
- 챕터 진입 시(`enterChapter`) `everExpandedSet`이 새 Set으로 초기화 → 매 회 새 라운드

### 모두 패스 시 — 폭죽 축하 + 자동 재시작
목차 안 **모든** 학습 카드를 패스(완료된 것도 포함)하면:
1. 화면 가득 폭죽 🎉 오버레이 + "수고하셨어요!" 메시지 (1.5초)
2. 자동으로 해당 목차의 패스 상태 초기화
3. 처음부터 다시 학습 시작

→ "다시 시작" 버튼 없이도 한 사이클이 자연스럽게 닫힘.

### 첫 단어 강조
첫 미학습 학습 카드는 🟠 **주황 배경**으로 강조 → "지금 이걸 학습하세요" 신호.

### 영구 저장된 패스 상태
- 키: `localStorage.op_passed_<chapterId>`
- 챕터 진입 시 자동 복원 → 마지막 학습 위치에서 계속

### 마지막 본 콘텐츠 자동 로딩
- 페이지를 닫았다 다시 열어도 마지막에 보던 챕터·목차·학습 카드가 그대로 복원
- 페이지 단위로 기억하므로 다른 탭에서 다른 챕터를 봐도 충돌 없음

---

## 9. 콘텐츠 정렬 규칙

학습 카드는 다음 순서로 자동 정렬:

1. **미학습** (`understood=false` AND `passed=false`) — 위에
2. **학습완료** (`understood=true`) — 아래로
3. **패스됨** — 화면에서 숨김 (전부 패스 시 폭죽 후 자동 초기화)

같은 그룹 내에서는 `sort_order` 기준.

→ 위에서 아래로 읽기만 하면 자연스럽게 미학습부터 보임.

---

## 10. 위치 고정 — 학습 중 스크롤 안 밀림

학습 액션 시 화면이 흔들리지 않도록 두 단계 방어:

### CSS 단계 — Auto-scroll 방지
```css
.chapter-tree {
  padding-bottom: 100vh;   /* 마지막 목차 아래 1화면 분 여유 */
  overflow-anchor: none;
}
```
- 페이지가 항상 충분히 길어서 콘텐츠 줄어도 max-scroll 발동 X
- 마지막 목차에서 패스해도 위에서 콘텐츠 안 내려옴

### JS 단계 — withTopicAnchor
```js
function withTopicAnchor(topicId, callback) {
  const head = document.querySelector(`[data-topic="${topicId}"] > .topic-head`);
  const beforeY = head?.getBoundingClientRect().top;
  callback();  // 상태 변경 + renderTree
  // 즉시 + 다음 frame 두 번 보정 (브라우저 timing 대응)
  adjust(); requestAnimationFrame(adjust);
}
```
- 목차 헤더(패스 버튼 포함)의 화면 Y 위치 캡쳐
- 렌더 후 위치 변화량만큼 scrollBy로 보정
- 패스 / 꾹누르기 / 펼침 모두 이 함수로 감싸짐

→ 패스 버튼 위치가 항상 같은 자리에 있어 연속 탭 가능

### 학습 카드 펼침도 동일
`subClick` 함수도 같은 패턴으로 펼침 시 위치 보정.

---

## 11. 선생님 — 콘텐츠 관리

### 트리 CRUD
- 챕터 → 목차 → 학습 카드 → 내용 블록 (4단계)
- 각 단계 추가/편집/삭제 (`✎`/`🗑️`)
- DB FK CASCADE로 챕터 삭제 시 아래 모두 자동 정리

### 학습 카드 편집 모달
- 제목·sort_order
- **대표 이미지** picker + 클립보드 붙여넣기 + 캡션
- 이미지는 op_subtopics.image_b64에 base64로 저장

### 내용 블록 (op_items)
- 텍스트 또는 이미지 단위
- 텍스트: `prompt()`로 빠른 추가/편집
- 이미지: 파일 업로드 또는 Ctrl+V 페이스트

### 모두 접기 / 새로고침 / 일괄 입력
- 툴바에 버튼 3개

### 공개/비공개 (draft)
쇼핑몰 상품처럼 콘텐츠를 미리 올려두고 공개 시점 결정 가능.

- 챕터 편집 모달 → **🌐 학생에게 공개** 체크박스
- **신규 챕터는 기본 비공개** — 콘텐츠 다 채운 후 명시적 공개
- 비공개 챕터:
  - 선생님 앱: 카드 흐림 + `📝 비공개` 배지 + 제목 옆 `(비공개)` 표시 → 모두 노출
  - 학생 앱: `/chapters` 응답에서 제외 → 카드 자체가 안 보임
- `op_chapters.is_published` 컬럼 (BOOLEAN, default `1`)
  - Worker가 `is_published=0`인 챕터만 학생에게 숨김
  - NULL/미존재는 공개로 간주 (기존 데이터 호환)

### 콘텐츠 블록 (op_items) 종류 3가지

| `kind` | 저장 필드 | 학생 앱 렌더링 |
|---|---|---|
| `text` (기본) | `text` (+ 선택 `caption`) | 본문 + 본문 안의 URL 자동 링크화 + 선택적 작은 설명 캡션 |
| `image` | `image_b64` (data URL) + 선택 `caption` | 이미지 + 캡션 |
| **`link`** | `text` = URL (+ 선택 `caption` = 제목/설명) | URL 종류 따라 분기 (아래) |

#### `link` 분기 — Gumlet vs YouTube vs 일반

| URL | 학생 앱 표시 | 이유 |
|---|---|---|
| `play.gumlet.io/...` | **16:9 iframe 임베드** (페이지 안 재생, 자동 `embed/` 정규화) | Gumlet 정책 무관, 직접 재생 OK |
| `youtube.com/watch?v=…`, `youtu.be/…`, `youtube.com/shorts/…` | **빨간 링크 카드** + mqdefault 썸네일 → 클릭 시 새 탭으로 YouTube | YouTube ToS 상 임베드 외부 노출 제약 → 학생 앱 안 재생 X |
| 그 외 모든 URL | 시안 톤 링크 카드 (🔗 + 제목) → 새 탭 | |

**선생님 앱 동작**:
- `+ 🔗 링크` 버튼: URL + 제목 prompt → `kind='link'` 로 저장. 프로토콜(`http(s)://`) 없으면 자동 prepend
- `+ 텍스트` 버튼: 본문 + 설명 prompt → `kind='text'` 로 저장
- 둘 다 ✎ 버튼으로 후속 수정 가능

**학생 앱 동작 (URL 처리)**:
- `kind='link'`: 위 표대로 분기 렌더링
- `kind='text'` 안의 URL: `autolinkText()` 헬퍼가 `http(s)://`/`www.` 패턴 자동 감지해 `<a class="inline-link">` 로 감싸 클릭 가능. 모든 환경(iOS/Android/PC)에서 클릭 동작하도록 `pointer-events: auto`·`touch-callout: default` 명시
- URL에 프로토콜 누락 시 `normalizeUrl()` 이 렌더 시점에 `https://` 자동 prepend → 상대 경로 오해 방지

### 발음 듣기 (Web Speech API)

학생 앱에서 학습 카드 제목 옆 **🔊** 버튼 클릭 → 그 단어를 음성으로 재생.

| 동작 | 디테일 |
|---|---|
| 기술 | 브라우저 내장 `speechSynthesis` API — 외부 API 키·과금 없음 |
| 언어 | `detectSpeechLang`: 라틴 문자 있으면 `en-US`, 아니면 `ko-KR` |
| 속도 | `rate: 0.85` (학습용으로 살짝 천천히) |
| 표시 조건 | 학습 카드 제목에 라틴 문자 포함 **AND** 한글 미포함일 때만 (`/[a-zA-Z]/` 통과 + `/[가-힯ᄀ-ᇿ㄰-㆏]/` 미통과) |
| 연속 클릭 | `speechSynthesis.cancel()` 로 진행 중 음성 중단 후 재생 |
| 펼침·꾹누르기 분리 | `event.stopPropagation()` 을 click·mousedown·touchstart 모두에 |

OS 네이티브 음성을 사용하므로 iOS/Android/Mac/Windows에서 자연스러운 발음. 안 들리면 무음 모드 또는 시스템에 영어 voice 미설치 가능성.

### 드래그앤드롭 순서 변경 (SortableJS)
각 항목 좌측의 **⋮⋮ 핸들**을 끌어 같은 부모 안에서 순서 변경. 떨어뜨리면 자동 저장.

| 레벨 | 끌어옮길 수 있는 범위 |
|---|---|
| 목차 | 같은 챕터 안에서 |
| 학습 카드 | 같은 목차 안에서 |
| 내용 블록 | 같은 학습 카드 안에서 |

**기술 구현**
- SortableJS 1.15.2 CDN, `forceFallback: true` (모든 브라우저·모바일 호환)
- 핸들 분리: `.drag-handle`만 드래그 시작점, 클릭은 stopPropagation으로 분리
- 컨테이너 wrapper: `<div class="reorder-list" data-sortable="topics|subtopics|items" data-parent-id="N">`
- Worker 일괄 갱신: `POST /topics/reorder`, `/subtopics/reorder`, `/items/reorder`
  - Body: `{ ordered_ids: [n,n,n], start_index: 0 }` — 30개씩 청크 분할 (subrequest 한도 안전)
- 클라이언트 낙관적 업데이트: 성공 시 로컬 `state.X.sort_order` 동기화, 실패 시 fresh load 복구

**데이터 무결성 — 사용자 학습 기록 보존**
- 모든 사용자 reference는 `subtopic_id` 기준 → `sort_order` 변경 무영향
- 콘텐츠 삭제 시: `op_understood.subtopic_id` FK CASCADE → 모든 사용자의 그 학습 카드 꾹누른 기록 자동 정리
- 콘텐츠 추가: 학생 앱이 매번 fresh fetch → 즉시 반영, 새 sort_order 위치에 표시

---

## 12. 일괄 입력 (TSV)

엑셀 → 복사 → 붙여넣기 한 번에 콘텐츠 대량 입력.

### 포맷 (가로형)
```
A: 목차       B: 학습 카드    C~ : 내용1, 내용2, 내용3 ...
─────────────────────────────────────────────
조선 왕의 업적   세종        훈민정음 창제  집현전 설치  4군 6진 개척
                성종        경국대전 완성  홍문관 설치
```

- 목차 칸 비우면 "이전 목차에 계속"
- 첫 행 헤더(`목차`)는 자동 스킵
- C열부터 끝까지가 그 학습 카드의 N개 내용 항목

### Excel 멀티라인 셀 지원 + stray quote 처리
- 셀 안에 Alt+Enter로 줄바꿈한 경우 Excel은 셀을 `"..."`로 감쌈
- 파서가 따옴표 안의 `\n`을 행 구분자로 안 보고 셀 내용으로 처리
- 따옴표 안의 `""`는 이스케이프된 `"`로 복원
- **`"`는 셀의 첫 글자(파일 시작·`\t`·`\n` 직후)일 때만 quote 모드 시작** — 셀 중간의 stray `"`(예: 영어 단어 `He said "hello"`) 은 일반 문자로 처리되어 다음 행을 삼키지 않음

### 토픽 중복 방지 (append 모드)
- 첫 호출(`start=0`)에서 기존 토픽을 `topicMap`에 prepopulate
- TSV가 동일 이름의 기존 토픽 참조 시 새로 만들지 않고 기존 ID 재사용

### 3가지 모드

| 모드 | 동작 | 학생 학습 기록 영향 |
|---|---|---|
| **append** (기본) | 기존 내용 뒤에 추가 — 동일 이름 목차·학습 카드 재사용해서 items만 누적 | ✅ 보존 (subtopic_id 유지) |
| **✨ merge** | 동일 이름 목차·학습 카드 그대로 두고 **items만 전부 교체** — 콘텐츠 업데이트용 | ✅ **완벽 보존** (subtopic_id 유지, 꾹누른 기록 그대로) |
| ⚠️ **replace** | 챕터의 모든 목차 삭제 후 신규 입력 | ❌ FK CASCADE로 모든 꾹누른 기록 삭제됨 |

#### merge 모드 동작 디테일
- 첫 호출에서 모든 기존 토픽 + 그 학습 카드들을 한 번에 읽어 `topicMap`·`subMap`·`originalSubIds` 채움
- TSV 행마다:
  - 동일 이름 목차·학습 카드 발견 → 기존 ID 재사용
  - 그 학습 카드가 "원래 있던 것"이면 첫 만남 시 기존 items 일괄 삭제(`clearedSubs` 마킹) → 새 items 입력
  - TSV에 없는 기존 목차·학습 카드는 그대로 둠 (수동 정리 필요 시 선생님 앱에서)
- `originalSubIds`·`clearedSubs` 는 청크 간 body로 왕복하며 상태 유지 (한 학습 카드의 items가 많아 한 청크에 못 끝나면 다음 청크에서 재시도)

### 파일 업로드 대안
- 큰 데이터는 엑셀 → "텍스트 (탭으로 분리)(*.txt)"로 저장
- 모달의 **📂 파일에서 불러오기** 버튼으로 로드
- textarea 우측에 행/글자 수 실시간 표시

### Cloudflare 청크 처리
→ [§17 청크 처리](#17-cloudflare-workers-청크-처리) 참조

---

## 13. 이미지 처리

### 클라이언트 압축
- 선생님 앱에서 이미지 paste/upload 시:
- Canvas로 최대 폭 **1200px** 리사이즈
- **WebP 0.85** 인코딩 (Safari 폴백 JPEG)
- base64 data URL로 변환
- 평균 50~150KB, 300KB 초과 시 사용자에게 경고

### nocodebackend JSON 컬럼 우회
- `op_items.image_b64`·`op_subtopics.image_b64`는 LONGTEXT
- 그런데 REST API 스키마 캐시가 여전히 JSON 검증 → 평문 문자열 거부
- Worker가 **저장 시 JSON.stringify로 한 번 더 wrap**, 읽을 때 unwrap
- 클라이언트는 raw data URL만 받음

```js
// 저장: "data:image/..."  →  "\"data:image/...\""
// 읽기: "\"data:image/...\""  →  "data:image/..."
function wrapImg(s) { return s ? JSON.stringify(String(s)) : null; }
function unwrapImg(s) { ... }
```

### 두 종류 이미지
| 용도 | 위치 | 표시 |
|---|---|---|
| **대표 이미지** | `op_subtopics.image_b64` | 항상 보임 (펼치지 않아도) |
| **내용 이미지** | `op_items.kind='image'` | 펼침 시 본문 안에 |

---

## 14. 보안 — 워터마크·캡쳐 차단

### 전화번호 워터마크
- 학생 화면 전체에 **대각선 반복** SVG 패턴
- 사용자의 phone (정규화된 형태, 예: `010-1234-5678`) 표시
- 반투명 (rgba 0.06)이라 학습에는 방해 X, 캡쳐 후 보정하면 또렷이 보임

```js
function renderWatermark() {
  // SVG <pattern>에 사용자 phone 텍스트, 대각선 반복
}
```

### 복사·인쇄·우클릭 차단
```js
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && ['c','a','s','p','u'].includes(k)) e.preventDefault();
});
```
- 입력 필드(input/textarea)에서는 허용
- `@media print { html,body { display:none } }` — 인쇄 시 빈 페이지
- `user-select: none` — 텍스트 드래그 선택 차단
- `pointer-events: none` on images — 우클릭 → 이미지 저장 차단

→ 캡쳐 자체는 못 막지만, 워터마크로 유출자 즉시 특정.

---

## 15. 라이브 학습자 카운트

### 헤더에 "🟢 N명 학습 중" 표시
- 60초마다 `POST /stats/ping` 호출 (학생 앱)
- nocodebackend `op_pings` 테이블에 (phone, first_ping_today) upsert
- `GET /stats/learners-now`가 `first_ping_today = 오늘`인 행 수 반환

### "오늘 N명"
- KST 기준 자정에 자동 리셋 (다음 ping부터 새 카운트)
- 실시간 학습 인원 = 오늘 한 번이라도 ping 보낸 사용자 수

---

## 15-B. 사용법 가이드 페이지 ([guide.html](onepage-user/guide.html))

학생 앱 홈 헤더 우상단 **📖** 버튼 → 같은 탭에서 `/guide.html` 이동. ← 버튼으로 학생 앱 복귀 (`history.back()` + history 빈 경우 `/` 폴백). 학생 앱 상태는 localStorage에 있어 재진입 시 그대로 복원.

### 구조 (위에서 아래로)
1. **상단 sticky 진행 바** — 닫기 ← + "사용법 가이드" 타이틀 + 7개 도트(스크롤 따라 자동 강조, 클릭 점프)
2. **⚡ 학습의 대원칙** 카드 — 슬로건 "현명한 반복은 당신을 천재로 만듭니다" + 4가지 원칙 (그라데이션 텍스트 + 셰이머 애니메이션)
   - 반복 앞에서 안 외워지는 것은 없습니다
   - 결국 목차도 외워져 있어야 합니다
   - 다양함이 기억을 굳힙니다
   - 콘텐츠는 계속 진화합니다
3. **히어로** — "7가지만 알면 원페이지 학습 끝 · 1분이면 충분합니다"
4. **👀 전체 보기** — 5개 화면 캡쳐 격자 (메인 / 학습 / 다지기 / 내 계정 / 포인트 사용). 사용자가 이미지 편집기에서 말풍선까지 합쳐 PNG 로 올리는 방식
5. **STEP 1~7** — 각 단계 = 제목 + 영상(자동 재생 무음 루프) + 짧은 설명 + 팁 박스
6. **하단 CTA** — "준비 완료! 앱으로 돌아가기 →"

### 미디어 자산 (onepage-user/guide-media/)

| 형식 | 권장 사양 | 자리 |
|---|---|---|
| MP4 (7편) | 720×1280 또는 1280×720, H.264, CRF 28, 무음, 3~6초 루프 | STEP 1~7 |
| PNG (5장) | 본인 비율 그대로 (PC·태블릿·모바일 캡쳐 자유) | 전체 보기 |

배포는 Vercel 정적 서빙 — `git push` 한 번이면 끝. CSS `aspect-ratio` 강제 없음 → 이미지 자기 비율 유지.

### STEP 3 — 패스 버튼 똑똑한 분류 (특별 강조)
STEP 3는 4분면 미니 매트릭스로 시각화:
- 안 펼치고 패스 → 자동 ● 암기 (초록)
- 펼친 뒤 패스 → 미암기로 자동 (주황, 원래 ●여도 풀림)
챕터 나가면 펼친 기록은 초기화 — 매 회 새 라운드.

---

## 16. 관리자 CRM 대시보드

[onepage-crm/index.html](onepage-crm/index.html) — `role=teacher` 전용 통합 운영 콘솔. 5개 탭으로 사용자·매출·콘텐츠·캐페인·마케팅을 한 화면에서 관리.

### 📊 대시보드 탭
- KPI 카드 7장: 오늘 매출 · 이달 매출 · 활성 구독자 · 7일 내 만료 · 신규 가입 · 휴면 · 미결제
- 만료 임박 리스트 (D-7 이내) → 클릭하면 갱신 캐페인 바로 발송
- 최근 결제 20건 + 챕터 매출 TOP 10 (MRR 포함)

### 👥 사용자 탭
- 검색 (이름/전화/이메일) + 6개 세그먼트 필터:
  - 전체 / 활성 구독 / 7일 내 만료 / 휴면 / 미결제 / VIP(누적 5만원+)
- 표 컬럼: 이름·전화·상태·누적 결제·포인트·최근 학습·가입일·액션
- 체크박스 선택 → 일괄 캐페인 발송
- 행 클릭 → 사용자 상세 모달 (구독·결제·포인트 이력 + UTM 유입 경로)
- **포인트 지급/차감** — 사유 + 메모 (자동 PointTx 기록 + 관리자 이름 각인)

### 👥 사용자 상세 모달 — 챕터 권한 수동 관리 (v2 신규)

**📚 챕터 구독** 섹션에 두 가지 액션 추가:

#### 🎁 새 챕터 권한 지급
헤더의 "새 챕터 권한 지급" 버튼 클릭 → 모달:
- 챕터 드롭다운에서 선택
- 일수 입력 + 빠른 버튼 (**+7일**, **+30일**, **+90일**, **+1년**)
- 사유 선택: 관리자 지급 / 무료 체험 / 이벤트 보상 / 사과 보상 / 환불 대체 / 기타
- (선택) 메모 입력

→ Worker `POST /admin/access/grant` 호출 → OnepageChapterAccess 행 즉시 생성/갱신
- 활성 사용자: 기존 expires_at + N일 (누적)
- 만료/신규: NOW + N일

#### 🗑️ 권한 회수
각 챕터 행의 🗑️ 버튼 → 확인 다이얼로그 → Worker `DELETE /admin/access/:phone/:chapter_id` → OnepageChapterAccess 행 즉시 삭제

#### 🗑️ 회원 완전 삭제 (v2 신규)

상세 모달 액션 영역의 **🗑️ 회원 삭제** 버튼 (teacher 계정에는 미노출) → 휴대폰 번호 재입력 확인 → Worker `DELETE /admin/user/:phone` → 연관 7곳 일괄 정리:

| 저장소 | 테이블 | 키 |
|---|---|---|
| Airtable | `OnepageUsers` | phone |
| Airtable | `OnepageChapterAccess` | user_phone |
| Airtable | `OnepagePayments` | user_phone |
| Airtable | `OnepagePointTx` | user_phone |
| Airtable | `OnepageCampaignSends` | phone |
| nocodebackend | `op_understood` | user_phone |
| nocodebackend | `op_pings` | user_phone |

- Worker가 6개 테이블에서 모든 관련 행을 병렬 조회 → 합계가 안전한도(30건) 초과 시 **413 Payload Too Large** + 수동 정리 안내
- 한도 내면 10개씩 병렬 `atDelete`/`ncbDelete` → 마지막에 사용자 본인 → 완료 응답 `{ ok, total, deleted: { user, access, payments, point_tx, sends, understood, pings } }`
- 자동 가드: `role === 'teacher'` 계정은 서버에서 403 거부
- 가시화: alert 으로 각 테이블 삭제 건수 + 합계 표시 → 사용자 목록 자동 갱신

**전화번호 수동 변경은 미보류** — 학습 이력이 op_understood 에 user_phone 으로 박혀 있어 헤비 유저(>40 이력)에서 청크 분할 호출이 필요. 별도 작업으로 분리.

#### 식별 — `source` 컬럼으로 진짜 결제와 구분
| `source` 값 | 의미 |
|---|---|
| `purchase` | 실제 결제 (Worker `/payapp/webhook`) |
| `point_redeem` | 학생이 포인트 사용 |
| **`admin_grant`** | **CRM에서 수동 지급** |

→ 매출 통계는 `source=purchase`만 집계 → 무료 부여가 매출에 섞이지 않음.

#### 활용 시나리오
| 케이스 | 액션 |
|---|---|
| 친구 가입 환영 7일 무료 체험 | +7일, "free_trial" |
| 이벤트 당첨자 30일 보상 | +30일, "event_reward" + 메모에 이벤트명 |
| 서비스 장애 사과 7일 추가 | +7일, "apology" |
| 환불 후 권한 회수 | 🗑️ 버튼 |
| VIP 1년권 일시 지급 | +365일 |

### 💰 매출 탭
- 기간 선택: 7일 / 30일 / 90일 / 1년
- 일별 매출 막대 차트 (CSS, 호버 툴팁)
- 챕터별 매출 + TOP 결제자 20명

### 📚 콘텐츠 탭
- 챕터별 구독자 수 · 예상 MRR · 연 환산
- `pay_url` 미설정 챕터 ⚠️ 경고 (결제 버튼이 비활성화되는 챕터 식별)
- 콘텐츠 편집기(선생님 앱) 바로가기

### 📤 캐페인 탭
[17. 캐페인 발송](#17-캐페인-발송-pabbly-웹훅) 참조.

### 🎯 마케팅 추적 탭
[16. 마케팅 어트리뷰션](#16-마케팅-어트리뷰션--qr-생성기-utm) 참조.

### 인증
- 동일 `/auth/login` 사용 (학생 앱과 같은 계정)
- 로그인 후 `role !== 'teacher'`면 즉시 거부
- 모든 `/admin/*` 엔드포인트는 teacher gate 통과해야 함

---

## 17. 마케팅 어트리뷰션 + QR 생성기 (UTM)

가입자의 **유입 경로**를 자동 추적해 어떤 캐페인·디자인이 매출로 이어지는지 측정.

### URL 구조 (Google Analytics 호환 UTM)
```
https://vipup.site/onepage-study?utm_source=flyer&utm_medium=qr&utm_campaign=school-A&utm_content=design-B
                                  └─소스─┘     └─매체─┘  └──캐페인──┘    └─디자인/콘텐츠─┘
```

| 파라미터 | 의미 | 예시 |
|---|---|---|
| `utm_source` | 광고 매체 종류 | `flyer`, `youtube`, `instagram`, `kakao`, `blog` |
| `utm_medium` | 어떻게 노출 | `qr`, `video`, `bio`, `banner`, `email` |
| `utm_campaign` | 캐페인 그룹 키 | `school-A`, `spring2026`, `launch-week` |
| `utm_content` | A/B 디자인 변형 | `design-A`, `design-B`, `cta-red` |
| `utm_term` | 키워드 (선택) | `winter-special` |

### 흐름 (랜딩 → 학생 앱 → CRM)
```
1. 전단지 QR 스캔 → vipup.site/onepage-study?utm_source=...
2. 랜딩페이지(iframe)가 utm을 localStorage 'op_utm'에 저장 (30일)
3. "시작하기" 클릭 → 학생 앱(다른 origin)에 URL 파라미터로 전달
4. 학생 앱이 utm을 자체 localStorage에 저장 (30일, cross-origin 우회)
5. 가입 시 /auth/signup 본문에 utm 객체 첨부
6. Worker가 Airtable OnepageUsers 새 행에 utm_* 필드 7개 영구 저장
7. CRM 어트리뷰션 탭이 가입자×결제 join → 캐페인별 성과 집계
```

### 30일 유지·재방문 attribution
- localStorage TTL = 30일 → QR 스캔 후 1주일 뒤 가입해도 attribution 유지
- 가입 완료 후 localStorage 자동 삭제 (다음 UTM 진입에 영향 없도록)
- 첫 진입의 UTM만 저장 (이후 utm 없이 재방문해도 덮어쓰지 않음)

### CRM "🎯 마케팅 추적" 탭
3단계 드릴다운으로 성과 분석:
1. **소스별** — `utm_source` 단위 (flyer / youtube / instagram 비교)
2. **소스 + 매체별** — `utm_source / utm_medium`
3. **캐페인 + 디자인별** — 가장 자세 (A/B 디자인 비교에 사용)

각 행에 표시: 가입 수 · 결제 수 · 전환율 · 매출 · ARPU(가입자당 매출).
**전환율이 전체 평균보다 높으면 초록색**, 낮으면 빨간색 → 한눈에 승자 식별.

### QR 코드 생성기 + URL 빌더
- 입력 칸 5개 (source/medium/campaign/content/term) — 입력 즉시 추적 URL과 QR 갱신
- 8개 프리셋 (전단지 A·B·C / 유튜브 / 인스타 / 카카오 / 블로그)
- 📥 PNG 다운로드 (600px, 고해상도, 인쇄용)
- 🖨 인쇄 — 새 창에 QR + 라벨 + URL
- 📋 URL 복사
- 라이브러리: 입력값과 메모를 **Airtable `OnepageCampaigns`에 영구 저장** → 모든 기기·관리자 공유
- 클라이언트 라이브러리: [`qrcode-generator@1.4.4`](https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js)

### 실전 시나리오
- **전단지 A/B/C 테스트**: 학교 정문에서 3가지 디자인 → 1~2주 뒤 CRM에서 전환율 비교 → 승자 채택
- **유튜브 영상별 성과**: 영상마다 다른 캐페인 ID → 어느 콘텐츠가 더 효과적인지 데이터로 확인
- **랜딩 카피 A/B**: 같은 광고 예산 50/50 → ARPU 높은 카피 채택

---

## 18. 캐페인 발송 (Pabbly 웹훅)

CRM에서 선택한 사용자 그룹에 SMS·이메일을 자동 발송. Worker는 [Pabbly Connect](https://connect.pabbly.com/) 웹훅으로 페이로드만 보내고, Pabbly 워크플로우가 ChatGPT로 본문을 생성한 뒤 **SOLAPI(SMS)** · **Gmail(이메일)** 로 분기 발송.

### 전체 흐름
```
CRM에서 사용자 선택 + 메시지 작성
   ↓
POST /admin/webhook/send { phones[], template, channel, custom_message, subject }
   ↓
Worker가 사용자 정보(name/email/point/access 등) 보강
   ↓
한 명씩 Pabbly 웹훅에 POST (env.PABBLY_WEBHOOK_URL 또는 요청 body.webhook_url)
   ↓
Pabbly 워크플로우 5단계 실행 (아래 참조)
   ↓
Worker는 Pabbly가 200 OK 반환했는지만 확인 → CRM에 결과 리스트 반환
   ↓
CRM "최근 발송 결과" 테이블: 채널 / 전화 / 이메일 / 결과 4컬럼 표시
```

### Pabbly Connect 워크플로우 구조 (5단계)

| Step | 종류 | 역할 |
|---|---|---|
| 1 | **Webhook (Catch Webhook)** | Worker 페이로드 수신 — phone/name/email/template/channel/subject/custom_message/point/referral_code/first_paid_at 등 |
| 2 | **ChatGPT (OpenAI)** | gpt-3.5-turbo로 페이로드 변수 기반 마케팅 본문 생성. Messages는 system+user 형식, Response Format = Text, Max Tokens 250, Sampling 0.7 |
| 3 | **Router by Pabbly** | 2갈래 분기 (Route 1 SMS / Route 2 Email) |
| 4 | **Filter (Pabbly)** | 각 Route 시작점에서 `channel = sms OR both` (Route 1) / `channel = email OR both` (Route 2) 조건 통과만 다음 단계로 |
| 5A | **SOLAPI (Private) — Send Text Message** | SMS 갈래: 발신번호(Solapi 등록필수) + `{{1.phone}}` + ChatGPT 본문 |
| 5B | **Gmail — Send Email** | Email 갈래: Sender Name=OnePage Study, Recipient=`{{1.email}}`, Subject=`[OnePage Study] {{1.subject}}`, Content Type=HTML, 본문 템플릿에 ChatGPT 응답 삽입 |

> `channel = both` 면 Step 4 두 Route 모두 통과 → SMS+Email 양쪽 발송. SOLAPI는 HMAC-SHA256 서명을 Private 앱이 내부 처리해서 별도 Code 노드 불필요.

### 6개 프리셋 (자동 세그먼트)
| 프리셋 | 대상 자동 계산 | 권장 메시지 |
|---|---|---|
| 🎉 웰컴 | 가입 7일 이내 | 환영 + 첫 챕터 추천 |
| ⏰ 갱신 알림 | 활성 구독 D-7 이내 | "곧 만료됩니다 — 갱신하세요" |
| 🌟 윈백 | 만료 후 미결제 | "오랜만 — 할인 코드 드려요" |
| 💎 전환 유도 | 가입했지만 결제 0 | "무료 챕터 먼저 체험" |
| 👑 VIP 감사 | 누적 5만원+ | 특별 혜택 |
| ✍️ 커스텀 | 직접 체크박스 선택한 사용자 | 자유 메시지 |

### Pabbly 페이로드 구조
```json
{
  "template": "renewal",
  "channel": "sms",          // 'sms' | 'email' | 'both'
  "subject": "멤버십 만료 7일 전 안내",
  "sent_at": "2026-05-30T...",
  "sent_by": "관리자 이름",
  "name": "홍길동",
  "phone": "01012345678",
  "email": "hong@example.com",
  "point": 4500,
  "first_paid_at": "2026-04-01T...",
  "referral_code": "ABC12",
  "custom_message": "사용자가 CRM에서 입력한 메시지",
  "chapter_access": [
    { "chapter_id": 1, "chapter_title": "...", "expires_at": "..." }
  ]
}
```

### Worker 응답 (results 배열)
```json
{
  "ok": true,
  "campaign_id": "uuid-...",       // 같은 발송의 모든 수신자가 공유
  "sent_at": "2026-06-03T...",
  "sent": 2,
  "total": 2,
  "results": [
    { "phone": "01012345678", "email": "hong@example.com", "name": "홍길동", "channel": "both", "ok": true, "status": 200 },
    { "phone": "01087654321", "email": "",                  "name": "이순신", "channel": "sms",  "ok": true, "status": 200 }
  ]
}
```
CRM 결과 테이블이 `channel` 값에 따라 phone/email 컬럼 표시 분기.

### 영구 저장 (분석용)

발송이 끝나면 Worker가 결과를 **`OnepageCampaignSends`** Airtable에 수신자 1명당 1행씩 batch 저장 (10개씩 묶음, typecast=true).
- 같은 발송의 모든 행은 동일한 `campaign_id` 공유 → 분석 쿼리에서 GROUP BY 가능
- 테이블이 없거나 쓰기 실패하면 console.warn 만 찍고 **발송 자체는 성공으로 응답** (저장 실패가 발송을 막지 않음)

### 분석 (`GET /admin/campaign-sends?days=30`)

CRM 캠페인 탭 하단의 **📊 캠페인 분석** 패널이 호출:
- KPI: 총 발송, 캠페인 수, 성공률, 기간
- 템플릿별·채널별 발송량 표
- 일별 발송량 막대그래프 (1~365일)
- 최근 100건 캠페인 리스트 (시간·템플릿·채널·대상수·성공률·관리자)
- **📥 CSV** 버튼으로 수신자 단위 raw export (BOM 포함 UTF-8 — Excel 한글 호환)

### 전환 분석 (`GET /admin/campaign-conversion?days=30&window=7`)

CRM 캠페인 탭 하단 **💰 전환 분석** 패널이 호출. 캐페인 발송 → 결제로 이어진 비율과 매출을 측정.

#### 알고리즘
- 발송 성공(`ok=true`) 건만 대상
- 각 발송에 대해 같은 `phone` 의 `OnepagePayments.paid_at` 이 `sent_at < paid_at <= sent_at + windowDays` 범위에 있으면 **전환** 으로 카운트
- 매출은 윈도우 안에 발생한 결제 `amount` 합계

#### 응답 구조
```json
{
  "ok": true,
  "days": 30, "window_days": 7,
  "total_sends": 120, "total_conversions": 18,
  "conversion_rate": 15.0, "total_revenue": 54000,
  "arpc": 3000,                          // 매출 / 전환수 (1인당 평균 객단가)
  "by_template": { "renewal": { "sends": 40, "conv": 8, "revenue": 24000 }, ... },
  "by_channel":  { "sms":     { "sends": 80, "conv": 12, "revenue": 36000 }, ... }
}
```

#### 윈도우 선택 (CRM UI)
1일 / 3일 / **7일(기본)** / 14일 / 30일 → 어떤 윈도우가 본 사업 모델에 적합한지는 데이터 누적 후 비교 권장.

#### 알려진 한계 (속편의 전환 추적 정밀화 필요 시 보강)
- **다중 노출 중복 카운트**: 한 사용자가 한 윈도우 안에 여러 캐페인을 받고 결제 1번 → 모든 캐페인에 전환 1번씩 잡힘 (다중 어트리뷰션이 필요하면 first-touch / last-touch 정책 도입)
- **자연 발생 결제 구분 X**: 캐페인 없어도 결제했을 사용자도 전환으로 잡힘 → A/B 컨트롤 그룹 도입 시 정밀 측정 가능
- **결제 채널이 캐페인 채널 아닐 수 있음**: 이메일 받고 다른 경로로 결제해도 채널별 ROI에 포함됨

### 설정 (Worker 환경 변수)
```bash
# 캐페인 발송용 (ChatGPT 라우팅 포함)
wrangler secret put PABBLY_WEBHOOK_URL

# 비밀번호 재설정 SMS 발송용 (ChatGPT 없는 별도 워크플로우 권장)
wrangler secret put PABBLY_RESET_WEBHOOK_URL
```

PABBLY_RESET_WEBHOOK_URL 이 설정돼 있으면 비밀번호 찾기 SMS 발송에 우선 사용. 미설정 시 PABBLY_WEBHOOK_URL 로 폴백. 자세한 내용은 §내 계정 모달 → 비밀번호 찾기 참조.

### Pabbly 측 별도 자격증명 (워크플로우 안에서 보관)
- **ChatGPT**: OpenAI API Key (Pabbly Connection으로 보관)
- **SOLAPI (Private)**: Solapi API Key + Secret + 등록 발신번호 (https://console.solapi.com/senderids)
- **Gmail**: Google OAuth로 발신 계정 연결 (Gmail API 일일 100건 제한)

### 알려진 제약
- Gmail API: **일일 100건 제한** — 대량 발송 시 SendGrid/Mailgun 등으로 갈아탈 것
- SOLAPI: 발신번호 사전 등록 필수, 미등록 번호로 보내면 `4030` 에러
- ChatGPT 응답이 90바이트(SMS 한도)를 넘으면 SOLAPI가 자동 LMS로 전환 (단가 ↑)
- v1 옛 AgenticAI 라우터는 **deprecated** — 현재 워크플로우는 `connect.pabbly.com` (Connect)에서 운영

---

## 19. KST 시간 처리

모든 시간은 **KST(한국 표준시)** 기준.

### 서버 (Worker)
- `kstNow()` = `new Date(Date.now() + 9시간)` — KST wall-clock을 UTC 표기로 변환
- `kstISOString()` → `"2026-05-30T12:00:00.000Z"` 같은 형식 (Z 표기는 거짓, 실제 KST 시각)
- `kstDateTime()` → `"2026-05-30 12:00:00"` (MySQL DATETIME 호환)
- `addDays(iso, n)` → UTC 가산 (KST-as-UTC 프레임 안에서)

### 클라이언트 (학생 앱·CRM)
- `daysLeft(iso)` — `Date.now() + 9시간`으로 보정한 후 비교 → D-N 정확
- `fmtKst(iso)` — KST-as-UTC ISO에서 9시간 빼고 Asia/Seoul 표기로 출력
- `fmtKstDate(iso)` — 날짜만 (시·분 생략)

### 표시 예시
- 챕터 카드: `D-30` (활성 일수)
- 챕터 상세 헤더: `남은 기간 30일 (만료: 2026.06.29 KST)`
- 결제 모달: `현재 D-12일 (만료: ... KST). 결제하면 만료일이 30일 더 연장됩니다.`
- CRM 사용자 모달: 모든 시각이 ko-KR + Asia/Seoul 표기

---

## 20. 데이터 모델

### Airtable (사람·돈·캐페인·결제 폴백)
- **OnepageUsers**: name, phone, email, password_hash, role, referral_code, referred_by_code, point, first_paid_at, **interests** (콤마 구분 과목 배열 — 가입 시 URL `?interest=` 캡쳐 또는 학생 앱 모달에서 편집), **utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_url, referrer_url** (UTM 7개 — 가입 시 한 번만 기록), **reset_code, reset_code_expires_at** (비밀번호 찾기 SMS 6자리 코드 + KST 만료시각 — 사용 후 자동 클리어)
- **OnepageChapterAccess**: user_phone, chapter_id, chapter_title, expires_at, last_payment_id, source — Worker(`/payapp/webhook` 또는 `/admin/access/grant`) + C1 Automation이 갱신
- **OnepagePayments**: mul_no, user_phone, user_email, chapter_id, chapter_title, amount, paid_at, raw, status — **Worker `/payapp/webhook`이 직접 채움** (v2부터)
- **OnepagePointTx**: user_phone, delta, reason, balance_after, memo (감사 로그 + 관리자 지급 시 `[관리자:이름]` 접두)
- **OnepageCampaigns**: name, utm_source, utm_medium, utm_campaign, utm_content, utm_term, notes, created_by_name, created_by_phone (CRM QR 생성기의 영구 라이브러리)
- **OnepageCampaignSends**: campaign_id, template, channel, subject, custom_message, sent_at, sent_by, phone, email, recipient_name, ok (Checkbox), status_code (Number), error — **수신자 1명당 1행** 영구 저장. 분석 탭에서 일자·템플릿·채널별 발송량/성공률·전체 캠페인 히스토리 산출에 사용
- **UnknownPayments**: mul_no, goodname, phone, email, amount, raw, received_at (Created time auto), notes, resolved — Pabbly 라우터의 폴백 (상품 매핑 실패 시)
- **FailedPayments**: mul_no, goodname, phone, email, amount, raw, error_message, retry_count, created_at (Created time auto), resolved — Pabbly 라우터의 안전망 (Airtable 쓰기 실패 시)

### nocodebackend (콘텐츠)
- **op_chapters**: id, subject, title, sort_order, icon, description, monthly_price, is_all_free, **is_published** (0=비공개/draft — 학생 숨김), **pay_url** (페이앱 결제 링크)
- **op_topics**: id, chapter_id, title, sort_order, is_free
- **op_subtopics**: id, topic_id, title, sort_order, image_b64, caption
- **op_items**: id, subtopic_id, kind (`text`/`image`/`link`), text, image_b64, caption, sort_order
  - `kind='link'`: `text` 컬럼에 URL 저장, `caption` 에 제목/설명
  - `kind='text'`: `caption` 으로 이미지처럼 작은 설명 표시 (선택)
- **op_understood**: user_phone, subtopic_id, marked_at, **review_box** (Leitner 1~6), **next_review_at** (다음 due KST) — 꾹누르기 진도 + 간격 반복(SRS) 스케줄
- **op_pings**: user_phone, first_ping_today, last_ping_at (라이브 카운트)

자세한 컬럼·타입·FK 설정은 [ONEPAGE_SCHEMA.md](ONEPAGE_SCHEMA.md) 참조.

---

## 21. Worker 엔드포인트

### 공개 / 학생용
| 경로 | 메서드 | 동작 |
|---|---|---|
| `/auth/signup` | POST | 회원가입 (+ utm 필드 7개 + interests 자동 저장) |
| `/auth/login` | POST | 로그인 → JWT 토큰 |
| `/auth/me` | GET | 내 정보 + 챕터 접근 맵 + interests 배열 |
| `/auth/me/interests` | PUT | 관심 주제 편집 — `{interests: [...]}` 콤마 join하여 Airtable 갱신 |
| `/auth/change-password` | POST | 비밀번호 변경 — `{old_password, new_password}`, 현재 비번 검증 후 PBKDF2 재해시 |
| `/auth/forgot-password` | POST | 비밀번호 찾기 1단계 — `{email}` → 등록 휴대폰으로 SMS 6자리 코드. enumeration 차단 위해 미존재 시에도 200. 응답 `{ok, sent, phone_masked}` |
| `/auth/reset-password` | POST | 비밀번호 찾기 2단계 — `{email, code, new_password}` → 코드+만료 검증 후 password_hash 갱신, reset_code 클리어 |
| `/referral/info?code=` | GET | 추천 코드 유효성 (이름 마스킹) |
| `/chapters` | GET | 챕터 목록 |
| `/topics?chapter_id=` | GET | 목차 목록 + 동봉 subtopics |
| `/subtopics?topic_id=` | GET | 학습 카드 목록 |
| `/items?subtopic_id=` | GET | 내용 블록 (구독 게이트 적용) |
| `/understood` | POST | 꾹누르기 토글 — 첫 ● 시 review_box=1, next_review_at=내일 자동 세팅 |
| `/understood/advance` | POST | 회상 성공(다지기 안 펼치고 패스) → Box +1, next_review_at 갱신 (Leitner 1·2·4·8·16·32일) |
| `/understood?chapter_id=` | GET | 내 ● 등록 목록 + review_box + next_review_at |
| `/stats/ping` | POST | 60초마다 학생이 호출 |
| `/stats/learners-now` | GET | 오늘 학습자 수 |
| `/access` | GET | 내 챕터별 접근 상태 |
| `/access/redeem` | POST | `REDEEM_COST` P → 챕터 30일 연장 |
| **`/payment/request`** | **POST** | **학생: 챕터 결제 세션 생성 → PayApp payurl 반환 (var1=chapter_id)** |
| **`/payapp/webhook`** | **POST** | **PayApp: 결제 완료 알림 수신 → OnepagePayments INSERT → `SUCCESS` 응답** |

### 선생님용 (teacher gate)
| 경로 | 메서드 | 동작 |
|---|---|---|
| `/chapters` | POST | 챕터 생성 (pay_url 포함) |
| `/chapters/:id` | PUT/DELETE | 챕터 수정/삭제 |
| `/chapters/:id/bulk` | POST | TSV 일괄 입력 (청크 처리) |
| `/topics`·`/topics/:id` | POST/PUT/DELETE | 목차 CRUD |
| `/topics/reorder` | POST | 목차 순서 일괄 변경 — `{ordered_ids[], start_index}` |
| `/subtopics`·`/subtopics/:id` | POST/PUT/DELETE | 학습 카드 CRUD |
| `/subtopics/reorder` | POST | 학습 카드 순서 일괄 변경 |
| `/items`·`/items/:id` | POST/PUT/DELETE | 내용 블록 CRUD |
| `/items/reorder` | POST | 내용 순서 일괄 변경 |

### 관리자 CRM용 (teacher gate, `/admin/*` 네임스페이스)
| 경로 | 메서드 | 동작 |
|---|---|---|
| `/admin/overview` | GET | 대시보드 KPI + 만료임박/최근결제/챕터TOP |
| `/admin/users` | GET | 전체 사용자 + 구독·결제·포인트·최근 학습 집계 |
| `/admin/user/:phone` | GET | 개별 사용자 전체 이력 (UTM 포함) |
| **`/admin/user/:phone`** | **DELETE** | **회원 완전 삭제 — Airtable 5테이블 + nocodebackend 2테이블 일괄 정리. teacher 계정 403, 총 행 30건 초과 시 413** |
| `/admin/points` | POST | 포인트 지급/차감 (자동 PointTx 기록) |
| `/admin/webhook/send` | POST | Pabbly 웹훅 일괄 발송 + OnepageCampaignSends에 수신자별 결과 영구 저장 |
| `/admin/campaign-sends?days=30` | GET | 캠페인 분석 — 일자/템플릿/채널별 발송량·성공률, 캠페인 히스토리 (campaign_id로 그룹) |
| `/admin/campaign-conversion?days=30&window=7` | GET | 전환 분석 — 발송 후 `window`일 안에 결제한 수신자 집계. 템플릿별/채널별 발송수·전환수·전환율·매출·ARPC |
| `/admin/revenue?days=30` | GET | 일별/챕터별/사용자별 매출 |
| `/admin/content-stats` | GET | 챕터별 구독자 · MRR |
| `/admin/attribution?days=90` | GET | UTM 어트리뷰션 (소스/매체/캐페인별 성과) |
| `/admin/campaigns` | GET | 저장된 캐페인 라이브러리 |
| `/admin/campaigns` | POST | 새 캐페인 저장 (이름·UTM·메모·작성자) |
| `/admin/campaigns/:id` | PUT/DELETE | 캐페인 수정/삭제 |
| **`/admin/access/grant`** | **POST** | **챕터 권한 수동 지급/연장** (활성이면 누적, 만료/신규면 NOW+N일) |
| **`/admin/access/:phone/:chapter_id`** | **DELETE** | **챕터 권한 회수** (ChapterAccess 행 삭제) |

### 구독 게이트 (`/items` 응답)
- 무료 목차 (is_free=1) → 누구나 200
- 비구독자 → 402 + `{error: 'subscription_required', chapter_id}`
- 비로그인 → 401
- 선생님 (role=teacher) → 항상 통과

### Airtable 페이지네이션 (`atFindAllPaged`)
- CRM 집계 시 사용자·결제·접근권이 100건 초과해도 처리
- `pageSize=100` + `offset`으로 반복 fetch (최대 50 페이지 / 2000건)

---

## 22. Cloudflare Workers 청크 처리

### 서브요청 한도
Cloudflare Workers는 invocation당 서브요청 제한 (Free 50, Paid 1000).

대량 일괄 입력 시 항목당 1 nocodebackend fetch → 한도 즉시 초과.

### 청크 반복 호출 패턴
**Worker** (`POST /chapters/:id/bulk`):
- 매 호출에 최대 ~40 subrequest 안에서 처리
- 응답: `{next_start, done, topic_map, sub_map, base_sort, t_added, s_added, i_added, total}`

**클라이언트** (선생님 앱):
- done=true 될 때까지 반복 호출
- 호출 사이에 topic_map·sub_map·base_sort·start를 다음 호출로 전달
- 토스트로 진행도 표시 ("진행 중… 245/1000 (24%)")

```js
while (true) {
  const r = await api('POST', `/chapters/${id}/bulk`, {
    tsv, mode, start, topic_map, sub_map, base_sort
  });
  start = r.next_start;
  topic_map = r.topic_map; sub_map = r.sub_map;
  if (r.done) break;
}
```

---

## 운영 노트

### 선생님 계정 만드는 법
1. 일반 학생처럼 회원가입
2. Airtable `OnepageUsers`에서 그 행 찾기
3. `role` 컬럼을 `student` → **`teacher`**로 수동 변경
4. 그 계정으로 다시 로그인 → 선생님 앱 사용 가능

### 콘텐츠 대규모 수정 시
- 학생이 보고 있는 중에 콘텐츠 삭제하면 stale 캐시 → 학생이 클릭 시 404
- 학생 앱이 404·500 감지하면 자동 `refreshChapter()` 호출 → 우아하게 회복
- 큰 변경 작업 전 학생에게 "새로고침 부탁드립니다" 공지 권장

### 가격 변경
- `op_chapters.monthly_price` 컬럼만 수정
- 다음 결제부터 적용 (기존 활성 회원의 expires_at은 영향 X)

### 마케팅·홍보 자료
- [`marketing/scripts.md`](marketing/scripts.md) — Vrew + Filmora 15 워크플로용 마스터 영상 스크립트 5편 (후크 / 앱 소개 / 풀튜토리얼 / 패스 USP / CTA)
  - 각 편 = Vrew 붙여넣기용 음성 텍스트(코드블록) + 화면 매칭 표 분리. ⚠️ Vrew 가 모든 텍스트를 음성으로 읽으니 `[브래킷]` 힌트는 본문에서 빼고 별도 표로 정리
  - 화자는 한국어 여성 차분한 톤으로 통일 (브랜드 일관성)
  - guide-media/*.mp4 의 7편 영상을 B-roll로 재활용
  - 편당 30~90분 작업, 5편 총 4시간 → 한 달 분량 15~20편으로 확장
