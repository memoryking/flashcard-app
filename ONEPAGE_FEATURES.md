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
22.5. [Cloudflare Edge Cache — /chapters 가속](#225-cloudflare-edge-cache--chapters-가속-v237)
22.7. [랜딩 페이지 제작 워크플로](#227-랜딩-페이지-제작-워크플로-v238)
22.8. [수학 콘텐츠 제작 워크플로](#228-수학-콘텐츠-제작-워크플로-v239)
22.9. [단어풀 참조 — 영단어·한자 콘텐츠](#229-단어풀-참조--영단어한자-콘텐츠-v240)
23. [v2 학습 시스템 (단일 카드 + 퀴즈)](#23-v2-학습-시스템-단일-카드--퀴즈)
&nbsp;&nbsp;&nbsp;&nbsp;23.16. [학습 카드 본문 라이트박스](#2316-학습-카드-본문-라이트박스--이미지svg-풀스크린-확대-v239)

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
│  학생:   https://memoryking.kr                                │   ← Vercel (커스텀 도메인)
│          + https://onepage-study.vercel.app (백업)            │
│  선생님: github.io/flashcard-app/onepage-teacher.html         │   ← GitHub Pages
│  CRM:    onepage-crm-*.vercel.app                             │   ← Vercel (teacher 전용)
│  랜딩:   vipup.site/onepage-study (아임웹 페이지에 iframe)      │
│          ↳ iframe src = github.io/flashcard-app/onepage-landing.html
└─────────────────────────┬────────────────────────────────────┘

> ### ⚠️ 배포 표면이 둘이고, 서빙 범위가 다르다
> | 표면 | 서빙 범위 | 뜻 |
> |---|---|---|
> | **Vercel** (학생앱) | 프로젝트 **Root Directory = `onepage-user/`** | 저장소 루트의 **다른 폴더는 배포되지 않는다** |
> | **GitHub Pages** (선생님앱·랜딩) | **저장소 루트 전체** | 루트에 둔 파일은 **전부 공개 URL이 생긴다** |
>
> - Vercel 쪽 보호막은 **대시보드 설정(Root Directory)** 이라 저장소에 안 보인다. 바꾸면 루트가 통째로 노출되니 건드리지 말 것.
> - Pages 쪽은 필터가 **없다.** 그래서 참고용 옛 버전은 **`flashcard/` 폴더에 격리**한다 → [flashcard/README.md](flashcard/README.md)
> - 특히 **루트에 `sw.js`를 두면 안 된다.** scope가 `/flashcard-app/` 가 되어
>   **선생님앱·학생앱 요청까지 가로채고 캐시**한다 ("배포했는데 옛날 게 나온다"의 원인).

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

> **영단어·한자는 내용 블록을 저장하지 않는다** — `@@WORD:단어@@` 참조만 두고 워커가 단어풀에서 조합.
> → [§ 22.9 단어풀 참조](#229-단어풀-참조--영단어한자-콘텐츠-v240) · [WORD_POOL.md](WORD_POOL.md)

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

### 학생 앱 동작 (v2.2/v2.3.2 — 필터 모드)
- 우상단 **👤 계정** 모달 → **🎯 관심 주제 → 편집** 모달에서 체크박스로 선택
- interests 비어있지 **않으면 체크한 주제의 챕터만** 홈에 표시. 비우면 전체 노출.
- 모달 하단 **"전체 보기 (모두 해제)"** 버튼 — 한 번에 비우기
- 옛 ON/OFF 토글 + `INTEREST_FILTER_KEY` localStorage 제거 (단일 멘탈 모델: "관심 주제 = 보고 싶은 목록")
- v2.3 잠시 우선순위(숨기지 않고 뒤로)로 바꿨다가 v2.3.2에 다시 필터로 복귀 (사용자 선호)

### CRM QR 생성기 — 관심 주제 자동 추가
- 어트리뷰션 탭의 QR 빌더에 **챕터 DB 기반 자동 체크박스** 그리드
- `state.chapters`에서 distinct subject 추출 → 체크하면 `?interest=A&interest=B` 자동 부착
- **"모두 해제"** 버튼으로 한 번에 비우기
- 저장된 캐페인엔 interests 별도 보존 안 함 (불러올 때 사용자가 다시 체크)

### 챕터 순서 — 드래그로 직접 정하기 (v2.3)
- v2.2까지 자동 우선순위 정렬 (구독 활성 > 진행 있음 > 만료 > 그 외) — **제거됨**
- **꾹누름 200ms + 드래그**로 사용자가 직접 챕터 순서 정함 (Sortable.js CDN)
  · `forceFallback: true` — `.chapter-card`의 `touch-action: manipulation` CSS 간섭 우회
  · 빠른 클릭은 `enterChapter` 정상 동작 (drag 시작 임계 < 200ms이면 cancel)
- 과목 그룹 안에서만 드래그 가능 (그룹 사이 이동 X — 챕터의 subject는 불변)
- **서버 동기화** (v2.3.1): `Airtable.OnepageUsers.chapter_order` (JSON 문자열)
  · 진실의 출처: 서버. `/auth/me` 응답으로 로드 → `state.chapterOrder`
  · 변경 시: 디바운스 0.8초 → `PUT /auth/me/chapter_order` 자동 호출
  · `localStorage.op_chapter_order_v1_{phone}` 는 오프라인/실패 시 백업 + 1회 마이그레이션
  · 다중 기기에서도 동일 순서 (서버에서 동기화)
- 과목 그룹 순서: 알파벳 정렬 (관심 필터 ON 시 보이는 것만 알파벳)
- 새로 추가된 챕터 → 저장 목록 끝에 자동 추가 (chapter.sort_order 기준)
- 챕터 삭제되면 저장 목록에 dead ID 남지만 렌더에서 자동 무시 (해 없음)

### URL 파라미터 자동 캡쳐 (마케팅용)
```
https://memoryking.kr/?interest=수능,토익
https://memoryking.kr/?interest=수능&interest=한자
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

### 학습 동작 — 탭 + 본문 하단 버튼 2개 (v2.3.5)

| 동작 | 트리거 | 결과 | 저장 |
|---|---|---|---|
| **펼치기/접기** | 학습 카드 짧게 탭 | 내용 표시 (아코디언). 챕터 내 `everExpandedSet`에 기록됨 | — |
| **오늘 학습** | 본문 하단 빨강 버튼 | 다지기 오늘 박스 즉시 등장. ★ +1 | DB (`op_understood` box=1) |
| **내일 학습** | 본문 하단 보라 버튼 | 다지기 내일 박스로. ★ 안 늘림 | DB (`op_understood` box=2) |

→ 꾹누르기(0.6초 long-press)와 ⤴ 패스 버튼은 v2.3.5에서 모두 제거. 본문 하단 두 버튼이 명시적으로 분류 처리. 단순/직관성 강화.

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
- 오늘/내일 학습 / 펼침 모두 이 함수로 감싸짐

→ 패스 버튼 위치가 항상 같은 자리에 있어 연속 탭 가능

### 학습 카드 펼침도 동일
`subClick` 함수도 같은 패턴으로 펼침 시 위치 보정.

### 오늘/내일 학습 — 각인 애니메이션 + 스크롤 앵커 (일반 new 모드)

`studyDayPick`(오늘/내일 학습 버튼)의 마무리 연출·정리 흐름. **"스크롤이 학습을 방해한다"** 는 피드백을 반영해, 부드러운 스크롤 없이 학습 카드만 빠지게 한다.

1. **각인 오버레이** (`playMemorizeEffect`): 학습 카드의 **단어**(없으면 이미지)를 화면 밖 `fixed` overlay(`.memorize-fx`)로 **중앙 전면에 크게(1.7배)+보랏빛 발광** → 한 점으로 줄며 위로 빨려 저장. 약 1.2초. "각인 후 저장" = 마지막 강한 노출로 기억 강화. (카드 레이아웃과 분리돼 위치·크기 제약 없음)
2. **카드 페이드**: 카드 자체는 `.srs-memorize`로 0.3초 발광·페이드(레이아웃 접힘 없음 → 드리프트 없음). 약 300ms 뒤 재렌더 — **각인 오버레이가 덮는 동안** 정리돼 각인이 사라지면 감쪽같이 반영.
3. **스크롤 앵커** (`pickScrollAnchor`): 재렌더 전 **화면 상단(헤더 아래)에 보이는 첫 카드(학습 카드 제외)** 의 화면 Y를 기록 → 재렌더 후 같은 위치로 즉시(`scrollBy`, 애니메이션 없음) 보정. 표준 스크롤 앵커링이라 **뷰가 위/아래로 안 튐**:
   - 학습 카드가 앵커보다 **아래** → 위는 그대로, 아래가 올라와 붙음
   - 학습 카드가 앵커보다 **위** → 아래 리스트 고정, 위가 내려와 붙음
4. **Fallback (목차 마지막 단어)**: 학습 카드가 상단의 **유일한 단어**(아래엔 목차 헤더뿐)면 앵커가 없어 목차가 위로 올라옴 → 대신 다음 학습 대상(`.subtopic.current`, 없으면 첫 단어)을 **헤더 바로 아래로 즉시 이동**해 남은 단어들이 보이게 정리.

> `passed` 카드는 일반 모드 렌더에서 필터로 제외되므로(빠짐), 위 앵커/보정만으로 "학습한 단어만 쏙 빠지고 나머지는 제자리" 가 성립한다.

### 집중 학습 세션 — 골라서 한 장씩 (일반 new 모드)

**문제**: 리스트에서 아무 단어나 클릭 → 펼쳐 보고 → 오늘/내일 선택 → 다시 리스트에서 또 고른다.
매번 "뭘 볼지" 고르는 결정이 끼어들어 **집중이 끊긴다.**

**해결**: 먼저 **고르고**, 그 다음엔 **고르는 일 없이 한 장씩** 끝까지 간다.

| 단계 | 동작 |
|---|---|
| ① 선택 | 각 단어 왼쪽 **체크박스**(`.pick-box`) — new 탭의 **미학습 카드**에만 노출 |
| ② 자동선택 | 상단 `☑ 자동선택 [10]개` — **위에서부터** N개 자동 체크. 개수는 `localStorage`(`op_autopick_n`)에 저장 |
| ③ 학습하기 | `▶ 학습하기 (N)` → 리스트가 사라지고 **전체화면 세션**(`.ses-overlay`) 진입 |
| ④ 진행 | 상단에 `📚 오늘 N ← 남은 N/전체 + 진행바 → 📅 내일 N` |
| ⑤ 판정 | 오늘 → 카드가 **왼쪽**으로, 내일 → **오른쪽**으로 회전하며 날아감 + 해당 카운터 **bump** → 다음 카드 **slide-in** (자동) |
| ⑥ 완료 | 🎉 요약 → 리스트 복귀. 학습분은 `understoodSet`에 들어가 **new 탭에서 자동 소멸** |

**설계상 중요한 점**

- **로직 이중화 금지**: 오늘/내일의 상태 갱신·서버 동기화를 **`applyDayPick(sid, box)`** 로 분리해
  리스트(`studyDayPick`)와 세션(`sessionPick`)이 **같은 코드**를 쓴다. SRS 박스·due·miss·통계·
  `/understood` 동기화가 두 경로에서 갈라지지 않는다. (`studyDayPick` = 각인FX + `applyDayPick` + 트리 재렌더)
- 세션은 트리를 **재렌더하지 않는다** → 위 스크롤 앵커 로직이 불필요(오버레이라 리스트가 안 보임).
- **프리페치**: 선택 즉시 + 세션 진행 중 다음 2장을 `ensureItems(sid, true)` → 넘길 때 로딩 없음.
- **능동 회상 설정을 그대로 따름**: ON이면 본문 블러 + `정답 보기`.
- 중도 종료(✕/ESC)해도 **학습한 것만 빠지고 남은 선택은 유지** → 이어서 `학습하기` 가능.

**충돌 주의 (실제로 밟은 지뢰)**

- `.subtopic-head > *` 에 `pointer-events:none` 이 걸려 있다 → 체크박스는 `pointer-events:auto !important` 필요.
- **ESC 중복**: 이미지 라이트박스가 열린 채 ESC → 라이트박스와 세션이 **둘 다** 닫혔다.
  → `sessionKey`가 `.content-lightbox.open` 이면 ESC를 양보한다.
- **스크롤 잠금 소유권**: `closeContentLightbox`가 `body.overflow=''` 로 되돌려 세션 중 배경 잠금이 풀렸다.
  → 세션이 떠 있으면 `'hidden'` 유지.
- z-index **3000** — 모달(1000) 위, 토스트·라이트박스(9999+) 아래.

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

### 콘텐츠 블록 (op_items) 종류 5가지

| `kind` | 저장 필드 | 학생 앱 렌더링 |
|---|---|---|
| `text` (기본) | `text` (+ 선택 `caption`) | 본문 + 본문 안의 URL 자동 링크화 + 선택적 작은 설명 캡션 |
| `image` | `image_b64` (data URL) + 선택 `caption` | 이미지 + 캡션 (터치 시 라이트박스 §23.16) |
| `link` | `text` = URL (+ 선택 `caption` = 제목/설명) | URL 종류 따라 분기 (아래) |
| **`html`** | `text` = HTML 마크업 | DOMPurify sanitize 후 그대로 렌더 + MathJax 자동 적용 (수학 콘텐츠 §22.8) |
| **`svg`** | `text` = `<svg>...</svg>` 인라인 | DOMPurify sanitize 후 그대로 삽입 (matplotlib 글리프 친화) |

**`html`/`svg` 업로드 — 두 가지 방식**:

| 진입점 | 동작 | 용도 |
|---|---|---|
| 학습 카드 펼침 → **+ 📄 HTML/SVG** | 단일 파일 → 단일 item으로 추가 | 기존 카드에 콘텐츠 보충 |
| 목차 펼침 → **+ 📄 HTML 일괄 추가** | 파일 여러 개 → **각각 학습 카드 1장**으로 자동 생성. 파일 안 마커가 있으면 두 item으로 자동 분리 | 수학 문제 폴더(§22.8) 일괄 등록 |

**일괄 업로드 시 마커 기반 자동 분리**:
- 파일 안 `<!-- 암기카드 -->` 와 `<!-- 내용 -->` 두 주석 마커 인식
- 두 마커 사이 → 1번째 item (`caption='암기카드'`) — **순수 문제 발문/보기만** (제목·주제·풀이 정보 일체 없음)
- `<!-- 내용 -->` 이후 → 2번째 item (`caption='내용'`) — **제목 → 주제 → 출제 의도/함정/풀이/그래프/한 줄 정리/변형 연습** 전부
- 마커 없으면 단일 item으로 저장 (호환성)
- 학생 앱은 두 item을 순차 표시 — 다지기 모드의 본문 블러(§23.2)가 풀이를 자연스럽게 가림

> **암기카드에 제목·주제를 두지 않는 이유**: "미분계수의 정의 — 기본형" 같은 제목/주제는 풀이 방향을 미리 알려준다. 학생이 카드 앞면에선 **순수 문제만** 보고, 터치하면 **제목·주제와 함께 풀이가 한꺼번에 공개**되는 것이 자연스러운 학습 흐름. 자세한 작성 규칙은 `11_math/수학문제_제작_가이드.md` §20.

**공통 처리**:
- 파일명·확장자로 자동 kind 판정 (`<svg`로 시작/`.svg` 확장자 → `kind='svg'`)
- SVG는 업로드 직전 **client-side minify** — XML 헤더·주석·공백 제거 (30~60% 절감)
- 500KB 초과 시 [SVGOMG](https://jakearchibald.github.io/svgomg/) 안내 토스트 + 413 응답에도 같은 안내
- 학생 카드 제목은 파일명에서 자동 추출 (`01_절댓값삼차함수_합본.html` → `01 절댓값삼차함수`)

**학생 앱 sanitize 허용 태그 매트릭스** (matplotlib 친화):
- 모든 SVG 셰이프/텍스트 (`g/path/circle/.../text/tspan/use`)
- 그라데이션/필터/마스크 (`linearGradient/feGaussianBlur/mask` ...)
- MathML (`math/mrow/msup/mfrac` ...)
- `href` / `xlink:href` URI-safe (matplotlib 글리프 `<use href="#m1234">` 필수)
- LaTeX(`$...$`, `\(...\)`, `\[...\]`) 발견 시 **MathJax 3 lazy-load** → MutationObserver가 새 카드도 자동 typeset

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
| 펼침 분리 | `event.stopPropagation()` 을 click에 |

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
- 콘텐츠 삭제 시: `op_understood.subtopic_id` FK CASCADE → 모든 사용자의 그 학습 카드 학습 진도 자동 정리
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
| **✨ merge** | 동일 이름 목차·학습 카드 그대로 두고 **items만 전부 교체** — 콘텐츠 업데이트용 | ✅ **완벽 보존** (subtopic_id 유지, 학습 진도 그대로) |
| ⚠️ **replace** | 챕터의 모든 목차 삭제 후 신규 입력 | ❌ FK CASCADE로 모든 학습 진도 기록 삭제됨 |

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

### 세 종류 이미지
| 용도 | 위치 | 표시 |
|---|---|---|
| **대표 이미지(커버)** | `op_subtopics.image_b64` | 항상 보임 (펼치지 않아도) |
| **내용 이미지** | `op_items.kind='image'` | 펼침 시 본문 안에 |
| **단어 자동 이미지** | `word-images.json` (DB 아님) | 펼침 시 본문 **맨 끝** (커버 없을 때만) |

### 단어 자동 이미지 (word-images.json) — 영단어 등 대량 이미지

**문제**: 영단어 1000개 카드마다 이미지를 넣고 싶은데, base64를 DB에 1000행 넣으면 무거움 + 선생님이 1000번 수작업.

**해법**: 파일명을 단어로 맞춘 이미지를 외부 호스트(sharemyimage)에 일괄 업로드하고, `단어→주소` 매핑표(JSON 파일 1개)만 앱에 둠. **DB 저장 0, 선생님 작업 0.**

```
[PC 폴더 dog.png …]  ──①── scripts/upload-word-images.js ──②── sharemyimage(이미지 호스팅)
                                        │
                                  ③ word-images.json  { "dog": "https://cloud.share.../dog.png", … }
                                        │ (onepage-user/ 에 배포)
                              ④ 학생 앱 loadWordImages() 로 1회 로드
                                        │
                       ⑤ 카드 제목(단어) → wordImageFor(s) 매칭 → 본문 맨 끝 .item-image
```

- **매칭**: 카드 제목(`op_subtopics.title`)을 `normWord()`(소문자·공백정리)로 정규화 → `WORD_IMAGES[단어]`. 업로드 스크립트의 `wordKey()`와 **동일 규칙**.
- **우선순위**: 교사 대표이미지(`image_b64`)가 있으면 그것을 쓰고, 없을 때만 단어 자동 이미지를 본문 맨 끝에 표시. (`wordImageFor()`가 이 분기 담당)
- **렌더**: `.item-image` 클래스 → 기존 라이트박스(§23.16) 확대가 자동 적용. 접히는 본문 안에 있어 **카드 접으면 같이 닫힘**.
- **업로드 스크립트** (`scripts/upload-word-images.js`):
  - sharemyimage 업로드 API. **엔드포인트 주의**: `https://sharemyimage.com/api/1/upload` (apex·끝슬래시 없음 — `www`·끝슬래시는 301 리다이렉트로 POST 본문이 사라져 "Empty upload source" 발생). 인증 `X-API-Key` 헤더, multipart `source` 파일.
  - **변경 감지**: 파일 내용 md5를 `scripts/.word-images.state.json`(git 제외)에 기록 → 새 파일·바뀐 파일만 재업로드. `--force`로 전체 강제.
  - **이어하기**: 매 건 저장, 중단돼도 재실행 시 남은 것만.
  - sharemyimage 앨범 "embed codes" 1000개 export 제한과 **무관** — 업로드 응답에서 주소를 즉시 수집하므로 개수 제한 없음.
- **완전 자동화 (감시 + 자동배포)**:
  - `--watch`: 폴더를 감시(4초 폴링)하다 이미지가 들어오면 자동 업로드. 복사 중(2.5초 내 변경) 파일은 안정된 뒤 처리.
  - `--push`: 업로드 후 `word-images.json`만 pathspec으로 `git commit` + `git push` → GitHub Pages 자동 배포.
  - 설정 파일 `scripts/.word-images.config.json`(git 제외)에 `dir`/`key` 저장 → 인자 없이 실행 가능.
  - 더블클릭 실행: `단어이미지-자동배포.bat`(루트, git 제외, **ASCII 전용** — cmd 한글 인코딩 이슈 회피, `chcp 65001`로 로그 한글 표시). 내부적으로 `node scripts/upload-word-images.js --watch --push`.
  - → **폴더에 이미지 드롭 = 업로드·매핑표 갱신·배포 자동**. 유일한 수동 작업은 이미지 파일 준비.
- **교체**: 같은 파일명으로 그림만 덮어쓰면 md5 변경 감지 → 새 주소로 갱신(🔄). 옛 이미지는 sharemyimage에 잔존(고아, 무해). 주소가 바뀌어 학생 앱 캐시 문제 없음.
- **참고**: 무료 호스트라 삭제·핫링크·속도제한 리스크 있음. 중요해지면 Cloudflare R2 등으로 전환 가능(스크립트만 교체).

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

## 15. 라이브 학습자 카운트 + 실시간 학습 통계 (사회적 증거)

마케팅 전환용 — 랜딩·메인에 "지금 함께 공부하는 사람"을 실시간 노출해 가입/학습 욕구를 자극.

### 데이터 수집 — `POST /stats/ping` (60초 하트비트)
- 학생 앱이 60초마다 호출 + **탭 숨김(visibilitychange) 시 즉시 flush**
- body `{cards}` = 직전 ping 이후 학습한 카드 **델타** (`state.studyDelta`)
  - 카드 학습 시점마다 `studyDelta++` — 첫 학습(`studyDayPick`) + 다지기 패스(`apiPass` 2곳)
  - 전송 성공 시 0으로 리셋, 실패 시 델타 복구 후 다음 ping에 재전송
- Worker가 `op_pings` upsert: `first_ping_today`·`last_ping_at`·`name`(JWT) 갱신 + `cards_today` 누적(`cards_date`가 오늘 아니면 0부터)

### 노출 ① 헤더 라이브 칩 (학생 앱)
- `GET /stats/learners-now` → `{count, total_cards, date}`
- 칩 표시: **"N명 학습 중 · 오늘 N장"** (30초마다 갱신). count=0이면 숨김

### 노출 ② 랜딩 LIVE 위젯 ([onepage-landing.html](onepage-landing.html))
- 히어로 직하 "떠 있는 카드" — **"오늘 N명 함께 공부 / 오늘 N장 함께 외움"** 숫자 카운트업(20초 갱신)
- **실시간 학습 피드**: `GET /stats/live-feed` → "🔥 김○○님이 방금 30장 학습" 회전 (이름 첫 글자만 노출, 마스킹은 Worker `maskName`)
- 시각 강조: "지금 이 순간" 배지 shimmer+glow, 상단 흐르는 그라데이션 라인, breathe 글로우
- 데이터 0이면 위젯 자동 숨김 (작은 숫자 역효과 방지)

### "오늘" 기준
- KST 자정에 자동 리셋 (다음 ping부터 `cards_date` 바뀌며 0부터 재누적, learners count도 새로 시작)
- 실시간 학습 인원 = 오늘 한 번이라도 ping 보낸 사용자 수 (학습 끝난 사람도 포함)

> ⚠️ **배포 전제**: `op_pings`에 `name`·`cards_today`·`cards_date` 컬럼이 있어야 함. 기존 인스턴스는 [NOCODEBACKEND_GUIDE.md](NOCODEBACKEND_GUIDE.md) §9.6 ALTER 먼저 → Worker 배포 순서.

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
4. **👀 전체 보기** — **9개 화면 캡쳐 격자** + **이미지 클릭 시 라이트박스 확대** (메인 / 학습 / 다지기 / 내 계정 / 포인트 사용 / 모르면 오늘로 / 결제 / 암기카드 3탭 / 친구추천)
5. **STEP 1~7** — 각 단계 = 제목 + 영상(자동 재생 무음 루프) + 짧은 설명 + 팁 박스
6. **하단 CTA** — "준비 완료! 앱으로 돌아가기 →"

### 미디어 자산 (onepage-user/guide-media/)

| 형식 | 권장 사양 | 자리 |
|---|---|---|
| MP4 (7편) | 720×1280 또는 1280×720, H.264, CRF 28, 무음, 3~6초 루프 | STEP 1~7 |
| PNG (9장) | 본인 비율 그대로 (PC·태블릿·모바일 캡쳐 자유) | 전체 보기 |
| MP3 (3편) | encourage-start/halfway/clear — 사람 녹음 격려 음성 | 다지기 모드 |

배포는 Vercel 정적 서빙 — `git push` 한 번이면 끝. CSS `aspect-ratio` 강제 없음 → 이미지 자기 비율 유지.

### 라이트박스 (이미지 확대)
- `.tour-shot img` 클릭 시 풀스크린 오버레이 (배경 0.94 어두움)
- 이벤트 위임 (`document` 레벨) — placeholder가 나중에 `<img>`로 교체돼도 자동 동작
- 닫기: 배경 클릭 / ✕ 버튼 / ESC 키 (3가지)

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

### 🖨️ 전단지 생성기 탭

단일 HTML 전단지(`flyer.doc`)를 화면에서 편집·인쇄. A4/A3, iframe 인쇄.

- **편집 모델**: `data-edit-id`(문구, 편집 패널의 입력창) + `data-image-id`(이미지 슬롯: `hero` 배너, `barcode` QR, `feat1~4img` 기능 아이콘).
- **기능 아이콘 (feat1~4img)**: 기본은 이모지(📅🎯💬📈 등, `data-edit-id`로 편집), **PNG 업로드 시 이미지로 교체**(256px PNG로 축소해 **투명 배경 유지**), `↺ 이모지`로 되돌리기. `flyerSyncFeatIconsIn()`이 업로드 여부(래스터/URL만 인정, SVG placeholder 제외)로 이모지↔이미지 전환.
- **QR**: **랜딩페이지 주소 1개**(`barcode`)만 하단에 크게. (소개영상은 이제 랜딩 페이지 영상 섹션에서 재생 → 전단지 영상 QR 제거)
- **실시간 사회적 증거**: `📊` 패널에서 CTA 위 문구(`socialproof`)에 현재 학습 수치를 **삽입/빼기 토글**(`flyerLoadStats`/`flyerClearStats`, 원문구 백업 후 복원). 자동 삽입은 안 함(작은 숫자 방지).
- **저장**: 기본틀(템플릿)·문구 세트는 서버 라이브러리, 완성본은 localStorage(A/B 테스트용).
- **기본 시안(현재)**: 메모리킹 — 네이비 로고 배지 + 2줄 헤드라인 + 가로 배너 히어로 + 기능 4카드(번호+아이콘+제목+설명) + 빨강 선물 박스 + 영어 후기 2개 + 하단 네이비 바 + (QR + 무료 강조 + 빨강 CTA).
- **주의**: 엔드포인트/CSS는 `onepage-crm/index.html`에 인라인. 편집 후 **↺ 기본값**을 눌러야 새 기본 시안이 적용됨(편집 중 화면엔 자동 반영 X).

### 인증
- 동일 `/auth/login` 사용 (학생 앱과 같은 계정)
- 로그인 후 `role !== 'teacher'`면 즉시 거부
- 모든 `/admin/*` 엔드포인트는 teacher gate 통과해야 함

---

## 17. 마케팅 어트리뷰션 + QR 생성기 (UTM)

가입자의 **유입 경로**를 자동 추적해 어떤 캐페인·디자인이 매출로 이어지는지 측정.

### URL 구조 (Google Analytics 호환 UTM)
```
https://memoryking.kr?utm_source=flyer&utm_medium=qr&utm_campaign=school-A&utm_content=design-B&interest=수능
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
1. 전단지 QR 스캔 → memoryking.kr?utm_source=...&interest=수능
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
- **op_chapters**: id, subject, title, sort_order, icon, description, monthly_price, is_all_free, **is_published** (0=비공개/draft — 학생 숨김), **pay_url** (페이앱 결제 링크), **voice_quiz_enabled** (v2 음성/첫글자 퀴즈 활성), **voice_quiz_lang** (`ko-KR`/`en-US`)
- **op_topics**: id, chapter_id, title, sort_order, is_free
- **op_subtopics**: id, topic_id, title, sort_order, image_b64, caption
- **op_items**: id, subtopic_id, kind (`text`/`image`/`link`), text, image_b64, caption, sort_order
  - `kind='link'`: `text` 컬럼에 URL 저장, `caption` 에 제목/설명
  - `kind='text'`: `caption` 으로 이미지처럼 작은 설명 표시 (선택)
  - **v2 컨벤션**: `items[0].text` = 학습 카드 정답 (제목→items[0] = 큐→정답)
- **op_understood**: user_phone, subtopic_id, marked_at, **review_box** (Leitner 1~6), **next_review_at** (다음 due KST), **miss_count** (★ 누적), **last_moved_at** (박스 안 정렬 키) — 학습 진도 + Standard SRS 스케줄
- **op_pings**: user_phone, first_ping_today, last_ping_at, **name**, **cards_today**, **cards_date** (라이브 카운트 + 실시간 학습 통계)

자세한 컬럼·타입·FK 설정은 [ONEPAGE_SCHEMA.md](ONEPAGE_SCHEMA.md) 참조.

---

## 21. Worker 엔드포인트

### 공개 / 학생용
| 경로 | 메서드 | 동작 |
|---|---|---|
| `/auth/signup` | POST | 회원가입 (+ utm 필드 7개 + interests 자동 저장) |
| `/auth/login` | POST | 로그인 → JWT 토큰 |
| `/auth/me` | GET | 내 정보 + 챕터 접근 맵 + interests 배열 + chapter_order 객체 |
| `/auth/me/interests` | PUT | 관심 주제 편집 — `{interests: [...]}` 콤마 join하여 Airtable 갱신 |
| `/auth/me/chapter_order` | PUT | 챕터 드래그 순서 동기화 — `{chapter_order: {과목: [id,...]}}` JSON stringify 후 Airtable 저장. 클라이언트가 0.8초 디바운스 후 호출 |
| `/auth/change-password` | POST | 비밀번호 변경 — `{old_password, new_password}`, 현재 비번 검증 후 PBKDF2 재해시 |
| `/auth/forgot-password` | POST | 비밀번호 찾기 1단계 — `{email}` → 등록 휴대폰으로 SMS 6자리 코드. enumeration 차단 위해 미존재 시에도 200. 응답 `{ok, sent, phone_masked}` |
| `/auth/reset-password` | POST | 비밀번호 찾기 2단계 — `{email, code, new_password}` → 코드+만료 검증 후 password_hash 갱신, reset_code 클리어 |
| `/referral/info?code=` | GET | 추천 코드 유효성 (이름 마스킹) |
| `/chapters` | GET | 챕터 목록. **Cloudflare Edge Cache 5분 TTL** — role(student/teacher) + subject 별 캐시 키, 챕터 변경 시 자동 purge. 캐시 히트 시 ~50ms (10배 빠름) |
| `/topics?chapter_id=` | GET | 목차 목록 + 동봉 subtopics |
| `/subtopics?topic_id=` | GET | 학습 카드 목록 |
| `/items?subtopic_id=` | GET | 내용 블록 (구독 게이트 적용) |
| `/understood` | POST | 카드 ● 등록 — 첫 등록 시 review_box=1, next_review_at=내일 자동 세팅 (studyDayPick에서 호출) |
| `/understood/advance` | POST | 회상 성공(다지기 안 펼치고 패스) → Box +1, next_review_at 갱신 (Leitner 1·2·4·8·16·32일) |
| `/understood?chapter_id=` | GET | 내 ● 등록 목록 + review_box + next_review_at |
| `/stats/ping` | POST | 60초마다 학생이 호출 — body `{cards}` 델타로 `cards_today` 누적 + `name` 저장 |
| `/stats/learners-now` | GET | 오늘 학습자 수(`count`) + 오늘 카드 합계(`total_cards`) |
| `/stats/live-feed` | GET | 최근 학습자 마스킹 이름 + 카드 수 + 상대시간 (랜딩·메인 실시간 위젯, 공개) |
| `/access` | GET | 내 챕터별 접근 상태 |
| `/access/redeem` | POST | `REDEEM_COST` P → 챕터 30일 연장 |
| **`/payment/request`** | **POST** | **학생: 챕터 결제 세션 생성 → PayApp payurl 반환 (var1=chapter_id)** |
| **`/payapp/webhook`** | **POST** | **PayApp: 결제 완료 알림 수신 → OnepagePayments INSERT → `SUCCESS` 응답** |

### 선생님용 (teacher gate)
| 경로 | 메서드 | 동작 |
|---|---|---|
| `/chapters` | POST | 챕터 생성 (pay_url 포함). **Edge Cache 자동 purge** |
| `/chapters/:id` | PUT/DELETE | 챕터 수정/삭제. **Edge Cache 자동 purge** |
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

---

## 22.5 Cloudflare Edge Cache — `/chapters` 가속 (v2.3.7)

홈 첫 진입 로딩 속도 개선. 챕터 메타데이터(시스템 공통)는 캐시 가능, 사용자별 데이터는 별도 endpoint.

### 무엇을 캐시하나
- **`/chapters` 응답만** 캐시 (Cloudflare 엣지 `caches.default`)
- 5분 TTL (`s-maxage=300`)
- 키: `https://opcache.local/chapters?role={student|teacher}&subject={subj}` — role + subject 별 분리

### 무엇은 캐시 안 하나
- ❌ `/auth/me` — 사용자별 (액세스/주문/관심/포인트)
- ❌ `/understood` — 사용자별 학습 진도
- ❌ `/access` — 사용자별 구독

→ 사용자가 챕터 순서·구매 필터·관심 주제를 바꿔도 **캐시 영향 0** (모두 `/auth/me`에서 옴).

### 자동 무효화 (Cache Invalidation)
변경 endpoint에서 `purgeChapterCache()` 호출:
- `POST /chapters` — 신규 챕터 생성 → purge
- `PUT /chapters/:id` — 챕터 수정 (is_published 토글 포함) → purge
- `DELETE /chapters/:id` — 챕터 삭제 → purge

→ 강사가 챕터 작업하면 **다음 호출부터 모든 사용자에게 즉시 반영**. (5분 기다릴 필요 X)

### 성능 효과
| 시나리오 | 이전 | 이후 |
|---------|------|------|
| 캐시 미스 (첫 사용자) | ~500ms | ~500ms (동일) |
| 캐시 히트 (5분간 나머지) | ~500ms | **~50ms (10배)** |
| 교사 챕터 추가 직후 | 즉시 | 즉시 (자동 purge) |
| 일반 평균 | ~500ms | **~70ms** |

### 구현 세부
```js
// route(request, env, ctx) — ctx 추가 전달
async function handleListChapters(request, env, ctx) {
  const auth = await verifyAuth(request, env);  // JWT만 검증 (~10ms)
  const role = auth?.role === 'teacher' ? 'teacher' : 'student';
  const cacheKey = chaptersCacheKey(role, subject);
  const hit = await caches.default.match(cacheKey);
  if (hit) return json(await hit.json(), 200, request);
  // ... fetch from nocodebackend ...
  ctx.waitUntil(caches.default.put(cacheKey, toCache));  // 백그라운드 저장
}
```

`ctx.waitUntil` — 응답 후 백그라운드에서 캐시 저장 → 첫 사용자도 지연 없음.

---

## 22.7 랜딩 페이지 제작 워크플로 (v2.3.8)

`onepage-landing.html` — 마케팅 진입 + 5단계 기억 시스템 설득 페이지. 아임웹(`vipup.site/onepage-study`)에 iframe으로 임베드.

> **소개 영상 섹션**: HERO 아래 16:9 반응형 영상 섹션 존재. 스크립트 상단 `OP_INTRO_VIDEO` 상수에 유튜브/Gumlet 주소만 넣으면 노출(자동 embed 변환), 비우면 자동 숨김. 전단지 QR은 이 랜딩페이지로 유도 → 영상은 여기서 재생(전단지 영상 QR 폐지).

### 페이지 구조 (위→아래 흐름)

```
HERO (강한 후킹)
  ↓ "외운 단어의 70%는 다음 날 사라집니다" — 통계 충격
  ↓ HERO 일러스트 (뇌+기억큐브 분해 시각화)
  ↓ 1885년 에빙하우스가 증명한 잔인한 사실...

PAIN (인지과학 3가지 — 통념 깨기)
  ↓ #1 능동 회상 없으면 + 일러스트
  ↓ #2 간격 둔 반복 없으면 + 일러스트
  ↓ #3 약점 추적 없으면 + 일러스트

5가지 시스템 한눈에 (해법 overview)
  ↓ 📑 목차 / ● 다지기 / ★ 별표 / 🎤✏️ 퀴즈 / 🧠 정교화

사용법 3 STEP (펼침 + 두 버튼)
  ↓ 1. 챕터 선택 → 2. 목차 펼침 → 3. 오늘/내일 학습

다지기 SRS — Anki 학습 과학
  ↓ 망각 곡선 그래프 (1·2·4·8·16·32일 6회 복습 시각화)
  ↓ 6박스 시스템 그리드

★ 별표 — 약점 자동 누적
  ↓ ★ 1~5개 임계값 표 (1-3 / 4-6 / 7-9 / 10-12 / 13+)

🎤 말하기 · ✏️ 첫글자 퀴즈
  ↓ 능동 회상 강제 — 입에서 안 나오면 진짜 외운 게 아님

🧠 정교화 학습 — 깊은 인출
  ↓ 뇌 + 4단서 일러스트
  ↓ 3단계 (블러+회상 / 다중단서 / 자기평가)

다른 앱과 비교 (vs 일반/Anki류)
핵심 가치 / 가격 / 포인트 / 추천 / FAQ / 최종 CTA + sticky bar
```

### 후킹 카피 4가지 패턴 (A/B 후보)

| 패턴 | 예시 | 강도 |
|------|------|------|
| **A 통계 충격형** ⭐ | "외운 단어의 70%는 다음 날 사라집니다" | ★★★★★ |
| B 도발/역설형 | "외우지 마세요. 다르게 외우세요" | ★★★★ |
| C 정체성·열망형 | "상위권은 외우지 않습니다" | ★★★★ |
| D 안전 일상통증형 | "어제 외운 단어가 오늘 안 떠오를 때" | ★★★ |

→ 현재 A 채택. 구체 숫자 + 권위(에빙하우스) → 즉각 신뢰.

### 이미지 자산 (`onepage-landing-media/`)

**6장 일관 스타일** (Google Gemini 이미지 생성):

| 파일 | 비율 | 자리 | 표시 사이즈 |
|------|------|------|------------|
| `hero-forgetting.webp` | 16:9 | HERO H1 아래 | max 520px |
| `pain-recall.webp` | 1:1 | PAIN #1 아이콘 | 84×84 (64 모바일) |
| `pain-spacing.webp` | 1:1 | PAIN #2 아이콘 | 84×84 |
| `pain-weakness.webp` | 1:1 | PAIN #3 아이콘 | 84×84 |
| `curve-ebbinghaus.webp` | 16:9 | SRS 섹션 상단 | max 680px |
| `brain-elaboration.webp` | 1:1 | 정교화 섹션 상단 | 240×240 (180 모바일) |

### 이미지 스타일 가이드 (반드시 모든 자산 일관 적용)

```
배경: 깊은 네이비 #0a0a1a → #16213e 그라데이션
강조색: 진홍 #e94560, 호박 #ffb347
톤: 모던 미니멀, 다크 모드, 부드러운 글로우
스타일: 이소메트릭 또는 플랫 일러스트 (사진 X)
글자 없음 (한글 직접 렌더링 시 깨질 위험 — HTML로 따로)
```

### Gemini 이미지 생성 워크플로

1. **품질 설정 "최고"** (이미지 생성 박스 우측 슬라이더)
2. **한 채팅 안에서 시리즈 생성** — 스타일 일관성 유지됨
   - 첫 이미지 OK → "같은 스타일로 이번엔 [다른 주제]"로 이어달라기
   - 새 채팅 시작하면 톤이 바뀜 → 한 채팅 = 한 시리즈 원칙
3. **참고 이미지 업로드** (좌측 + 버튼) — 기존 이미지를 스타일 reference로 활용 가능
4. **마음에 들 때까지 "다시" or "조정"** — 변형 4개씩 받아 선택

### 한국어 프롬프트 템플릿 (이 도구는 한국어 직접 이해)

**예 — HERO**:
```
이소메트릭 일러스트레이션. 어두운 네이비 배경(#0a0a1a → #16213e 그라데이션). 
사람의 머리 모양 안에서 빛나는 기억 큐브들이 떠 있고, 그 중 절반이 
입자로 흩어져 밖으로 날아가는 모습. 
사라지는 입자는 진홍색 글로우(#e94560), 남아있는 큐브는 호박색(#ffb347) 하이라이트.
모던 미니멀, 사진처럼 사실적 X, 글자 없음. 16:9 비율.
분위기: 과학적이고 약간 드라마틱, 상실감.
```

### 압축 → 배포

```
1. Gemini PNG 다운로드 (1~3MB)
2. TinyPNG (https://tinypng.com) 또는 Squoosh (https://squoosh.app)
   → WebP 변환 + 압축 → 30~150KB
3. onepage-landing-media/ 폴더에 권장 파일명으로 저장
4. PNG 원본도 같이 보관 (다른 사이즈 필요 시)
5. git push → 자동 Vercel 배포
```

### HTML 삽입 패턴

**HERO** (첫화면 — eager loading):
```html
<img class="op-hero-visual"
     src="onepage-landing-media/hero-forgetting.webp"
     alt="..."
     loading="eager" decoding="async">
```

**PAIN/SRS/정교화** (lazy loading):
```html
<img class="op-pain-img" src="..." alt="..." loading="lazy" decoding="async">
<img class="op-srs-curve" src="..." alt="..." loading="lazy" decoding="async">
<img class="op-elab-brain" src="..." alt="..." loading="lazy" decoding="async">
```

### CSS 클래스 (`#opRoot .op-*-visual`/`-img`/`-curve`/`-brain`)

- `box-shadow` 또는 `drop-shadow`로 다크 배경에 글로우
- 모바일(`max-width: 480px`) 사이즈 축소
- `object-fit: cover` (잘림 방지)
- `border-radius` 부드러운 모서리

### 인터랙티브 데모 섹션 제거 (v2.3.6)

이전엔 `<section id="demo">`에 학습 카드 시뮬레이션이 있었으나 **삭제**:
- **이유**: 부분 기능만 시연 → 사용자가 일부 보고 예단 → 전체 페이지 끝까지 안 읽고 이탈 위험
- **대체 흐름**: HERO → 인지과학 PAIN → 5가지 시스템 → 정교화 → ... → 최종 CTA → 실제 앱 가입 → 모든 기능 체험
- 약 339줄 dead code 청소 (HTML/CSS/JS)

### Sticky CTA + 최종 CTA

- **하단 sticky bar** (`.op-sticky`) — 항상 노출. 최종 CTA 섹션 visible 시 자동 hide
- **최종 CTA** (`.op-final`) — 페이지 끝, "지금 시작하기 →" → `https://memoryking.kr/`
- UTM 파라미터 자동 첨부 — `?utm_source=...&utm_medium=...` 캡쳐 후 학생 앱 URL에 reroute

---

## 22.8 수학 콘텐츠 제작 워크플로 (v2.3.9)

### 폴더 위치

```
C:/Users/memoryking/00_DEV/11_math/
  ├ 미분가능성/         ← 단원 단위 폴더
  ├ 적분/
  └ ...
```

각 단원 폴더 안에 문제별 파일 묶음을 둔다.

### 파일 명명 규칙 (3종 세트)

| 종류 | 파일명 | 용도 |
|------|--------|------|
| 소스 | `<번호>_<제목>.md` | LaTeX 수식 포함 마크다운 — 작성용 |
| 컴파일 | `<번호>_<제목>.html` | MD → HTML 변환 결과 |
| 그래프 | `<번호>_<제목>_그래프.svg` | matplotlib·desmos 등으로 생성한 SVG |
| **업로드용** | `<번호>_<제목>_합본.html` | SVG 인라인 삽입 — 학생 앱 업로드 단위 |

예 (미분가능성 단원):
```
01_절댓값삼차함수.md          ← 작성
01_절댓값삼차함수.html         ← 컴파일
01_절댓값삼차함수_그래프.svg    ← 그래프
01_절댓값삼차함수_합본.html     ← 머지 (업로드)
```

**SVG 여러 개**: `_그래프1.svg`, `_그래프2.svg`로. HTML 안에서 `<img src="...그래프1.svg">`, `<img src="...그래프2.svg">` 순서대로 참조.

### HTML이 SVG 참조하는 패턴 (필수)

HTML 안에서 SVG는 반드시 `<img>` 태그로 참조:

```html
<img src="01_절댓값삼차함수_그래프.svg" alt="설명">
```

머지 스크립트가 이 `<img>` 태그를 찾아 인라인 `<svg>...</svg>`로 치환한다.
파일명이 HTML과 정확히 안 맞아도 (`02_구간별함수_미정계수.html` ↔ `02_구간별미정계수_그래프.svg` 같이 달라도) `<img src>` 경로만 정확하면 머지된다.

### 머지 도구 — `scripts/merge-math.js`

학생 앱 업로드용 합본 HTML을 한 줄로 생성.

**폴더 일괄**:
```bash
node scripts/merge-math.js "C:/Users/memoryking/00_DEV/11_math/미분가능성"
```

**단일 파일**:
```bash
node scripts/merge-math.js "C:/Users/memoryking/00_DEV/11_math/미분가능성/05_미분계수.html"
```

**동작**:
1. 폴더면 `*.html` 모두, 단일 파일이면 그 하나만 처리
2. 이미 `_합본.html`로 끝나면 건너뜀
3. HTML 안 `<img src="...svg">` 마다 같은 폴더의 SVG를 찾아 인라인 치환
4. SVG에서 `<?xml ...?>` / `<!DOCTYPE>` 헤더 제거
5. 루트 `<svg>`에 `width="100%"` 자동 부여 (없으면)
6. SVG 0개여도 `_합본.html` 생성 (업로드 단위 통일)
7. 누락된 SVG는 `⚠`로 표시 + 파일명 출력

### 학생 앱에 업로드하는 순서 (일괄)

1. 합본 만들기:
   ```bash
   node scripts/merge-math.js "C:/Users/memoryking/00_DEV/11_math/<단원>"
   ```
2. 교사 앱(`onepage-teacher.html`) → 챕터 → 목차(topic) 펼침 → **+ 📄 HTML 일괄 추가** 버튼
3. 폴더의 `*_합본.html` 여러 개 선택 → 확인
4. **자동 처리**:
   - 파일마다 학습 카드(subtopic) 생성 (제목은 파일명에서 추출)
   - 파일 안에 `<!-- 암기카드 -->` / `<!-- 내용 -->` 마커가 있으면 → 1 카드 안 2 item (암기카드/내용)
   - 마커 없으면 → 1 카드 안 1 item
5. 학생 앱에서 카드 진입 → DOMPurify sanitize 후 표시
6. MathJax가 카드 안 LaTeX 자동 렌더링
7. SVG 인라인 → 외부 요청 없음
8. 학생이 그래프 터치 → 풀스크린 라이트박스로 확대 (§23.16)
9. 다지기 모드에서는 본문 블러 → 학생이 카드 터치 전에 풀이가 가려져 있음 (자연스러운 "먼저 풀어보기" 학습 흐름)

### 새로 만들 때 한 줄 요청

기억해 둘 약속:
```
"11_math/<단원폴더> 합본 만들어 줘"
```
→ 클로드가 `node scripts/merge-math.js`로 해당 폴더 전체 일괄 처리.

또는 사용자가 직접:
```bash
node scripts/merge-math.js "C:/Users/memoryking/00_DEV/11_math/<단원폴더>"
```

### 주의 사항

- **MD에서 LaTeX 인라인**: `$x^2$`, `$$f(x) = ...$$`, `\(...\)`, `\[...\]` 모두 지원 (MathJax 3 lazy load)
- **SVG 크기 제한**: 단일 SVG > 500KB 시 [SVGOMG](https://jakearchibald.github.io/svgomg/)로 최적화 권장 (matplotlib 출력은 자주 1MB 초과)
- **matplotlib `<use href="#mxxx">` 글리프 참조**: DOMPurify 화이트리스트에 `href`/`xlink:href` 이미 포함됨 — 텍스트 깨지지 않음
- **머지 후 .html / .svg 원본**: 손대지 않음. 합본만 추가 생성됨

---

## 22.9 단어풀 참조 — 영단어·한자 콘텐츠 (v2.4.0)

**핵심**: 영단어·한자 카드는 **내용을 저장하지 않는다.** `op_items.text = "@@WORD:단어@@"` 참조만 두고,
워커가 서빙 시 **`op_pool`** 에서 뒷면을 조합한다. → **단어풀을 고치면 그 단어가 든 모든 콘텐츠가 자동 반영.**
(한국사·수학 등 다른 과목은 **기존 방식 그대로** — `text` 에 본문 저장)

### 구조
```
챕터 = 단어묶음(대분류)   ← 가격·공개여부. 신규 챕터는 기본 비공개(작성중)
  └ 목차 = 소분류(a·b·c)
     └ 학습 카드 = 단어    ← op_subtopics.title = 단어 (앞면 + 이미지 자동 매칭 키)
        └ 내용 = "@@WORD:단어@@"   ← 참조만. 서빙 시 op_pool 로 조합
```
- 조합 결과(뒷면): **발음 · 뜻 · 암기법 요약 · 상세 · 예문1/2(영+한) · (동영상)**
  — `composeWordCardHTML()` (`onepage-worker/worker.js`)
- **이미지**는 조합에 미포함 — 학생 앱이 `wordImageFor()` + `word-images.json` 으로 자동 삽입
- 원천은 로컬 `word-pool/word_pool.db`. `op_pool` 은 서버 사본 → [ONEPAGE_SCHEMA.md § B7](ONEPAGE_SCHEMA.md)

### 선생님 앱 기능
| 버튼 | 기능 |
|---|---|
| **📥 단어 일괄 추가** | 단어 붙여넣기 → 정규화·내부중복·**챕터 기존 단어 중복 제외** → 남은 것만 추가.<br>**알파벳순**=첫글자 소분류(a·b·c)에 삽입 / **입력순**=마지막 소분류 뒤 append.<br>대상: **📚 기존 콘텐츠에 추가** / **✨ 새 콘텐츠로 발행**(제목·가격 → 비공개 챕터 생성).<br>단어풀에 없으면 **'콘텐츠 대기'** 경고 |
| **🚀 발행 점검** | 소분류·단어 수 · **풀 누락(빈 카드)** · 이미지 없음 · 가격 · 전체무료 · 공개상태 확인 → 공개/비공개 전환 |

### 콘텐츠 갱신 (풀 → 서버)
`word-pool` 관리콘솔 **☁️ 서버 반영** (= `export_op_pool.py` → `push_op_pool.py` → `POST /admin/op_pool/sync`)
→ 발행된 모든 콘텐츠의 카드가 최신 풀 내용으로 갱신. **카드 형식 변경은 워커 배포만으로 전체 적용.**

> 상세: [WORD_POOL.md](WORD_POOL.md) · `word-pool/SETS_PLAN.md`(아키텍처) · `word-pool/DEVLOG.md`(개발기록)

---

## 23. v2 학습 시스템 (단일 카드 + 퀴즈)

### 23.1 다지기 모드 — 6박스 SRS + 단일 카드 스테이지
- **6박스**: 오늘 학습 / 내일 학습 / 4일 후 / 8일 후 / 16일 후 / 32일 후
- **인터벌**: `[null, 0, 1, 4, 8, 16, 32]` (Box 1~6 일)
- **오늘 학습**은 단일 카드 스테이지 — 큰 카드 1장 중앙 + 우상단 stacked 카드 더미 + 카운트
- **미래 박스**는 인벤토리 리스트 — 펼치면 카드 모두 표시
- **자정 자동 정렬**: `next_review_at <= 오늘` 인 카드는 자동으로 effectiveBox=1 → 오늘 학습에 등장
- **자정 넘김 안내**: 다지기 진입 시 `lastStudyDate`(localStorage) 비교 → 다르면 모달 "🌅 N장의 카드가 오늘 학습으로 도착했습니다"

### 23.2 카드 터치 학습 (깊은 학습)
오늘 학습 카드 1장이 중앙에 보임. 본문은 블러됨 → 카드 터치 → 본문 공개 → 평가 바.
- **✓ 학습 OK** → `memorizedPass(sid, {forcePeeked: false})` → 다음 박스로 advance (Box+1)
- **✗ 더 학습** → `memorizedPass(sid, {forcePeeked: true})` → 오늘 박스 유지 + `miss_count+=1`
- 정답/오답 시 카드가 좌/우로 fly-out 32° 회전 (CSS animation)

### 23.3 미래 박스 펼침→접음 = 신비로운 dissolve 강등
- 미래 박스(b≥2) 카드를 펼쳤다가 다시 탭 → "확인해보니 모르더라" 신호
- 1.4초 동안 보랏빛 halo + blur + 위로 떠오르며 dissolve 후 오늘 학습으로 강등 (peek+pass)

### 23.4 음성 퀴즈 / 첫글자 퀴즈 (단어-뜻 빠른 연결)
**전제**: `op_chapters.voice_quiz_enabled=1` 인 챕터. items[0] = 정답.

**🎤 말하기 퀴즈** (4초 타이머, 버튼 라벨 "말하기"):
- Web Speech API SpeechRecognition (브라우저 STT)
- 카드 등장 → (선택) TTS 제목 → 마이크 4초 listening
- STT 결과 vs items[0] 정규화 비교 (한국어/영어 + 후보 5개 중 매칭)
- onstart 이벤트로 타이머 시작 — 모바일 listening 지연 보정
- 마이크 미연결 PC: enumerateDevices() 사전 체크 + 안내 toast

**✏️ 첫글자 퀴즈** (객관식 2지선다):
- 정답의 첫 글자 + 같은 챕터 다른 카드들의 첫 글자 풀에서 random distractor
- "안다고 착각" 차단 — 가벼운 commitment 강제

**공통 설정** (localStorage 영속):
- 수동/자동 모드 — 자동은 hands-free (오답도 자동 진행)
- 🔊 문제 읽기 ON/OFF — TTS 제목 + 결과 뜻 읽기
- 🔔 효과음 ON/OFF (문제 읽기 ON 시 자동 ON)
- 최근 오답 3개 FIFO 후순위 (바로 다시 안 나옴)

**3-stack 풀 모델 (v2.1)** — 정교화/음성/첫글자 **독립 카운트**:
- `state.quizDoneSetVoice` — 🎤 말하기 정답 카드
- `state.quizDoneSetFirstLetter` — ✏️ 첫글자 정답 카드
- 우상단 deck stack 3개 (정교화 초록 / 말하기 파랑 / 첫글자 보라) — **버튼 색상과 1:1 매칭**

**Cascade 규칙**:
| 액션 | 정교화 | 말하기 | 첫글자 |
|------|--------|--------|--------|
| 🎤 정답 | 그대로 | −1 | 그대로 |
| ✏️ 정답 | 그대로 | 그대로 | −1 |
| 🧠 정교화 ✓ (학습 OK) | box+1 (자연 제외) | −1 cascade | −1 cascade |
| 🧠 정교화 ✗ (더 학습) | peek+pass | done 해제 (재등재) | done 해제 (재등재) |
| 미래 박스 데모트 | 오늘 박스 합류 | done 해제 (fresh) | done 해제 (fresh) |

**중요 결정**: 퀴즈는 **SRS 박스 변경 안 함** — 단순 단어-뜻 연결 확인용.
정교화 학습만이 box 진행에 영향.

### 23.5 사진 스냅샷 결과 + 띵동/삑 신호음
정답/오답 시 카드 전체가 색상으로 변하고 단어/뜻이 크게 위·아래로 표시 (사진 찍히듯).
- 텍스트 라벨("정답!"/"다시"/"시간 초과") 모두 제거 — 집중 방해
- 색상만 — 초록(정답) / 빨강(오답·타임아웃)
- 흰 플래시 0.45s 오버레이 (카메라 셔터 느낌)
- 음성: 말 "정답"/"정답은 X" 제거. **띵동(sine 2-tone 상승) / 삑(square 하강) Web Audio 신호음** + 뜻만 TTS

### 23.6 일반 모드 3탭 (new / 별표 / all)
챕터 안 학습 카드를 3가지 관점으로:
- **new**: 아직 학습 안 한 카드만 (op_understood 행 없음)
- **★ 별표**: `miss_count > 0` 인 카드, miss 많은 순 정렬. ★ 1-3=1개, 4-6=2개, 7-9=3개, 10-12=4개, 13+=5개 (v2.3.4 임계값 완화)
- **all**: 모든 카드 + 박스 위치 라벨 (오늘/내일/4일/8일/16일/32일) + ★ 누적

### 23.7 격려 음성 — 사람 녹음 mp3
브라우저 TTS는 OS별 품질 편차 큼 (Windows Heami 로봇 톤). 사람 녹음 mp3로 교체.

**파일** (`onepage-user/guide-media/`):
- `encourage-start.mp3` — 모드 시작 ("시작합니다 화이팅")
- `encourage-halfway.mp3` — 20개 이하 ("조금만 더 힘내세요")
- `encourage-clear.mp3` — 모두 풀음 ("잘 했습니다")

**재생 로직**: `speakEncouragement(key, onDone)` — `<audio>` 단일 인스턴스, 동시 재생 방지.
**시작 멘트 후 첫 문제 읽기** — onended 콜백 안에서 `voiceQuizNextCard()` 호출 → TTS 겹침 방지.

### 23.8 정교화 학습 모드 (모드 진입 + 자연 종료 dissolve)
다지기 진입 시 박스 전부 닫힘 (b=1 포함). **모드 버튼만이 박스 펼침**:
- 🧠 정교화 / 🎤 말하기 / ✏️ 첫글자 — 각 버튼이 box 1 열고 모드 시작
- "오늘 학습" 헤더 클릭 → 무반응 (잠금)

**자연 종료 시 dissolve**:
- 더 풀 카드 없음 → 🎉 "끝났어요" 메시지 1.4초 노출
- 0.7초 dissolve 애니메이션 (opacity + blur + scale)
- 스테이지 자동 닫힘
- 수동 × 중단은 기존대로 즉시 닫힘 (메시지 없음)

### 23.9 ETag 기반 자동 업데이트 감지
Service worker 없이 Vercel의 자동 ETag 헤더 활용 — 배포 후 활성 사용자에게 비침습적 알림.

**동작**:
1. 앱 시작 3초 후 자기 자신(`index.html`) HEAD 요청 → 초기 ETag 캡처
2. 5분 폴링 + `focus`/`visibilitychange` 시 비교
3. ETag 다르면 상단에 ✨ "새 버전이 있어요" 배너 (지금 업데이트 / 나중에)
4. 학습 중(퀴즈/정교화 모드)엔 미룸 — 다음 체크에서 다시 시도
5. "나중에" 닫으면 `localStorage.op_update_dismissed_at` 기록 → 30분 쿨다운

**개발자 수동 작업 0** — `git push`만 하면 됨. Vercel이 콘텐츠 해시 기반 ETag 자동 발급.
**한계**: `index.html` 변경 시에만 트리거. 자산 단독 교체 시 배너 안 뜸 (자연 갱신은 됨).

### 23.10 커스텀 도메인 (memoryking.kr)
`onepage-study.vercel.app` + `memoryking.kr` 듀얼 운영.

**Worker CORS** (`onepage-worker/worker.js`):
- `ALLOWED_ORIGINS`: memoryking.github.io, vipup.site, onepage.vipup.site, **memoryking.kr**, **www.memoryking.kr**, localhost들
- `ALLOWED_ORIGIN_PATTERNS`: `/^https:\/\/[a-z0-9-]+\.vercel\.app$/i` (모든 vercel.app 서브도메인)

**PayApp 결제 리턴 URL**: `STUDENT_APP_ORIGIN = 'https://memoryking.kr'` (vercel.app → 커스텀 도메인 전환).

**배포**: Worker는 GitHub auto-deploy 없음 — `cd onepage-worker && wrangler deploy` 수동 실행 필수.

### 23.11 학습 모드 — 신규 단어 오늘/내일 학습 버튼 (v2.3)
일반 학습 모드(다지기 X)에서 카드 펼침 시 본문 하단에 두 개 버튼 노출. 신규 단어를 즉시 다지기로 보낼지, 내일 박스로 보낼지 사용자가 선택.

**조건** (모두 만족 시 노출):
- `state.memorizedView === false` (일반 모드)
- 카드 펼친 상태 + 본문 정상 로드 (잠김/오류/빈 카드 제외)
- `!state.understoodSet.has(sid)` — 신규 카드만 (이미 ● 카드는 안 보임)

**버튼**:
| 버튼 | 색상 | 서버 호출 | 결과 |
|------|------|----------|------|
| 📚 오늘 학습 | 빨강 | `POST /understood` | box=1, due 내일 → 다지기 오늘 박스 |
| 📅 내일 학습 | 보라 | `POST /understood/promote` | box=2, due 내일 → 다지기 내일 박스 |

**애니메이션**: 클릭 시 다지기 미래박스 강등과 동일한 `srs-demoting` dissolve 1.4초.
**옛 ⤴ 패스 버튼**: 우선 숨김(주석 처리). 두 버튼이 대체.

### 23.11.2 miss_count 트리거 (v2.3.4 — 별표 누적 규칙)
"틀린 횟수 = 별표"가 정확히 늘어나는 6가지 시나리오 (한 동작당 +1):

| # | 시나리오 | 처리 위치 | 메커니즘 |
|---|----------|----------|----------|
| 1 | 일반(new) 펼친 후 **오늘 학습** 버튼 (box=1, '한 번 더 봐야지') | `studyDayPick(sid, 1)` | `/understood` 생성 → `/peek` 추가 호출 + client 즉시 +1. **내일 학습(box=2)은 긍정 신호라 miss 0 유지** |
| 2 | 다지기 정교화 "더 학습" 버튼 | Worker `/understood/pass` | `was_peeked=true` + 기존 행 → miss +1 (v2.3.4 추가) |
| 3 | 말하기 퀴즈 오답 (자동/수동 모두) | `voiceQuiz proceed`, `voiceQuizContinue` | `bumpMissCount(sid)` |
| 4 | 첫글자 퀴즈 오답 (자동/수동 모두) | `firstLetterQuiz proceed`, `firstLetterQuizContinue` | `bumpMissCount(sid)` |
| 5 | 내일(b=2) 박스 펼치고 닫음 → dissolve | `subClick` setTimeout | client +1, 서버는 `was_peeked` 경로 |
| 6 | 4·8·16·32일 후(b≥3) 박스 펼치고 닫음 → dissolve | 동일 | 동일 |

**중복 방지**: subClick 펼침 시점의 `apiPeek` 호출은 다지기 미래박스(b≥2)에 대해 skip. dissolve 시 한 번만 +1.

**임계값** (`missToStarCount`):
- 1-3 → ★ / 4-6 → ★★ / 7-9 → ★★★ / 10-12 → ★★★★ / 13+ → ★★★★★
- 이전(v2.3.3): 1-2/3-4/5-6/7-8/9+ — 새 임계가 더 관대 (학습 의욕 보호)

**bumpMissCount(sid)** 헬퍼:
- client `state.understoodMissCount[sid] += 1` 즉시
- 서버 `POST /understood/peek` fire-and-forget (응답 무시 — race 방지)
- 행 없으면 서버 skip, 행 있으면 +1

### 23.11.1 소리 안전장치 — 조용한 환경 보호 (v2.3.3)
"조용한 데서 깜짝 놀라는" 사고 방지. 모달 없는 conservative defaults 방식.

**규칙**:
1. 다지기 진입 시 → 효과음 + 문제 읽기 둘 다 자동 OFF (localStorage 동기화)
2. 다지기 나갈 때 → 둘 다 OFF (다음 진입에도 OFF로 시작)
3. 다지기 안에서 10분간 활동 없으면 → 둘 다 OFF + 토스트 "10분 조용해서…"

**활동 감지**: `document` 레벨 `click` / `touchstart` / `keydown` (capture+passive). 다지기 밖이면 비용 0.
**의도**: 사용자가 ON으로 켠 후에도 위 규칙 적용. 의도적으로 켠 건 그 활동 시간만큼만 유지.
**모달 안 띄움**: UX 마찰 최소화. 기본을 안전하게 + 자동 보호.

### 23.13 신규 사용자 온보딩 (v2.3.7 — 환영 모달 + 펄스)
랜딩에서 가입한 사용자가 홈 첫 진입 시 헤매지 않게 안내.

**A) 환영 모달** (`maybeShowWelcome`):
- `enterHome()` 후 350ms 지연으로 자연스럽게 표시
- 조건: `localStorage.op_welcome_seen` 미설정 **AND** `op_guide_seen` 미설정
- 본문: "1분이면 사용법 끝나요. 가이드 먼저 읽어볼까요?" + 6 STEP 요약
- 2버튼:
  - **📖 가이드 보기 (1분)** → `openGuide()` (guide.html이 `op_guide_seen='1'` 자동 설정)
  - **먼저 둘러보기** → 모달 닫고 펄스 힌트 발동

**B) 가이드 버튼 펄스** (`#guideBtn.pulse-hint`):
- 둘러보기 선택 시 우상단 📖 가이드 버튼에 10초간 펄스 글로우
- 빨강 배경/보더 + box-shadow ring 호흡(1.4s) + scale 1.04
- 10초 후 자동 해제 (`setTimeout` removeClass)

**상태 키**:
| key | 설정 시점 | 역할 |
|-----|---------|------|
| `op_welcome_seen` | 둘 중 어느 버튼이든 누른 직후 | 환영 모달 1회만 노출 |
| `op_guide_seen` | guide.html 진입 시 자동 | 모달 차단 (이미 본 사용자) |

→ **둘 중 하나라도 있으면 모달 비노출** — 자연스럽고 침습적 X.

### 23.12 가이드 — 전체보기 9개 카드 + 라이트박스
`onepage-user/guide.html`의 "전체 보기" 섹션에 9개 캡쳐 카드 (메인/학습/다지기/내 계정/포인트/모르면 오늘로/결제/암기카드 3탭/친구추천).

- 이미지 클릭 → 풀스크린 라이트박스 (배경 0.94 어두움 + 클릭/✕/ESC 닫기)
- **이벤트 위임**(`document` 레벨 `.tour-shot img`) — placeholder가 나중에 `<img>`로 교체돼도 자동 동작
- 사이즈: 9:16 720×1280 (세로) 또는 16:9 1280×720 (가로) 권장
- 모든 이미지는 `guide-media/screen-*.png` (9개)

### 23.16 학습 카드 본문 라이트박스 — 이미지·SVG 풀스크린 확대 (v2.3.9)

학생 앱(`onepage-user/index.html`) 학습 카드 안의 이미지/SVG를 터치하면 풀스크린으로 확대.

**대상**:
- `.item-image` — `kind='image'` 블록의 대표 이미지
- `.item-svg svg` — `kind='svg'` 블록의 인라인 SVG
- `.item-html svg`, `.item-html img` — `kind='html'` 안에 임베드된 SVG/이미지 (수학 합본 그래프 등)

**시각 단서**:
- 위 요소들에 `cursor: zoom-in` + 호버 시 `filter: brightness(1.06)` — 클릭 가능 신호
- (`.item-image`의 기존 `pointer-events: none`는 제거됨 — 보호는 워터마크 + `oncontextmenu='return false'`로 충분)

**라이트박스 UI** (`.content-lightbox`):
- 풀스크린 다크 오버레이 (rgba 0/0/0/0.94)
- 흰 배경 카드 + 그림자 + round 12px (`.content-lightbox-body > *`)
- 우상단 ✕ 버튼 (`.content-lightbox-close`)
- 페이드(200ms) + 스케일 인(280ms cubic-bezier 살짝 오버슈트) 애니메이션

**크기 처리** (이게 핵심):
- `> svg { width: min(95vw, 1400px) !important; height: auto }` — SVG는 인트린식(300×150)으로 쪼그라들지 않게 명시
- `> img { width: auto; height: auto; object-fit: contain }` — 비율 유지하며 95vw/90vh 안에서 최대
- `.content-lightbox-body { width:100%; height:100% }` — flex 컨테이너 가용 공간 확보

**동작 흐름**:
- `document` 레벨 click 캡쳐 → `closest('.item-image, .item-html svg, .item-html img, .item-svg svg, .item-svg img')`
- 대상 발견 → `cloneNode(true)`로 라이트박스 body에 복제 (원본 DOM 그대로 유지)
- 열린 동안 `document.body.style.overflow = 'hidden'` — 배경 스크롤 잠금
- 닫기 3가지: 배경 클릭 / ✕ 버튼 / ESC 키

**`guide.html`의 `.lightbox`와는 별개 클래스** (`.content-lightbox`) — CSS 충돌 방지.
