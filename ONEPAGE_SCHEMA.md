# Onepage — 테이블 스키마 정의서

원페이지 학습 서비스의 백엔드 스키마. **Airtable**(사람·돈 도메인) + **nocodebackend**(콘텐츠 도메인)로 분리.

- Airtable base: 기존 base 재사용, 테이블명 `Onepage*`
- nocodebackend Instance: `55910_flashcard_app` 재사용, 테이블명 `op_*`
- 모든 사용자 키는 **전화번호(숫자만, 예: `01012345678`)** — PayApp 결제 webhook과의 매칭 키

---

## A. Airtable 테이블

### A1. `OnepageUsers`

회원 마스터. 인증·포인트·추천의 단일 진실원본.

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
| `created_at` | **Created time** (auto) | 자동 채움 | Airtable 자동 필드 |

**유니크 제약 (Airtable 자체 unique 제약은 없으니 Worker에서 검사)**
- `phone` 유니크
- `email` 유니크
- `referral_code` 유니크 (충돌 시 재생성)

**권장 뷰**
- `전체 회원` — 기본
- `선생님` — role=teacher
- `추천왕` — point 내림차순

---

### A2. `OnepageChapterAccess`

(사용자 × 챕터)별 만료일. 만료 후 자동으로 무료 사용자 = 이 행이 만료된 행은 게이트가 거부.

| 필드명 | Airtable 필드 타입 | 옵션·기본값 | 비고 |
|---|---|---|---|
| `user_phone` | **Single line text** | — | 회원 매칭 키 (숫자만) |
| `chapter_id` | **Number** → Integer | — | nocodebackend `op_chapters.id` |
| `chapter_title` | **Single line text** | — | 가독성용 사본 (Airtable에서 보기 편하게) |
| `expires_at` | **Date** → Include time | — | **게이트의 기준 컬럼** |
| `last_payment_id` | **Single line text** | — | PayApp `mul_no` (포인트 사용 시 비어 있음) |
| `source` | **Single select** | 옵션: `purchase`, `point_redeem` | |
| `created_at` | **Created time** (auto) | 자동 채움 | |
| `updated_at` | **Last modified time** (auto) | 자동 채움 | |

**복합 유니크 (Worker에서 검사)**: `(user_phone, chapter_id)`

**권장 뷰**
- `활성` — expires_at > TODAY()
- `만료 임박 (D-3)` — expires_at >= TODAY() AND expires_at <= DATEADD(TODAY(),3,'days')
- `만료됨` — expires_at < TODAY()

---

### A3. `OnepagePayments`

PayApp webhook이 채울 결제 원장. **Worker는 읽지도 쓰지도 않음** — 사용자님 webhook 흐름이 단독 관리.

| 필드명 | Airtable 필드 타입 | 옵션·기본값 | 비고 |
|---|---|---|---|
| `mul_no` | **Single line text** | — | PayApp 결제번호. **유니크 (멱등 키)** — 같은 mul_no면 무시 |
| `user_phone` | **Single line text** | — | 결제자 휴대폰 (정규화) |
| `user_email` | **Email** | — | 선택 |
| `chapter_id` | **Number** → Integer | — | 결제 대상 챕터 id |
| `chapter_title` | **Single line text** | — | |
| `amount` | **Currency** (KRW, ₩, 소수점 0자리) | — | 결제 금액 (원) |
| `paid_at` | **Date** → Include time | — | 결제 완료 시각 |
| `raw` | **Long text** | — | PayApp webhook 원본 JSON 문자열 (감사/디버깅) |
| `status` | **Single select** | 옵션: `paid`, `refunded`, `failed` · 기본 `paid` | |

---

### A4. `OnepagePointTx`

포인트 변동 감사 로그. 모든 +/− 변동은 여기 1행 + `OnepageUsers.point` 동시 갱신.

| 필드명 | Airtable 필드 타입 | 옵션·기본값 | 비고 |
|---|---|---|---|
| `user_phone` | **Single line text** | — | |
| `delta` | **Number** → Integer (음수 허용) | — | 예: +1000, -3000. "Allow negative" 체크 ✅ |
| `reason` | **Single select** | 옵션: `referral_referrer`, `referral_referee`, `redeem_chapter`, `manual_admin` | |
| `ref_user_phone` | **Single line text** | — | 추천 보너스일 때 상대 phone |
| `ref_chapter_id` | **Number** → Integer | — | 챕터 연장에 사용한 경우 |
| `balance_after` | **Number** → Integer | — | 변동 후 잔액 (감사용) |
| `memo` | **Single line text** | — | 선택 |
| `created_at` | **Created time** (auto) | 자동 채움 | |

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
| `updated_at` | DATETIME | — | — | — | Worker가 갱신 |

> **주의 — `order`는 MySQL 예약어**: 모든 테이블의 `sort_order` 컬럼은 처음부터 `sort_order`로 만들어야 합니다 — `order`로 만들면 REST API의 `?order=` 파라미터와 충돌. 이미 `order`로 만드셨으면:
> ```sql
> ALTER TABLE op_chapters CHANGE `order` `sort_order` INT NOT NULL DEFAULT 0;
> ```

---

### B2. `op_topics` (대목차)

| 필드명 | 타입 | Not null | FK/Unique | Default | 비고 |
|---|---|---|---|---|---|
| `chapter_id` | INT | ✅ | **FK → op_chapters.id (CASCADE)** | — | nocodebackend Run SQL의 id가 int(11)이므로 FK도 INT |
| `title` | VARCHAR(255) | ✅ | — | — | |
| `sort_order` | INT | ✅ | — | `0` | (예약어 `order` 회피) |
| `is_free` | BOOLEAN | ✅ | — | `0` | 1이면 비구독자에게도 공개 |
| `updated_at` | DATETIME | — | — | — | |

---

### B3. `op_subtopics` (소목차)

| 필드명 | 타입 | Not null | FK/Unique | Default | 비고 |
|---|---|---|---|---|---|
| `topic_id` | INT | ✅ | **FK → op_topics.id (CASCADE)** | — | INT (Run SQL의 id에 맞춤) |
| `title` | VARCHAR(255) | ✅ | — | — | |
| `sort_order` | INT | ✅ | — | `0` | (예약어 `order` 회피) |
| `updated_at` | DATETIME | — | — | — | |

---

### B4. `op_items` (내용 블록 — 텍스트/이미지)

| 필드명 | 타입 | Not null | FK/Unique | Default | 비고 |
|---|---|---|---|---|---|
| `subtopic_id` | INT | ✅ | **FK → op_subtopics.id (CASCADE)** | — | INT (Run SQL의 id에 맞춤) |
| `kind` | VARCHAR(255) | ✅ | — | — | `'text'` 또는 `'image'` |
| `text` | TEXT | — | — | — | text 블록 본문 (마크다운). image면 빈값 |
| `image_b64` | **LONGTEXT** | — | — | — | image 블록의 data URL. **JSON 타입이 base64 문자열을 거부하므로 LONGTEXT 사용**. UI에 LONGTEXT 옵션이 없으면 일단 JSON으로 만든 뒤 `ALTER TABLE op_items MODIFY image_b64 LONGTEXT NULL;` |
| `caption` | VARCHAR(255) | — | — | — | 이미지 캡션 |
| `order` | INT | ✅ | — | `0` | 같은 소목차 안 순서 |
| `updated_at` | DATETIME | — | — | — | |

> **이미지 크기 주의**: 클라이언트(선생님 앱)에서 최대 폭 1200px · WebP 0.85로 압축 후 base64 인코딩. 일반 50~150KB. 300KB 초과 시 경고.

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

### C1. 결제 → ChapterAccess upsert

```
[트리거]   When record created in OnepagePayments (status = paid)
[조건]    payment.status = 'paid'
[액션 1]   Find records in OnepageChapterAccess
          where user_phone = {payment.user_phone}
            and chapter_id = {payment.chapter_id}
[액션 2]   IF 결과 있음:
            Update: expires_at = MAX(NOW(), 기존 expires_at) + 30일
                    last_payment_id = {payment.mul_no}
                    source = 'purchase'
                    updated_at = NOW()
          ELSE:
            Create: user_phone, chapter_id, chapter_title,
                    expires_at = NOW() + 30일
                    last_payment_id = {payment.mul_no}
                    source = 'purchase'
                    created_at = NOW(), updated_at = NOW()
```

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
| 소목차 꾹누르기 | op_understood | upsert (이미 있으면 행 삭제 = 토글) |
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

1. **Airtable**: 위 4개 테이블(`OnepageUsers`, `OnepageChapterAccess`, `OnepagePayments`, `OnepagePointTx`)
2. **nocodebackend**: 위 6개 테이블(`op_chapters`, `op_topics`, `op_subtopics`, `op_items`, `op_understood`, `op_pings`)
3. **Airtable Automations**: C1·C2 두 개 설정
4. 테이블 다 만들고 nocodebackend Instance ID·Airtable Base ID·Airtable Token 확인 → Worker로 진행
