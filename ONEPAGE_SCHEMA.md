# Onepage — 테이블 스키마 정의서

원페이지 학습 서비스의 백엔드 스키마. **Airtable**(사람·돈·캐페인 도메인) + **nocodebackend**(콘텐츠 도메인)로 분리.

- Airtable base: 기존 base 재사용, 테이블명 `Onepage*` (5개)
- nocodebackend Instance: `55910_flashcard_app` 재사용, 테이블명 `op_*` (6개)
- 모든 사용자 키는 **전화번호(숫자만, 예: `01012345678`)** — PayApp 결제 webhook과의 매칭 키

## 테이블 일람

| 영역 | 테이블 | 용도 |
|---|---|---|
| Airtable | `OnepageUsers` | 회원 + UTM 어트리뷰션 |
| Airtable | `OnepageChapterAccess` | 사용자×챕터 만료일 |
| Airtable | `OnepagePayments` | PayApp webhook 결제 원장 |
| Airtable | `OnepagePointTx` | 포인트 변동 감사 로그 |
| Airtable | `OnepageCampaigns` | CRM QR 라이브러리 (마케팅 자산) |
| Airtable | `OnepageCampaignSends` | 캐페인 발송 로그 — 수신자 1명당 1행, 분석/전환 측정용 |
| Airtable | `UnknownPayments` | (v1 deprecated) Pabbly 결제 라우터 폴백 — 상품명 미매칭 |
| Airtable | `FailedPayments` | (v1 deprecated) Pabbly 결제 라우터 안전망 — Airtable 쓰기 실패 |
| nocodebackend | `op_chapters` | 챕터 (+ 페이앱 결제 URL) |
| nocodebackend | `op_topics` | 목차 |
| nocodebackend | `op_subtopics` | 학습 카드 (+ 대표 이미지) |
| nocodebackend | `op_items` | 내용 블록 (텍스트·이미지·링크) |
| nocodebackend | `op_understood` | 학생 꾹누르기 진도 |
| nocodebackend | `op_pings` | 라이브 학습자 카운트 |

---

## A. Airtable 테이블

### A1. `OnepageUsers`

회원 마스터. 인증·포인트·추천·**UTM 어트리뷰션**의 단일 진실원본.

| 필드명 | Airtable 필드 타입 | 옵션·기본값 | 비고 |
|---|---|---|---|
| `name` | **Single line text** | — | 이름 |
| `phone` | **Single line text** | — | **숫자만 저장 (예: `01012345678`)**. Phone number 타입은 자동 포맷이 들어가서 결제 매칭에 방해 → Single line text 권장 |
| `email` | **Email** | — | 로그인 ID. 자동 형식 검증 |
| `password_hash` | **Long text** | — | PBKDF2 형식 (`salt:hash` base64) |
| `role` | **Single select** | 옵션: `student`, `teacher` · 기본 `student` | 가입 시 student로 들어옴 |
| `referral_code` | **Single line text** | — | 회원가입 시 Worker가 6자리 base36 생성 |
| `referred_by_code` | **Single line text** | — | 가입 시 입력 (선택). 비어 있어도 OK |
| `point` | **Number** → Integer (≥0) | 기본 `0` | "Allow negative" 체크 해제 |
| `first_paid_at` | **Date** → "Include time field" 체크 | — | 첫 결제 시각 (추천 보너스 중복 방지). 빈 값 허용 |
| **`utm_source`** | **Single line text** | — | 광고 매체 (flyer, youtube, instagram, kakao …) |
| **`utm_medium`** | **Single line text** | — | 노출 방식 (qr, video, bio, banner …) |
| **`utm_campaign`** | **Single line text** | — | 캐페인 그룹 (school-A, launch-week …) |
| **`utm_content`** | **Single line text** | — | A/B 디자인 변형 (design-A, design-B …) |
| **`utm_term`** | **Single line text** | — | 키워드 (선택) |
| **`landing_url`** | **Long text** | — | 가입 직전 랜딩 URL 전체 (파라미터 포함) |
| **`referrer_url`** | **Long text** | — | `document.referrer` (어디서 클릭해서 왔는지) |
| **`interests`** | **Long text** | — | 관심 주제 — 콤마 구분 과목 문자열 (예: `"수능,토익"`). 가입 시 URL `?interest=...` 캡쳐 또는 학생 앱 모달에서 편집. 빈 값/미설정이면 필터 OFF (전체 노출). 최대 20개. |
| `created_at` | **Created time** (auto) | 자동 채움 | Airtable 자동 필드 |

**UTM 7개 필드**: 가입 시 한 번만 기록(불변). 비어 있어도 OK — 추천 가입이나 직접 입력 가입은 비어 있음. CRM `/admin/attribution`이 이 필드들로 캐페인별 성과 집계.

**`interests` 필드**: UTM과 달리 **사용자 편집 가능**. 학생 앱 우상단 👤 → 🎯 관심 주제 모달의 체크박스 결과를 `PUT /auth/me/interests` 로 즉시 갱신. URL `?interest=` 자동 캡쳐는 가입 직전 localStorage 30일 TTL에 누적.

**유니크 제약 (Airtable 자체 unique 제약은 없으니 Worker에서 검사)**
- `phone` 유니크
- `email` 유니크
- `referral_code` 유니크 (충돌 시 재생성)

**권장 뷰**
- `전체 회원` — 기본
- `선생님` — role=teacher
- `추천왕` — point 내림차순
- `UTM 추적된 가입자` — utm_source 비어있지 않음

---

### A2. `OnepageChapterAccess`

(사용자 × 챕터)별 만료일. 만료 후 자동으로 무료 사용자 = 이 행이 만료된 행은 게이트가 거부.

| 필드명 | Airtable 필드 타입 | 옵션·기본값 | 비고 |
|---|---|---|---|
| `user_phone` | **Single line text** | — | 회원 매칭 키 (숫자만) |
| `chapter_id` | **Number** → Integer | — | nocodebackend `op_chapters.id` |
| `chapter_title` | **Single line text** | — | 가독성용 사본 (Airtable에서 보기 편하게) |
| `expires_at` | **Date** → Include time | — | **게이트의 기준 컬럼** |
| `last_payment_id` | **Single line text** | — | PayApp `mul_no` (포인트 사용 시 비어 있음, 관리자 지급 시 `ADMIN-{name}-{timestamp36}` 형식) |
| `source` | **Single select** | 옵션: `purchase`, `point_redeem`, **`admin_grant`** | `admin_grant`는 CRM에서 수동 지급 시 자동 세팅 — 매출 통계에서 제외됨 |
| `created_at` | **Created time** (auto) | 자동 채움 | |
| `updated_at` | **Last modified time** (auto) | 자동 채움 | |

**복합 유니크 (Worker에서 검사)**: `(user_phone, chapter_id)`

**권장 뷰**
- `활성` — expires_at > TODAY()
- `만료 임박 (D-3)` — expires_at >= TODAY() AND expires_at <= DATEADD(TODAY(),3,'days')
- `만료됨` — expires_at < TODAY()

---

### A3. `OnepagePayments`

PayApp 결제 원장. **Pabbly Connect 결제 라우터**가 채움. **Worker는 읽지도 쓰지도 않음**.

| 필드명 | Airtable 필드 타입 | 옵션·기본값 | 비고 |
|---|---|---|---|
| `mul_no` | **Single line text** | — | PayApp 결제번호. **멱등성 키** — Pabbly가 같은 mul_no 중복 차단 |
| `user_phone` | **Single line text** | — | 결제자 휴대폰 (숫자만, recvphone/buyer_phone에서 추출) |
| `user_email` | **Email** | — | buyer_email |
| `chapter_id` | **Number** → Integer | — | Pabbly가 Worker `/chapters` 조회 후 goodname → title 매칭 |
| `chapter_title` | **Single line text** | — | 매칭된 챕터 제목 (디버깅·가독성용 사본) |
| `amount` | **Currency** (KRW, ₩, 소수점 0자리) | — | price → amount |
| `paid_at` | **Date** → Include time | — | KST 시각 (Pabbly가 변환) |
| `raw` | **Long text** | — | PayApp 원본 페이로드 JSON 문자열 (감사/디버깅) |
| `status` | **Single select** | 옵션: `paid`, `refunded`, `failed` · 기본 `paid` | |

**Pabbly가 보장하는 것**:
- 같은 `mul_no` 중복 차단 (페이앱 3~5회 재전송 안전)
- pay_state ≠ "4"인 알림 무시
- 챕터 매칭 실패 시 `UnknownPayments`로 우회
- Airtable 쓰기 실패 시 `FailedPayments`로 우회

**여기 행이 추가되면 Automation C1이 자동 발사** → ChapterAccess +30일.

---

### A4. `OnepagePointTx`

포인트 변동 감사 로그. 모든 +/− 변동은 여기 1행 + `OnepageUsers.point` 동시 갱신.

| 필드명 | Airtable 필드 타입 | 옵션·기본값 | 비고 |
|---|---|---|---|
| `user_phone` | **Single line text** | — | |
| `delta` | **Number** → Integer (음수 허용) | — | 예: +1000, -3000. "Allow negative" 체크 ✅ |
| `reason` | **Single select** | 옵션: `referral_referrer`, `referral_referee`, `redeem_chapter`, `admin_bonus`, `event_reward`, `apology`, `refund`, `custom` | CRM 관리자 지급은 admin_bonus 외 4종 |
| `ref_user_phone` | **Single line text** | — | 추천 보너스일 때 상대 phone |
| `ref_chapter_id` | **Number** → Integer | — | 챕터 연장에 사용한 경우 |
| `balance_after` | **Number** → Integer | — | 변동 후 잔액 (감사용) |
| `memo` | **Single line text** | — | 선택. CRM 관리자 지급 시 `[관리자:이름] 메모` 형식으로 자동 prefix |
| `created_at` | **Created time** (auto) | 자동 채움 | |

---

### A5. `OnepageCampaigns`

CRM의 QR 코드 + 추적 URL 생성기 라이브러리. 관리자가 저장한 캐페인을 서버에 영구 보관 → 모든 기기·관리자 공유.

| 필드명 | Airtable 필드 타입 | 옵션·기본값 | 비고 |
|---|---|---|---|
| `name` | **Single line text** | — | 라이브러리에 표시할 짧은 라벨 (예: "A고 봄전단지 디자인B") |
| `utm_source` | **Single line text** | — | flyer, youtube, instagram, kakao, blog 등 |
| `utm_medium` | **Single line text** | — | qr, video, bio, banner, email 등 |
| `utm_campaign` | **Single line text** | — | school-A, spring2026, launch-week 등 |
| `utm_content` | **Single line text** | — | A/B 디자인 변형 (design-A, design-B) |
| `utm_term` | **Single line text** | — | 키워드 (선택) |
| `notes` | **Long text** | — | "이 디자인은 ~한 식으로 배포함" 같은 메모 |
| `created_by_name` | **Single line text** | — | 저장한 관리자 이름 (자동) |
| `created_by_phone` | **Single line text** | — | 저장한 관리자 phone (자동) |
| `created_at` | **Created time** (auto) | 자동 채움 | |

**용도**: 같은 캐페인을 다시 만들 때 라이브러리에서 한 번 클릭 → QR 자동 재생성. 팀원 간 공유 가능 (모든 관리자가 같은 라이브러리 보기).

**권장 뷰**
- `최근 저장` — created_at 내림차순 (기본)
- `내가 만든 것` — created_by_phone = 내 phone
- `소스별` — utm_source로 그룹

**Worker 엔드포인트**: `GET/POST /admin/campaigns`, `PUT/DELETE /admin/campaigns/:id` (teacher gate)

---

### A6. `OnepageCampaignSends`

캐페인 발송 로그. CRM에서 `/admin/webhook/send` 호출 → Worker가 수신자 **1명당 1행** 영구 저장. 분석·전환 측정의 단일 진실원본.

| 필드명 | Airtable 필드 타입 | 옵션·기본값 | 비고 |
|---|---|---|---|
| `campaign_id` | **Single line text** | — | 한 번의 `/admin/webhook/send` 호출이 생성한 UUID — 같은 발송의 모든 수신자가 공유 (`crypto.randomUUID()` 또는 fallback `cmp_{ts}_{rand}`) |
| `template` | **Single line text** | — | `welcome` / `renewal` / `winback` / `convert` / `vip` / `custom` |
| `channel` | **Single line text** | — | `sms` / `email` / `both` |
| `subject` | **Single line text** | — | 이메일 제목 (SMS만이면 비어 있음) |
| `custom_message` | **Long text** | — | 관리자가 CRM에서 입력한 본문 — Pabbly의 ChatGPT 프롬프트 인풋으로 전달 |
| `sent_at` | **Single line text** | — | KST ISO 8601 (예: `2026-06-04T15:30:00.000Z` — Z는 표기상, 실제 KST) |
| `sent_by` | **Single line text** | — | 발송한 관리자 이름 또는 phone (JWT 인증된 sender) |
| `phone` | **Single line text** | — | 수신자 전화번호 (SMS/both 시 사용) |
| `email` | **Single line text** | — | 수신자 이메일 (email/both 시 사용) |
| `recipient_name` | **Single line text** | — | 발송 시점의 사용자 이름 스냅샷 |
| `ok` | **Checkbox** | — | Pabbly가 200 OK 반환했는지 (true) — 실제 SOLAPI/Gmail 전송 성공이 아니라 webhook 수락만 의미 |
| `status_code` | **Number** → Integer | — | Pabbly 응답 HTTP status |
| `error` | **Long text** | — | 실패 시 메시지 (`user_not_found` 등) |

**저장 정책**: 실패해도 `console.warn`만 찍고 발송 자체는 성공 응답. 테이블이 없거나 PAT 권한 없으면 분석 endpoint가 `{ok:false, error:'campaign_table_missing'}` 반환.

**Worker 엔드포인트**:
- `POST /admin/webhook/send` (teacher gate) — 발송 + 자동 저장 (batch 10건씩)
- `GET /admin/campaign-sends?days=N` (teacher gate) — 발송 분석 (일별/템플릿별/채널별 + 캠페인 히스토리)
- `GET /admin/campaign-conversion?days=N&window=M` (teacher gate) — 전환 분석 (발송 후 M일 안 결제 매칭)

---

### A7. `UnknownPayments`

Pabbly 결제 라우터의 **폴백 1** — 상품명(`goodname`)이 어떤 챕터와도 매칭 안 될 때 여기로 우회.

> ⚠️ **운영 시 정상 상태는 0행에 가까움**. 행이 늘면 상품명 vs chapter.title 불일치 점검 필요.

| 필드명 | Airtable 필드 타입 | 옵션·기본값 | 비고 |
|---|---|---|---|
| `mul_no` | **Single line text** | — | PayApp 거래번호 (멱등성 키) |
| `goodname` | **Single line text** | — | 매핑 실패한 상품명 — 신규 상품/오타/다른 사업 결제 등 |
| `phone` | **Single line text** | — | 결제자 (recvphone/buyer_phone) |
| `email` | **Email** | — | buyer_email |
| `amount` | **Currency** (KRW, ₩, 소수점 0자리) | — | price |
| `raw` | **Long text** | — | 페이앱 원본 페이로드 JSON |
| `received_at` | **Created time** (auto) | 자동 채움 | Airtable 시스템 필드 (수동 입력 불가) |
| `notes` | **Long text** | 기본 `"Unknown product — needs manual classification"` | Pabbly가 자동 세팅 |
| `resolved` | **Checkbox** | — | 수동 분류 완료 표시 |

**운영 작업 흐름**:
1. 매주 미해결(`resolved` 미체크) 행 검토
2. 상품명이 챕터 제목과 맞으면 → 챕터 제목 수정 또는 Pabbly 라우터 매칭 로직에 키워드 추가
3. 다른 사업 결제면 → 해당 사업의 Airtable base로 수동 이관
4. 처리 후 `resolved` 체크

---

### A8. `FailedPayments`

Pabbly 결제 라우터의 **폴백 2 (안전망)** — Airtable 쓰기가 어떤 이유로든 실패할 때 여기로 우회.

> ℹ️ v2(Worker 결제)부터는 이 테이블이 사용되지 않음. 옛 데이터 보관 + 향후 비슷한 폴백 도입 시 재활용 목적.

> 🚨 **운영 시 정상 상태는 0행**. 행이 늘면 Airtable 토큰·권한·네트워크·필드명 등 시스템 장애.

| 필드명 | Airtable 필드 타입 | 옵션·기본값 | 비고 |
|---|---|---|---|
| `mul_no` | **Single line text** | — | PayApp 거래번호 |
| `goodname` | **Single line text** | — | 상품명 |
| `phone` | **Single line text** | — | 결제자 |
| `email` | **Email** | — | |
| `amount` | **Currency** (KRW, ₩, 소수점 0자리) | — | |
| `raw` | **Long text** | — | 페이앱 원본 페이로드 (수동 재처리용) |
| `error_message` | **Long text** | — | Airtable 또는 라우터 에러 메시지 (예: `"Airtable error 404: NOT_FOUND"`) |
| `retry_count` | **Number** → Integer | 기본 `0` | 수동 재실행 횟수 |
| `created_at` | **Created time** (auto) | 자동 채움 | 실패 시각 |
| `resolved` | **Checkbox** | — | 수동 재처리 완료 표시 |

**복구 흐름** (행 발생 시):
1. `error_message` 확인 → 원인 파악 (예: Airtable 토큰 만료, 필드 누락, 네트워크)
2. 근본 원인 수정 (Pabbly Secret 갱신, 필드 추가 등)
3. `raw` JSON을 보고 OnepagePayments에 수동으로 행 추가 (mul_no 보존)
   → C1 Automation이 자동 발사되어 ChapterAccess 갱신
4. `retry_count`를 1 증가시키고 `resolved` 체크

**Pabbly 항상 200 OK 응답 보장**: 이 테이블에 행이 추가됐어도 페이앱에는 정상 응답 → retry-storm 없음.

---

## B. nocodebackend 테이블 (`55910_flashcard_app`)

nocodebackend.com 의 "Add Field" UI에서 선택할 타입을 명시. 대응되는 SQL 타입도 표기.

### nocodebackend 필드 타입 매핑 (`55910_flashcard_app` 기준)

Type 드롭다운에 보이는 옵션: `INT`, `BIGINT`, `VARCHAR(255)`, `DROPDOWN`, `TEXT`, `PASSWORD`, `BOOLEAN`, `DATE`, `DATETIME`, `TIMESTAMP`, `FLOAT`, `DOUBLE`, `DECIMAL(10,2)`, `JSON`

우리가 쓰는 매핑:

| 용도 | 선택할 타입 | 실제 저장 |
|---|---|---|
| **FK 컬럼** (chapter_id, topic_id 등 — id를 가리킴) | **`INT`** ★ | INT |
| 일반 정수 (가격, order, count) | **`INT`** | INT |
| 짧은 문자열 (제목·이름·이모지·phone) | **`VARCHAR(255)`** | VARCHAR(255) |
| 중간 본문 (description, item.text) | **`TEXT`** | TEXT (64KB) |
| 큰 데이터 (이미지 base64) | **`JSON`** | LONGTEXT (4GB) |
| Yes/No | **`BOOLEAN`** | TINYINT(1) |
| 날짜만 | **`DATE`** | DATE |
| 날짜+시각 | **`DATETIME`** | DATETIME |

> **★ FK는 `INT`** — nocodebackend의 Run SQL은 `id` 정의를 무시하고 자동으로 `int(11)`로 만든다 (UI로 만들면 `bigint(20) unsigned`). 우리는 모든 테이블을 **Run SQL로 통일** → id가 int(11)이니 FK도 INT여야 매칭됨. BIGINT로 만들면 `errno 150 "Foreign key constraint is incorrectly formed"` 에러.

> **주의 1**: nocodebackend의 `JSON` 타입을 선택하면 저장 시 `LONGTEXT`로 표시됨 — 큰 base64 문자열 보관용으로 그대로 활용.
> **주의 2**: `DROPDOWN`은 안 씀 — `subject`(수학/영어/한국사)는 선생님이 새로 추가할 수 있어야 해서 자유 입력 VARCHAR.
> **주의 3**: `id`는 모든 테이블에 자동 생성됨 — 따로 만들지 않음.

### 컬럼별 체크박스 (스크린샷의 옵션)

| 체크박스 | 언제 체크 | 효과 |
|---|---|---|
| **Not null** | 비어 있으면 안 되는 모든 필드 | NULL 금지 |
| **Unique** | `op_pings.user_phone` 등 | UNIQUE 제약 + 인덱스 자동 생성 |
| **Foreign key** | `chapter_id`, `topic_id`, `subtopic_id` | FK 제약 + 인덱스 자동 생성. Reference table·column·On delete 설정 필요 |

### FK 설정 (cascade)

| FK 컬럼 | Reference table | Reference column | On delete | On update |
|---|---|---|---|---|
| `op_topics.chapter_id` | `op_chapters` | `id` | **CASCADE** | RESTRICT |
| `op_subtopics.topic_id` | `op_topics` | `id` | **CASCADE** | RESTRICT |
| `op_items.subtopic_id` | `op_subtopics` | `id` | **CASCADE** | RESTRICT |
| `op_understood.subtopic_id` | `op_subtopics` | `id` | **CASCADE** | RESTRICT |

→ On delete CASCADE: 챕터 삭제 시 그 아래 모든 행이 자동 정리. 고아 데이터 방지.

---

### B1. `op_chapters` (챕터)

| 필드명 | 타입 | Not null | FK/Unique | Default | 비고 |
|---|---|---|---|---|---|
| `subject` | VARCHAR(255) | ✅ | — | — | "수학" / "영어" / "한국사" 등 |
| `title` | VARCHAR(255) | ✅ | — | — | "미분", "관계대명사" 등 |
| `order` | INT | ✅ | — | `0` | 같은 subject 내 표시 순서 |
| `icon` | VARCHAR(255) | — | — | — | 이모지 1~2자 |
| `description` | TEXT | — | — | — | 카드 부제 |
| `monthly_price` | INT | ✅ | — | `3000` | 원 단위 |
| `is_all_free` | BOOLEAN | ✅ | — | `0` | 1이면 챕터 전체 무료 |
| `is_published` | BOOLEAN | — | — | `1` | **0이면 비공개(draft)** — 학생 `/chapters` 응답에서 제외. 선생님 앱은 모두 노출. 신규 챕터는 선생님 앱에서 0으로 생성. 컬럼이 없거나 NULL이면 공개로 간주 (기존 데이터 호환). |
| `pay_url` | VARCHAR(255) | — | — | — | **(deprecated v2)** 옛 정적 QR 링크 저장용. v2 (Worker REST)부터 사용 안 함 — Worker가 결제 시 동적으로 PayApp 세션 생성. 컬럼은 fallback·마이그레이션 안전을 위해 보존. |
| `updated_at` | DATETIME | — | — | — | Worker가 갱신 |

> **주의 — `order`는 MySQL 예약어**: 모든 테이블의 `sort_order` 컬럼은 처음부터 `sort_order`로 만들어야 합니다 — `order`로 만들면 REST API의 `?order=` 파라미터와 충돌. 이미 `order`로 만드셨으면:
> ```sql
> ALTER TABLE op_chapters CHANGE `order` `sort_order` INT NOT NULL DEFAULT 0;
> ```

> **마이그레이션 (`pay_url`)**: 기존 테이블이면
> ```sql
> ALTER TABLE op_chapters ADD COLUMN pay_url VARCHAR(255) NULL;
> ```

> **마이그레이션 (`is_published`)**: 기존 챕터를 모두 공개로 유지하려면
> ```sql
> ALTER TABLE op_chapters ADD COLUMN is_published TINYINT(1) NOT NULL DEFAULT 1;
> ```
> NULL 허용으로 만들 경우 Worker가 NULL을 공개로 간주하지만, 명시적 DEFAULT 1이 더 안전.

---

### B2. `op_topics` (목차)

| 필드명 | 타입 | Not null | FK/Unique | Default | 비고 |
|---|---|---|---|---|---|
| `chapter_id` | INT | ✅ | **FK → op_chapters.id (CASCADE)** | — | nocodebackend Run SQL의 id가 int(11)이므로 FK도 INT |
| `title` | VARCHAR(255) | ✅ | — | — | |
| `sort_order` | INT | ✅ | — | `0` | (예약어 `order` 회피) |
| `is_free` | BOOLEAN | ✅ | — | `0` | 1이면 비구독자에게도 공개 |
| `updated_at` | DATETIME | — | — | — | |

---

### B3. `op_subtopics` (학습 카드)

| 필드명 | 타입 | Not null | FK/Unique | Default | 비고 |
|---|---|---|---|---|---|
| `topic_id` | INT | ✅ | **FK → op_topics.id (CASCADE)** | — | INT (Run SQL의 id에 맞춤) |
| `title` | VARCHAR(255) | ✅ | — | — | |
| `sort_order` | INT | ✅ | — | `0` | (예약어 `order` 회피) |
| `image_b64` | **LONGTEXT** | — | — | — | 학습 카드 대표 이미지 (펼치지 않아도 표지로 보임). data URL 형식 |
| `caption` | VARCHAR(255) | — | — | — | 이미지 캡션 (선택) |
| `updated_at` | DATETIME | — | — | — | |

> **마이그레이션**: 기존 테이블이면 다음 SQL 실행
> ```sql
> ALTER TABLE op_subtopics ADD COLUMN image_b64 LONGTEXT NULL;
> ALTER TABLE op_subtopics ADD COLUMN caption VARCHAR(255) NULL;
> ```

---

### B4. `op_items` (내용 블록 — 텍스트/이미지/링크)

| 필드명 | 타입 | Not null | FK/Unique | Default | 비고 |
|---|---|---|---|---|---|
| `subtopic_id` | INT | ✅ | **FK → op_subtopics.id (CASCADE)** | — | INT (Run SQL의 id에 맞춤) |
| `kind` | VARCHAR(255) | ✅ | — | — | `'text'` / `'image'` / `'link'` |
| `text` | TEXT | — | — | — | `kind='text'` → 본문 (마크다운). `kind='link'` → URL. `kind='image'` 면 빈값 |
| `image_b64` | **LONGTEXT** | — | — | — | image 블록의 data URL. **JSON 타입이 base64 문자열을 거부하므로 LONGTEXT 사용**. UI에 LONGTEXT 옵션이 없으면 일단 JSON으로 만든 뒤 `ALTER TABLE op_items MODIFY image_b64 LONGTEXT NULL;` |
| `caption` | VARCHAR(255) | — | — | — | 작은 설명 라인. **모든 kind에서 사용** — image 캡션 / link 제목·설명 / text 보조 설명 |
| `sort_order` | INT | ✅ | — | `0` | 같은 학습 카드 안 순서 (예약어 `order` 회피) |
| `updated_at` | DATETIME | — | — | — | |

> **이미지 크기 주의**: 클라이언트(선생님 앱)에서 최대 폭 1200px · WebP 0.85로 압축 후 base64 인코딩. 일반 50~150KB. 300KB 초과 시 경고.

> **`kind='link'` URL 분기 (학생 앱 렌더링)**:
> - `play.gumlet.io/...` → 16:9 iframe 임베드
> - YouTube (`watch?v=`, `youtu.be/`, `shorts/`) → 빨간 링크 카드 + 썸네일 → 클릭 시 새 탭 (정책상 임베드 X)
> - 그 외 → 시안 링크 카드 → 새 탭
> 프로토콜 누락(`google.com`) 시 렌더 시점에 `https://` 자동 prepend.

> **`kind='text'` 안의 URL 자동 링크**: `autolinkText()` 가 `http(s)://` / `www.` 패턴을 `<a class="inline-link">` 로 감쌈. 기존 데이터에도 즉시 적용.

---

### B5. `op_understood` (학생 이해 표시)

| 필드명 | 타입 | Not null | FK/Unique | Default | 비고 |
|---|---|---|---|---|---|
| `user_phone` | VARCHAR(255) | ✅ | — | — | 회원 phone (정규화) |
| `subtopic_id` | INT | ✅ | **FK → op_subtopics.id (CASCADE)** | — | INT (Run SQL의 id에 맞춤) |
| `marked_at` | DATETIME | ✅ | — | — | KST |

**복합 유니크**: `(user_phone, subtopic_id)` — nocodebackend가 복합 유니크를 UI에서 지원하지 않으면 Worker가 upsert 전 검색으로 확인.

---

### B6. `op_pings` (오늘 학습자 카운트)

| 필드명 | 타입 | Not null | FK/Unique | Default | 비고 |
|---|---|---|---|---|---|
| `user_phone` | VARCHAR(255) | ✅ | **Unique ✅** | — | 사용자당 1행 |
| `first_ping_today` | DATE | ✅ | — | — | KST 날짜 |
| `last_ping_at` | DATETIME | — | — | — | 디버깅용 |

> 클라이언트가 60초마다 ping → Worker가 `first_ping_today < 오늘`이면 오늘 날짜로 덮어씀. `/stats/learners-now`는 `first_ping_today = 오늘`인 행 수를 카운트.

---

## C. Airtable Automations (사용자님이 설정)

Worker는 결제·추천보너스 처리에 관여하지 않습니다. 모두 Airtable Automation에서.

### C1. 결제 → ChapterAccess +30일 (Run a script 단일 액션)

**Conditional logic 분기 대신 Script 하나로 통일** — 가독성·디버깅·재사용성 모두 우수.

**Trigger**:
- Type: `When a record is created`
- Table: `OnepagePayments`
- (선택) Condition: `status = paid`

**Action — Run a script**:

**Input variables** (4개, 트리거 필드에서 매핑):
| Script 변수명 | 트리거 필드 |
|---|---|
| `user_phone` | OnepagePayments.user_phone |
| `chapter_id` | OnepagePayments.chapter_id |
| `chapter_title` | OnepagePayments.chapter_title |
| `mul_no` | OnepagePayments.mul_no |

**Script 코드**:

```javascript
const config = input.config();
const userPhone    = String(config.user_phone || "").trim();
const chapterId    = Number(config.chapter_id);
const chapterTitle = String(config.chapter_title || "").trim();
const mulNo        = String(config.mul_no || "").trim();
const ADD_DAYS = 30;

if (!userPhone || !chapterId) {
    console.log(`⚠️ 필수 입력 누락 — user_phone='${userPhone}', chapter_id='${chapterId}'`);
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

// 활성(미래)이면 기존 만료일부터, 만료/신규면 NOW부터 +30일
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
    console.log(`✓ 갱신: ${userPhone} × #${chapterId} (${chapterTitle})`);
    console.log(`   만료일 → ${newExpiresIso.slice(0, 10)}`);
} else {
    const newId = await table.createRecordAsync({
        "user_phone": userPhone,
        "chapter_id": chapterId,
        "chapter_title": chapterTitle,
        "expires_at": newExpiresIso,
        "last_payment_id": mulNo,
        "source": { name: "purchase" },
    });
    console.log(`+ 신규: ${userPhone} × #${chapterId} (${chapterTitle})`);
    console.log(`   만료일 → ${newExpiresIso.slice(0, 10)}`);
    console.log(`   record ID: ${newId}`);
}
```

**시나리오별 결과**:

| 학생 상황 | 기존 expires_at | 동작 |
|---|---|---|
| 첫 결제 | (행 없음) | CREATE → NOW + 30일 |
| 활성 중 재결제 (D-12) | 12일 후 | UPDATE → 기존 + 30일 = D-42 (누적) |
| 만료 후 재결제 | 30일 전 (만료) | UPDATE → NOW + 30일 (재시작) |

**API 주의** (Scripting Extension vs Automation Script):
- ✅ Automation `Run a script`: `console.log()` 사용
- ❌ Scripting Extension: `output.text()` 사용 (자동화에선 작동 X)

**Single select 필드**: 값 전달 시 객체 형태 — `{ name: "purchase" }`. 문자열 직접 전달 X.

### C2. 결제 → 첫 결제이면 추천 보너스 양쪽 +1000P

```
[트리거]   When record created in OnepagePayments (status = paid)
[액션 1]   Find OnepageUsers where phone = {payment.user_phone}
[조건]    user.first_paid_at is empty   ← 첫 결제만
[액션 2]   Update user: first_paid_at = NOW()
[조건]    user.referred_by_code is not empty
[액션 3]   Find OnepageUsers where referral_code = {user.referred_by_code}
            → referrer
[액션 4]   Update referrer: point = point + 1000
          Update user:     point = point + 1000
[액션 5]   Create 2 rows in OnepagePointTx:
          - { user_phone: referrer.phone, delta: +1000,
              reason: 'referral_referrer',
              ref_user_phone: user.phone,
              balance_after: referrer.point,
              created_at: NOW() }
          - { user_phone: user.phone, delta: +1000,
              reason: 'referral_referee',
              ref_user_phone: referrer.phone,
              balance_after: user.point,
              created_at: NOW() }
```

### C3. (사용자님 자체 구현) 만료 1일 전 알림

스펙 외. 사용자님이 따로 구현.

---

## D. Worker가 만드는 행

다음 경우에는 Worker가 nocodebackend / Airtable에 행을 직접 만들거나 갱신함:

| 트리거 | 대상 | 동작 |
|---|---|---|
| 회원가입 | OnepageUsers | 신규 행 생성 (Worker가 referral_code 생성·중복 확인) |
| 학습 카드 꾹누르기 | op_understood | upsert (이미 있으면 행 삭제 = 토글) |
| 60초 ping | op_pings | upsert (user_phone로 찾아 first_ping_today 갱신) |
| 선생님이 콘텐츠 CRUD | op_chapters/topics/subtopics/items | 일반 CRUD |
| 일괄 입력 (TSV) | op_topics/subtopics/items 한꺼번에 | append 또는 replace 모드 |
| 포인트로 챕터 연장 | OnepageChapterAccess + OnepageUsers + OnepagePointTx | 트랜잭션처럼 3개 행 동시 갱신 |

---

## E. 선생님 계정 만드는 법

1. 일반 학생처럼 가입 (앱 회원가입 폼)
2. Airtable OnepageUsers에서 해당 행 찾기
3. `role` 컬럼을 `student` → `teacher`로 수동 변경
4. 그 계정으로 다음 로그인 → 선생님 편집 메뉴 자동 노출

---

## F. 다음 단계

이 스키마대로 테이블 만들기:

1. **Airtable**: 위 6개 테이블(`OnepageUsers`, `OnepageChapterAccess`, `OnepagePayments`, `OnepagePointTx`, `OnepageCampaigns`, `OnepageCampaignSends`)
2. **nocodebackend**: 위 6개 테이블(`op_chapters`, `op_topics`, `op_subtopics`, `op_items`, `op_understood`, `op_pings`)
3. **Airtable Automations**: C1·C2 두 개 설정
4. **Worker 환경 변수**: NCB_SECRET_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE, JWT_SECRET (필수) + **PABBLY_WEBHOOK_URL** (CRM 캐페인 발송용, 선택)
5. 테이블 다 만들고 nocodebackend Instance ID·Airtable Base ID·Airtable Token 확인 → Worker로 진행

---

## G. 마이그레이션 SQL 요약 (기존 설치에 추가된 컬럼·테이블)

**Airtable 신규 필드 (`OnepageUsers`)**:
- UTM 7개 (어트리뷰션): `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` → Single line text · `landing_url`, `referrer_url` → Long text
- **`interests`** → Long text (관심 주제 — 콤마 구분. 가입 시 URL 캡쳐 또는 학생 앱 모달에서 편집)

**Airtable 신규 테이블**:
- `OnepageCampaigns` (A5 참조) — CRM QR 라이브러리
- `UnknownPayments` (A6 참조) — Pabbly 라우터 폴백 (상품 미매핑)
- `FailedPayments` (A7 참조) — Pabbly 라우터 안전망 (Airtable 쓰기 실패)

**nocodebackend 신규 컬럼** (`op_chapters`):
```sql
ALTER TABLE op_chapters ADD COLUMN pay_url VARCHAR(255) NULL;
```

---

## H. Pabbly Connect 워크플로우 (마케팅 발송용)

v2부터 결제 처리는 **Worker로 이전**. Pabbly는 **마케팅 발송**에만 사용.

### H1. 마케팅 캐페인 발송 워크플로우 (현재 사용 중 — Pabbly Connect)

**플랫폼**: `connect.pabbly.com` (AgenticAI 아님 — v1의 agenticai.pabbly.com 워크플로우는 deprecated)
**트리거 URL**: Worker secret `PABBLY_WEBHOOK_URL`에 저장

**5단계 구조**:

| Step | 종류 | 역할 |
|---|---|---|
| 1 | Webhook (Catch Webhook) | Worker `/admin/webhook/send` 페이로드 수신 |
| 2 | OpenAI ChatGPT | `gpt-3.5-turbo` 모델, system+user messages JSON, Response Format=Text, Max Tokens 250, Sampling 0.7 → 마케팅 본문 생성 |
| 3 | Router by Pabbly | 2갈래 분기 (Route 1 SMS / Route 2 Email) |
| 4A | Filter (SMS) | `{{1.channel}}` Equal to `sms` OR `both` |
| 4B | Filter (Email) | `{{1.channel}}` Equal to `email` OR `both` |
| 5A | SOLAPI (Private) — Send Text Message | 발신번호=Solapi 등록필수, `{{1.phone}}`, 본문=`{{2.choices.0.message.content}}` |
| 5B | Gmail — Send Email | Sender=OnePage Study, Recipient=`{{1.email}}`, Subject=`[OnePage Study] {{1.subject}}`, Content Type=HTML |

**자격증명 (Pabbly Connections에 보관)**:
- OpenAI API Key (ChatGPT용)
- Solapi API Key + Secret + 등록 발신번호
- Gmail OAuth (발신 계정)

**제약**:
- Gmail API: 일일 100건 — 대량 발송 시 SendGrid/Mailgun 등으로 갈아탈 것
- SOLAPI: 발신번호 사전 등록 필수 (https://console.solapi.com/senderids)
- SMS 본문 90바이트 초과 시 자동 LMS 전환 (단가 ↑)

자세한 워크플로우 구축 절차는 [ONEPAGE_FEATURES.md § 18](ONEPAGE_FEATURES.md#18-캐페인-발송-pabbly-웹훅) 참조.

### H2. (deprecated v1) 결제 라우터 워크플로우
v1에서 사용했던 Pabbly Connect 5단계 라우터. v2 (Worker REST)로 대체되어 **OFF 처리 권장**.

마이그레이션 후 정리:
1. Pabbly 워크플로우 OFF (또는 삭제)
2. Pabbly에 저장된 Airtable PAT **revoke** + 새 PAT 발급 (만약 마케팅 워크플로우 등에서 쓴다면 Pabbly Secret으로 재등록)
3. 페이앱 콘솔의 공통 통보 URL **비움** (Worker가 동적 feedbackurl 사용)

## I. PayApp 결제 처리 (v2 — 현재)

Worker가 직접 PayApp REST API + webhook 수신을 모두 처리.

### Worker 엔드포인트 — 결제
- **`POST /payment/request`** — 학생 앱이 호출, 결제 세션 생성 (var1=chapter_id, var2=user_phone 포함)
- **`POST /payapp/webhook`** — PayApp이 결제 완료 시 호출, OnepagePayments INSERT, `SUCCESS` 응답

### Worker 엔드포인트 — 관리자 권한 관리 (CRM)
- **`POST /admin/access/grant`** — 챕터 권한 수동 지급/연장
  - Body: `{ user_phone, chapter_id, days, reason?, memo? }`
  - 활성 사용자: 기존 expires_at + N일 (누적)
  - 만료/신규: NOW + N일
  - `source` 자동 `"admin_grant"`로 세팅
  - `last_payment_id`: `ADMIN-{관리자이름}-{timestamp36}` 형식
- **`DELETE /admin/access/:phone/:chapter_id`** — 챕터 권한 회수
  - OnepageChapterAccess 행 즉시 삭제

### Worker 엔드포인트 — 캐페인 발송·분석 (CRM)
- **`POST /admin/webhook/send`** — 캐페인 일괄 발송
  - Body: `{ phones[], template, channel, custom_message, subject, webhook_url? }`
  - Pabbly로 1명씩 POST + 결과를 OnepageCampaignSends에 batch 저장
  - 응답: `{ ok, campaign_id, sent_at, sent, total, results[] }`
- **`GET /admin/campaign-sends?days=N`** — 발송 분석
  - 응답: `{ total_sends, success_count, success_rate, campaign_count, by_channel, by_template, by_day[], campaigns[] }` — campaigns는 campaign_id로 그룹된 어레이 (recipients 포함)
- **`GET /admin/campaign-conversion?days=N&window=M`** — 전환 분석
  - 발송 후 M일 안에 같은 phone이 결제했으면 전환
  - 응답: `{ total_sends, total_conversions, conversion_rate, total_revenue, arpc, by_template, by_channel }`
  - 한계: 다중 노출 중복 카운트 / A/B 컨트롤 그룹 없음 / 자연 결제 분리 불가 (정밀화 옵션은 ONEPAGE_FEATURES.md §18 참조)

### Worker Secrets
```bash
npx wrangler secret put PAYAPP_USERID    # 페이앱 판매자 아이디 (필수)
npx wrangler secret put PAYAPP_LINKKEY   # 페이앱 연동 KEY (선택)
npx wrangler secret put PAYAPP_LINKVAL   # 페이앱 연동 VALUE (선택)
```

> ⚠️ `PAYAPP_LINKKEY`/`PAYAPP_LINKVAL`은 페이앱 콘솔의 정확한 값과 일치해야 함. 잘못된 값 등록 시 webhook이 silent skip될 수 있음 → 현재 코드는 불일치 시 경고 로그만 남기고 처리 진행 (silent skip 방지).

### PayApp 콘솔 설정
- 상품 등록: **불필요** (Worker가 매번 동적 생성)
- 공통 통보 URL: **비워둠** (개별 `feedbackurl`이 결제 시점에 동적 지정됨)
- 연동 KEY/VALUE: 설정 → 연동정보에서 확인 → Worker secret으로

자세한 흐름·트러블슈팅:
- [ONEPAGE_FEATURES.md § 5 결제 자동화 파이프라인](ONEPAGE_FEATURES.md#5-결제-자동화-파이프라인-worker-rest--airtable)
- **[PAYMENT_INTEGRATION_GUIDE.md](PAYMENT_INTEGRATION_GUIDE.md)** — 새 앱(memoryking-user.html 등)에 결제 시스템 통합 시 시행착오 없이 작업할 수 있는 종합 가이드

---

## J. Worker 운영 메모

### J1. ⚠️ nocodebackend `/read` 의 기본 `limit=10`

**중대 함정**: nocodebackend의 `/read/{table}` endpoint는 `limit` 파라미터를 지정하지 않으면 **최대 10건**만 반환. 모든 행을 보려면 명시적으로 큰 limit 필수.

**Worker 코드 규칙**: 모든 list 조회에 `limit=2000` 이상 명시.
```js
ncbRead(env, 'op_topics', `chapter_id=${cid}&limit=2000`)
ncbRead(env, 'op_chapters', 'limit=2000')
```

**증상 사례 (수정 완료, 커밋 `c615fa0`)**: 챕터에 토픽 100개를 만들었는데도 클라이언트에 10개만 표시됨 — `/topics?chapter_id=N` 조회 시 limit 누락. bulk import가 "11번째에서 멈추는" 환각이 발생했지만 실제로는 DB에 정상 저장, 표시만 잘렸음.

**점검할 곳**: `handleListChapters`, `handleListTopics`, `handleAdminOverview`, `handleAdminRevenue`, `handleAdminContentStats` 등 모든 list 응답 endpoint.

### J2. 드래그앤드롭 순서 변경 endpoint

Worker는 일괄 `sort_order` 갱신을 위한 3종 endpoint 제공. 모두 동일 패턴 `handleReorder(request, env, table)` 공유.

| 경로 | 대상 테이블 | Body |
|---|---|---|
| `POST /topics/reorder` | `op_topics` | `{ ordered_ids[], start_index }` |
| `POST /subtopics/reorder` | `op_subtopics` | 동일 |
| `POST /items/reorder` | `op_items` | 동일 |

- `ordered_ids`: 새 순서로 정렬된 ID 배열
- `start_index`: 클라이언트 청크 분할 시 오프셋 (기본 0)
- 동작: `sort_order = start_index + i + 1` 로 각 ID 업데이트
- 한 호출 최대 40개 (Cloudflare subrequest 한도). 클라이언트가 30개씩 청크로 호출.

**데이터 무결성**: 사용자의 `op_understood` 등은 `subtopic_id` 로 참조하므로 `sort_order` 변경에 영향 없음. 삭제 시 FK CASCADE로 자동 정리 (§A4·A5 참조).

### J3. bulk import (TSV) — 청크 처리 + 토픽 prepopulate

`POST /chapters/:id/bulk` 가 청크 단위로 반복 호출됨. 한 호출당 `MAX_REQ=40` subrequest로 제한 (Cloudflare 50 - 안전 마진 10).

**첫 호출(`start=0`)에서만**:
- 기존 토픽을 `topicMap`에 prepopulate → TSV에 동일 이름이 와도 중복 생성 X
- `replace` 모드면 기존 토픽 삭제 (FK CASCADE로 자식 자동 정리)

**파서 특이사항** (`tsvLines`):
- `"` 는 셀 첫 글자(파일 시작/`\t`/`\n` 직후)일 때만 quote 모드 시작
- 셀 중간의 stray `"` (예: `He said "hello"`)는 일반 문자로 처리 → 다음 행을 삼키지 않음
- Excel Alt+Enter 멀티라인 셀은 정상 지원

자세한 사용법은 [ONEPAGE_FEATURES.md § 12](ONEPAGE_FEATURES.md#12-일괄-입력-tsv) 참조.
