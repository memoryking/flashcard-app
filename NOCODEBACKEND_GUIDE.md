# nocodebackend 테이블 설정 가이드

`nocodebackend.com`에서 테이블을 만들 때 매번 헤매지 않기 위한 영구 레퍼런스. 다음 프로젝트(수학·영어·한국사 어떤 분야든)에서도 이 문서 하나로 끝낼 수 있도록 작성.

기준 Instance: `55910_flashcard_app` (`https://openapi.nocodebackend.com`)

---

## 1. 화면 흐름

```
nocodebackend 대시보드
  → Instance 선택 (예: 55910_flashcard_app)
  → "Edit: 55910_flashcard_app" 화면
  → 상단 메뉴: Back · Refresh · Create join · Run SQL · Generate ...
  → 좌측 또는 상단에서 [+ Add table] 버튼
  → "Add table" 모달:
       Table name : 영문 소문자·언더스코어 (예: op_topics)
       Columns    : 행마다 컬럼 1개씩 추가 (Column name / Type / Default / 체크박스)
       [Save]
```

> 테이블명 규칙: **소문자 + 언더스코어**. 공백·하이픈은 자동으로 `_`로 변환됨.

---

## 2. Type 드롭다운 옵션 (전체 13개 + 우리가 쓰는 것 7개)

### 드롭다운 전체 목록

| 옵션 | SQL 대응 | 우리가 쓰는가 |
|---|---|---|
| `INT` | INT | ✅ 모든 정수 (id, FK, 가격, order, count) |
| `BIGINT` | BIGINT | ❌ 우리 규모엔 과함 |
| `VARCHAR(255)` | VARCHAR(255) | ✅ 짧은 문자열 (제목·이름·이모지·phone·email) |
| `DROPDOWN` | ENUM 유사 | ❌ 옵션이 고정되어 확장성 떨어짐. VARCHAR로 자유 입력 권장 |
| `TEXT` | TEXT (≤64KB) | ✅ 중간 본문 (description, 일반 텍스트) |
| `PASSWORD` | (자동 해싱) | ❌ Worker가 PBKDF2 직접 처리. VARCHAR/TEXT 사용 |
| `BOOLEAN` | TINYINT(1) | ✅ Yes/No (`is_free`, `is_all_free`) |
| `DATE` | DATE | ✅ 날짜만 (YYYY-MM-DD) |
| `DATETIME` | DATETIME | ✅ 날짜+시각 |
| `TIMESTAMP` | TIMESTAMP | ❌ DATETIME과 거의 같음. DATETIME 통일 |
| `FLOAT` | FLOAT | ❌ 정밀도 부족 |
| `DOUBLE` | DOUBLE | ❌ 우리 데이터엔 불필요 |
| `DECIMAL(10,2)` | DECIMAL | ❌ 금액도 INT(원)으로 충분 |
| `JSON` | **LONGTEXT** | ✅ **큰 데이터(이미지 base64)** — JSON 컬럼이지만 디스크는 LONGTEXT |

### 우리가 자주 쓰는 7개 정리

| 용도 | 선택 |
|---|---|
| **FK 컬럼** (다른 테이블의 id를 가리킴) | **`BIGINT`** ★ |
| 일반 정수 카운트, 가격, order | `INT` |
| 제목·이름·이모지·phone·email·짧은 문자열 | `VARCHAR(255)` |
| 본문 텍스트 (마크다운 단락 등 ≤64KB) | `TEXT` |
| 큰 base64·긴 JSON | `JSON` (저장 시 LONGTEXT로 표시됨) |
| Yes/No | `BOOLEAN` |
| 날짜만 | `DATE` |
| 날짜+시각 | `DATETIME` |

> **★ FK 컬럼은 반드시 `BIGINT`**: nocodebackend가 자동 생성하는 `id`가 **`BIGINT(20) UNSIGNED`**이므로, 자식 FK 컬럼도 `BIGINT`여야 한다. `INT`로 만들면 MySQL이 다음 에러로 거부:
> ```
> errno: 150 "Foreign key constraint is incorrectly formed"
> ```

---

## 3. 컬럼 체크박스 3가지

각 컬럼 카드에 있는 체크박스:

| 체크박스 | 의미 | 언제 체크 |
|---|---|---|
| **Not null** | NULL 금지 | 비어 있으면 안 되는 모든 필수 필드 |
| **Unique** | UNIQUE 제약 + 인덱스 자동 생성 | phone, email, mul_no, referral_code 등 중복 금지 필드 |
| **Foreign key** | FK 제약 + 인덱스 자동 생성 | 다른 테이블을 가리키는 모든 컬럼 (chapter_id, topic_id 등) |

> **인덱스 별도 옵션 없음** — `Unique`와 `Foreign key` 체크박스가 자동으로 인덱스를 만들어주므로, 우리 스키마에서 검색하는 모든 컬럼이 자연스레 인덱싱됨.

---

## 4. Foreign Key (FK) 상세

`Foreign key` 체크박스를 누르면 하단에 4개 옵션이 펼쳐짐:

| 옵션 | 의미 | 우리 표준 |
|---|---|---|
| **Reference table** | 가리킬 대상 테이블 | 부모 테이블 선택 |
| **Reference column** | 그 테이블의 어느 컬럼을 가리키나 | 보통 `id` |
| **On delete** | 부모 행이 삭제될 때의 동작 | **CASCADE** (자식도 같이 삭제) |
| **On update** | 부모 PK가 변경될 때의 동작 | **RESTRICT** (PK는 보통 안 바뀌니까) |

### `On delete` 3가지의 차이 — 핵심

부모 행을 삭제하려는데 자식 행들이 가리키고 있는 경우:

| 선택 | 동작 | 사용처 |
|---|---|---|
| **CASCADE** | 자식 행도 자동 삭제 | **계층 구조(트리)** — 부모-자식이 운명 공동체일 때 |
| **RESTRICT** (기본값) | 자식이 있으면 삭제 **거부** | 자식이 살아 있어야 하는 마스터 데이터 |
| **SET NULL** | 자식의 FK 컬럼이 NULL이 됨 | "느슨한 참조" — 거의 안 씀 |

### 우리 프로젝트에서의 선택

| FK | On delete | 이유 |
|---|---|---|
| `op_topics.chapter_id` → `op_chapters.id` | CASCADE | 챕터 삭제 → 모든 대목차 자동 삭제 |
| `op_subtopics.topic_id` → `op_topics.id` | CASCADE | 대목차 삭제 → 모든 소목차 자동 삭제 |
| `op_items.subtopic_id` → `op_subtopics.id` | CASCADE | 소목차 삭제 → 모든 내용 자동 삭제 |
| `op_understood.subtopic_id` → `op_subtopics.id` | CASCADE | 소목차 삭제 → 그 진도도 정리 |

→ 모두 트리 구조이므로 **CASCADE 통일**. 챕터 한 줄만 지우면 그 아래 수백 행이 깔끔하게 정리됨.

---

## 5. 자동 생성 컬럼 — `id`

- 모든 테이블에 **`id` 컬럼(BIGINT, PK, AUTO_INCREMENT)이 자동으로** 만들어짐
- 우리가 명시적으로 만들 필요 없음
- `id`는 Worker에서 PK·FK 매칭 키로 사용

---

## 6. `JSON` 타입의 실제 동작

JSON 컬럼은 디스크에 **LONGTEXT**로 저장되며, **유효한 JSON 값이면 뭐든 받음** — 문자열·숫자·객체·배열 다 OK.

### 저장 예시 (실제 운영 중인 user_vocab.data)

```json
{"approach":[1,"2026-05-25T21:38:59.877Z",...],"customer":[1,...], ...}
```

### Worker에서의 호출 — 자동 처리

```js
// 보내는 쪽
fetch('/create/op_items', {
  body: JSON.stringify({
    subtopic_id: 5,
    kind: 'image',
    image_b64: 'data:image/webp;base64,iVBOR...'   // ← 그냥 문자열
  })
})

// 받는 쪽
const res = await fetch('/read/op_items?subtopic_id=5');
const items = (await res.json()).data;
// items[0].image_b64 === 'data:image/webp;base64,iVBOR...'   ← 그대로 복원
```

DB에 저장되는 모습 (JSON 인코딩됨):
```
"data:image/webp;base64,iVBOR..."
```

→ **Worker가 따로 `JSON.stringify`/`JSON.parse` 할 필요 없음**. REST 레이어가 자동 처리.

### 함정
- `TEXT`는 64KB 한계 — 이미지 base64는 50~150KB라 잘릴 위험 → 반드시 `JSON`(LONGTEXT) 선택
- `JSON` 컬럼을 SQL에서 검색할 일 있으면 MySQL 5.7+의 `JSON_EXTRACT()` 필요 (우리는 안 씀 — Worker에서 통째로 읽어 처리)

---

## 7. Worker에서의 API 호출 패턴

기존 `stats-worker/worker.js`에 헬퍼가 이미 있음. 그대로 재사용.

| 동작 | 메서드 | 경로 | 응답 |
|---|---|---|---|
| 생성 | POST | `/create/{table}` | `{status, message, id}` |
| 조회 (필터) | GET | `/read/{table}?col=val&limit=N` | `{status, data: [...]}` |
| 조회 (id 단건) | GET | `/read/{table}?id=N&limit=1` | `{status, data: [...]}` |
| 검색 (복잡 조건) | POST | `/search/{table}` (body: 쿼리) | `{status, data: [...]}` |
| 수정 | PUT | `/update/{table}/{id}` (body: 변경 필드) | `{status, message}` |
| 삭제 | DELETE | `/delete/{table}/{id}` | `{status, message}` |

### 인증

모든 요청에 헤더:
```
Authorization: Bearer {NCB_SECRET_KEY}
Content-Type: application/json
```

URL 쿼리에 `?Instance=55910_flashcard_app` 필수. 헬퍼 함수가 자동 추가:

```js
const NCB_BASE = 'https://openapi.nocodebackend.com';
const NCB_INSTANCE = '55910_flashcard_app';

function ncbUrl(path, extraParams = '') {
  const sep = extraParams ? '&' : '';
  return `${NCB_BASE}${path}?Instance=${NCB_INSTANCE}${sep}${extraParams}`;
}
```

---

## 8. 실전 함정 / FAQ

### Q. `errno: 150 "Foreign key constraint is incorrectly formed"` 에러가 떠요

여러 원인이 있습니다. 순서대로 확인:

**원인 1 — 타입 불일치 (자주)**: `id`가 BIGINT인데 FK를 INT로 만들었음. **FK는 무조건 `BIGINT`로 선택.**

**원인 2 — 부호(UNSIGNED) 불일치 (자주, UI로 해결 불가)**: nocodebackend 자동 `id`가 `BIGINT(20) UNSIGNED`인데, UI의 `BIGINT` 선택은 SIGNED를 만듦. **UI에 UNSIGNED 옵션이 없으므로 Run SQL로 직접 만들어야 함**:
```sql
CREATE TABLE `child_table` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `parent_id` INT NOT NULL,  -- ★ UNSIGNED 명시
  ...
  CONSTRAINT `fk_name` FOREIGN KEY (`parent_id`)
    REFERENCES `parent_table` (`id`)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  INDEX `idx_parent` (`parent_id`)
);
```

**원인 3 — 부모 테이블 부재**: 부모부터 만들고 자식.
**원인 4 — charset/collation 불일치**: 같은 instance면 보통 동일. 다르면 부모와 같게 명시 (`COLLATE utf8mb4_general_ci`).
**원인 5 — 부모 컬럼에 PK/UNIQUE 인덱스 없음**: `id`를 가리키면 자동으로 OK.

### Q. `order`/`group`/`select` 같은 이름의 컬럼을 만들 수 있나?
MySQL 예약어. UI로는 만들 수 있어 보이지만, REST API의 쿼리 파라미터(`?order=`)나 SQL 절(`ORDER BY`)과 충돌. **`sort_order`/`group_name` 등 안전한 이름**으로 만드세요. 이미 만들었으면:
```sql
ALTER TABLE my_table CHANGE `order` `sort_order` INT NOT NULL DEFAULT 0;
```

### Q. Run SQL은 어디 있나요?
대시보드 상단 메뉴의 **`Run SQL`** 버튼. UI에서 안 되는 것(복합 유니크, 복잡한 CHECK 등)을 처리할 때 사용. SQL 실행 후 화면 새로고침(`Refresh`)하면 UI에 새 테이블이 보입니다.

### Q. ★ 컬럼 Rename 다이얼로그가 기존 설정을 안 보여줘요 (FK·Not null 다 꺼져 보임)

nocodebackend UI 버그: 컬럼명을 클릭해 열리는 "Rename column" 다이얼로그는 **기존 컬럼의 실제 설정을 불러오지 않고 빈 폼**으로 표시합니다.

| 화면 | 표시 |
|---|---|
| 테이블 목록의 컬럼 줄 | 실제 설정 정확히 표시 (`FK ⓘ`, `NOT NULL`, `DEFAULT IS ...` 배지) |
| Rename 다이얼로그 | **모두 꺼진 상태로 표시** ← 실제 설정과 무관 |

**여기서 Save하면 FK·NOT NULL이 사라집니다.** 컬럼명만 바꿀 일이 아니면 다이얼로그는 열지도 마세요. 컬럼 설정은 Run SQL의 `ALTER TABLE`로:
```sql
ALTER TABLE op_topics MODIFY chapter_id INT NOT NULL;
```

### Q. ★ Run SQL로 만든 테이블의 id 타입이 내가 명시한 것과 다른데?

**중요한 발견**: nocodebackend의 Run SQL은 `id` 컬럼 정의를 **무시하고 `int(11)`로 강제로** 만듭니다. UI로 만들면 `bigint(20) unsigned`로 만들어집니다.

| 만든 방법 | id 자동 타입 |
|---|---|
| **UI**의 "Add table" | `bigint(20) unsigned` |
| **Run SQL**의 `CREATE TABLE` | **`int(11)`** ← 우리가 BIGINT(20) UNSIGNED 명시해도 무시 |

이 차이를 모르면 FK가 끝없이 errno 150을 냅니다. **반드시 모든 테이블을 같은 방법(전부 UI 또는 전부 Run SQL)으로 만들고, FK 컬럼 타입을 그에 맞추세요.**

| 모든 테이블을 만든 방법 | FK 컬럼 타입 |
|---|---|
| 전부 UI | `BIGINT` (UI에는 UNSIGNED 옵션이 없어서 FK는 결국 실패함 — 비추천) |
| **전부 Run SQL** ★ | **`INT`** (id가 int(11)이니 FK도 INT) |

→ **권장: 모든 테이블을 Run SQL로 + 모든 FK 컬럼은 `INT`**. UI 방식은 FK와 호환이 안 됨.

### Q. `DROPDOWN`을 안 쓰는 이유?
DB에 ENUM 같은 고정 옵션으로 저장되어 **나중에 값 추가하려면 스키마 변경** 필요. `VARCHAR(255)`로 자유 입력하고, 값 종류는 Worker/UI에서 제한하는 게 유연.

### Q. `PASSWORD` 타입은 왜 안 쓰나?
자동 해싱이 들어가는데 알고리즘·salt를 우리가 통제 못 함. 기존 시스템은 PBKDF2(100,000 iter)로 직접 해시 → `VARCHAR(255)` 또는 `TEXT`에 `salt:hash` 형식 저장.

### Q. 복합 유니크 (예: `(user_phone, subtopic_id)`)는 어떻게?
nocodebackend UI에서 복합 유니크 제약을 직접 거는 기능이 안 보이면 **Worker가 upsert 전에 검색으로 확인**. 동시성 우려 적은 도메인이면 충분.

### Q. `BOOLEAN` 컬럼의 기본값을 어떻게 적나?
`Default` 칸에 **`0`** 또는 **`1`** 입력 (`false`/`true`도 일부 받음 — DB에는 결국 0/1로 저장).

### Q. `DATETIME` 기본값에 "지금"을 넣고 싶다
`Default` 칸에 **`CURRENT_TIMESTAMP`** 입력. 또는 비워두고 Worker가 매번 KST ISO 문자열 보내기. **권장: Worker가 보내기** — 시간대 일관성 확보.

### Q. 컬럼 추가했는데 기존 행이 비어 있다
Default 값을 채워두지 않으면 기존 행에서 NULL이 됨. Not null 체크돼 있으면 ALTER 실패할 수 있으니, 컬럼 추가 시 Default 값을 명시하거나 일단 Not null 해제 후 백필.

### Q. 테이블 만든 후 컬럼을 추가/수정/삭제할 수 있나?
대시보드에서 가능. 다만 운영 중인 데이터가 있으면 신중. **Worker가 잘못된 필드명을 보내도 묵음으로 무시될 수 있으므로** 컬럼명 변경 후 Worker 코드도 같이 수정 + 배포.

### Q. 한 번 만든 테이블 통째로 삭제·이름 변경?
대시보드에서 가능. 단, 다른 테이블에서 FK로 가리키고 있으면 거부됨 — FK 먼저 풀고 삭제.

---

## 9. 우리 onepage 프로젝트 6개 테이블 (복붙용)

테이블 만들 때 그대로 사용하세요. `id`는 자동 생성이므로 제외.

> **FK가 있는 테이블(op_topics, op_subtopics, op_items, op_understood)은 UI로 만들 수 없습니다.** UNSIGNED 옵션이 UI에 없어서 errno 150이 뜸. 아래 **§9.A SQL 일괄 생성**을 사용하세요. FK 없는 테이블(op_chapters, op_pings)은 UI로 가능.

> **실전 노트**: nocodebackend의 FK 제약 생성이 환경에 따라 불안정(errno 150 반복 발생). 우리는 **FK를 빼고 INDEX만 사용**하는 방식으로 합의함. cascade 삭제는 Worker가 책임. 데이터 무결성도 Worker만이 쓰기 권한을 가지므로 동일.

### 9.A SQL 일괄 생성 (Run SQL에 한 문장씩 붙여넣기)

> Run SQL은 **한 번에 한 문장**만 받습니다. 아래 8개를 하나씩 복붙해서 실행하세요.

```sql
-- 1) op_chapters (FK 없음 — UI로도 가능)
CREATE TABLE IF NOT EXISTS `op_chapters` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `subject` VARCHAR(255) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `icon` VARCHAR(255) NULL,
  `description` TEXT NULL,
  `monthly_price` INT NOT NULL DEFAULT 3000,
  `is_all_free` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_at` DATETIME NULL
);

-- 2) op_topics
CREATE TABLE IF NOT EXISTS `op_topics` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `chapter_id` INT NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_free` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_at` DATETIME NULL,
  CONSTRAINT `fk_op_topics_chapter`
    FOREIGN KEY (`chapter_id`) REFERENCES `op_chapters` (`id`)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  INDEX `idx_op_topics_chapter` (`chapter_id`)
);

-- 3) op_subtopics
CREATE TABLE IF NOT EXISTS `op_subtopics` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `topic_id` INT NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `updated_at` DATETIME NULL,
  CONSTRAINT `fk_op_subtopics_topic`
    FOREIGN KEY (`topic_id`) REFERENCES `op_topics` (`id`)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  INDEX `idx_op_subtopics_topic` (`topic_id`)
);

-- 4) op_items
CREATE TABLE IF NOT EXISTS `op_items` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `subtopic_id` INT NOT NULL,
  `kind` VARCHAR(255) NOT NULL,
  `text` TEXT NULL,
  `image_b64` JSON NULL,
  `caption` VARCHAR(255) NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `updated_at` DATETIME NULL,
  CONSTRAINT `fk_op_items_subtopic`
    FOREIGN KEY (`subtopic_id`) REFERENCES `op_subtopics` (`id`)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  INDEX `idx_op_items_subtopic` (`subtopic_id`)
);

-- 5) op_understood (복합 유니크 한 줄로 처리)
CREATE TABLE IF NOT EXISTS `op_understood` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_phone` VARCHAR(255) NOT NULL,
  `subtopic_id` INT NOT NULL,
  `marked_at` DATETIME NOT NULL,
  CONSTRAINT `fk_op_understood_subtopic`
    FOREIGN KEY (`subtopic_id`) REFERENCES `op_subtopics` (`id`)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  UNIQUE KEY `uq_op_understood_user_sub` (`user_phone`, `subtopic_id`),
  INDEX `idx_op_understood_user` (`user_phone`)
);

-- 6) op_pings (FK 없음 — UI로도 가능)
CREATE TABLE IF NOT EXISTS `op_pings` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_phone` VARCHAR(255) NOT NULL UNIQUE,
  `first_ping_today` DATE NOT NULL,
  `last_ping_at` DATETIME NULL
);
```

→ Run SQL 창에 통째로 붙여 한 번에 실행. 기존에 만든 테이블이 있어도 `IF NOT EXISTS`라 건너뜀.

### 9.1 `op_chapters`

| 컬럼 | Type | Not null | Unique | FK | Default |
|---|---|:-:|:-:|:-:|---|
| subject | VARCHAR(255) | ✅ | | | |
| title | VARCHAR(255) | ✅ | | | |
| sort_order | INT | ✅ | | | `0` |
| icon | VARCHAR(255) | | | | |
| description | TEXT | | | | |
| monthly_price | INT | ✅ | | | `3000` |
| is_all_free | BOOLEAN | ✅ | | | `0` |
| updated_at | DATETIME | | | | |

### 9.2 `op_topics`

| 컬럼 | Type | Not null | Unique | FK | Default |
|---|---|:-:|:-:|:-:|---|
| chapter_id | INT | ✅ | | **→ op_chapters.id, CASCADE** | |
| title | VARCHAR(255) | ✅ | | | |
| sort_order | INT | ✅ | | | `0` |
| is_free | BOOLEAN | ✅ | | | `0` |
| updated_at | DATETIME | | | | |

### 9.3 `op_subtopics`

| 컬럼 | Type | Not null | Unique | FK | Default |
|---|---|:-:|:-:|:-:|---|
| topic_id | INT | ✅ | | **→ op_topics.id, CASCADE** | |
| title | VARCHAR(255) | ✅ | | | |
| sort_order | INT | ✅ | | | `0` |
| updated_at | DATETIME | | | | |

### 9.4 `op_items`

| 컬럼 | Type | Not null | Unique | FK | Default |
|---|---|:-:|:-:|:-:|---|
| subtopic_id | INT | ✅ | | **→ op_subtopics.id, CASCADE** | |
| kind | VARCHAR(255) | ✅ | | | |
| text | TEXT | | | | |
| image_b64 | **JSON** | | | | |
| caption | VARCHAR(255) | | | | |
| sort_order | INT | ✅ | | | `0` |
| updated_at | DATETIME | | | | |

### 9.5 `op_understood`

| 컬럼 | Type | Not null | Unique | FK | Default |
|---|---|:-:|:-:|:-:|---|
| user_phone | VARCHAR(255) | ✅ | | | |
| subtopic_id | INT | ✅ | | **→ op_subtopics.id, CASCADE** | |
| marked_at | DATETIME | ✅ | | | |

### 9.6 `op_pings`

| 컬럼 | Type | Not null | Unique | FK | Default |
|---|---|:-:|:-:|:-:|---|
| user_phone | VARCHAR(255) | ✅ | ✅ | | |
| first_ping_today | DATE | ✅ | | | |
| last_ping_at | DATETIME | | | | |

---

## 10. 만든 후 검증 체크리스트

각 테이블 만든 직후:

- [ ] 테이블명이 의도대로 (대소문자·언더스코어)
- [ ] `id` 컬럼이 자동 생성됐는가 — 화면에 `id bigint(20) unsigned PK NOT NULL` 표시
- [ ] FK 컬럼의 On delete가 **CASCADE**로 설정됐는가 (RESTRICT면 챕터 삭제 시 에러)
- [ ] Unique 컬럼이 실제로 중복 입력 거부하는가 (샘플 2개 같은 값 INSERT로 테스트)
- [ ] JSON 컬럼에 base64 문자열 1건 INSERT 후 SELECT로 그대로 복원되는가
- [ ] Worker `NCB_SECRET_KEY`로 `/read/{table}` GET 200 응답 오는가

전부 통과하면 Worker 단계로.

---

## 11. 다른 시스템 (Airtable·R2 등)으로 마이그레이션할 때

- nocodebackend → Airtable: 콘텐츠 양이 한정적이면 Airtable로 통합 가능. 단 rate limit(5 req/s)·필드 길이 한계 주의
- nocodebackend → Cloudflare R2: 이미지가 늘어나면 `image_b64`를 R2 URL로 교체. 컬럼명 `image_url`로 추가하고 새 이미지부터 R2에 업로드, 기존 base64는 점진 마이그레이션
- nocodebackend → 직접 운영 DB: 위 스키마 그대로 MySQL/PostgreSQL에 옮길 수 있음. Worker의 NCB_BASE만 교체
