# 원페이지 학습 — 전체 기능 가이드

원페이지 학습 서비스의 모든 기능을 한눈에. 다음 작업·인수인계·운영 시 참고용 문서.

## 목차
1. [시스템 개요](#1-시스템-개요)
2. [3가지 앱 + 백엔드](#2-3가지-앱--백엔드)
3. [계층 구조](#3-계층-구조)
4. [결제 모델 (챕터별)](#4-결제-모델-챕터별)
5. [포인트 시스템](#5-포인트-시스템)
6. [추천 시스템](#6-추천-시스템)
7. [학습 인터페이스 — 플래시카드 모드](#7-학습-인터페이스--플래시카드-모드)
8. [콘텐츠 정렬 규칙](#8-콘텐츠-정렬-규칙)
9. [위치 고정 — 학습 중 스크롤 안 밀림](#9-위치-고정--학습-중-스크롤-안-밀림)
10. [선생님 — 콘텐츠 관리](#10-선생님--콘텐츠-관리)
11. [일괄 입력 (TSV)](#11-일괄-입력-tsv)
12. [이미지 처리](#12-이미지-처리)
13. [보안 — 워터마크·캡쳐 차단](#13-보안--워터마크캡쳐-차단)
14. [라이브 학습자 카운트](#14-라이브-학습자-카운트)
15. [데이터 모델](#15-데이터-모델)
16. [Worker 엔드포인트](#16-worker-엔드포인트)
17. [Cloudflare Workers 청크 처리](#17-cloudflare-workers-청크-처리)

---

## 1. 시스템 개요

**한 페이지에 한 단원 전체.** 학생은 챕터별 월 구독으로 콘텐츠 열람.

| 구성 | 역할 |
|---|---|
| 학생 앱 | 챕터 카드 → 트리 학습 → 플래시카드 모드 |
| 선생님 앱 | 트리 CRUD + Ctrl+V 이미지 + TSV 일괄 입력 |
| 랜딩페이지 | 마케팅, 인터랙티브 데모, 결제 진입 |
| Worker (API) | 인증·게이트·콘텐츠 CRUD·결제 외 모든 처리 |

---

## 2. 3가지 앱 + 백엔드

```
┌─────────────────────────────────────────────────┐
│  학생: https://onepage-study.vercel.app          │   ← Vercel 또는 GitHub Pages
│  선생님: github.io/.../onepage-teacher.html      │
│  랜딩: vipup.site (아임웹 임베드)                  │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
        onepage-api.memoryking.workers.dev
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
    Airtable             nocodebackend
   (사람·돈)            (콘텐츠 5개 테이블)
```

- **Airtable**: 사용자·결제·포인트 (4 테이블)
- **nocodebackend**: 챕터·콘텐츠·진도 (6 테이블)
- **PayApp**: 결제 (사용자님 자체 webhook → Airtable)
- **Airtable Automations**: 추천 보너스 자동 지급

---

## 3. 계층 구조

```
챕터 (Chapter)              ← 결제 단위, 월별 구독
  └ 대목차 (Topic)          ← is_free=1이면 무료 열람
     └ 소목차 (Subtopic)    ← 학습 단위 (=플래시카드 1장)
        ├ 대표 이미지        ← 항상 보임 (표지)
        └ 내용 블록 (Items)  ← text/image, 펼침 시 표시
```

각 챕터는 `subject` (과목) 컬럼으로 그룹핑 — 수학·영어·한국사 등.

---

## 4. 결제 모델 (챕터별)

- **챕터당 월 3,000원~** (`monthly_price` 컬럼, 챕터마다 다른 가격 가능)
- 결제 후 **30일** 동안 그 챕터 전체 열람
- **자동결제 X** — 매월 본인이 직접 결제
- 만료 후 자동으로 무료 사용자 (그 챕터의 무료 대목차만)

저장: Airtable `OnepageChapterAccess` (user×chapter 행마다 expires_at)

> 결제 → Airtable 저장은 사용자님 자체 webhook으로 처리.
> Worker는 `expires_at`을 읽기만 함.

---

## 5. 포인트 시스템

### 환율
**3,000P = 챕터 1개월 연장**

### 적립
- 친구가 내 추천으로 가입 + 첫 결제 → **양쪽 모두 +1,000P**
- 트리거: Airtable Automation이 `OnepagePayments` 신규 행 감지 → `first_paid_at` 비었으면 첫 결제로 판단 → 양쪽 +1000P + `OnepagePointTx` 행 추가

### 사용 (학생 앱)
- 홈에서 **💰 포인트 칩 클릭** → 포인트 모달
- 챕터별 4개 박스로 시각화:
  - 적립: 친구 1명 결제 = +1,000P
  - 사용: 3,000P → +30일
  - 유료 갱신: D-12 → D-42 (잔여 + 30)
  - 미구매 시작: → D-30
- 챕터 선택 → 3,000P 차감 + ChapterAccess 30일 연장
- 잔액이 또 3,000P 이상이면 모달 자동 재오픈 (연속 구매 편의)

### 워커 처리 (`POST /access/redeem`)
```js
// 활성 챕터면 잔여 + 30, 만료/미구매면 오늘 + 30
const base = curr && new Date(curr) > new Date(nowIso) ? curr : nowIso;
newExpires = addDays(base, 30);
// 포인트 차감 + PointTx 행 + ChapterAccess upsert
```

---

## 6. 추천 시스템

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

→ 1명 추천 = 1,000P, 3명 = 3,000P = 챕터 1개월 무료

---

## 7. 학습 인터페이스 — 플래시카드 모드

학생 앱의 **핵심 학습 흐름**. 스크롤 없이 단어를 연속으로 학습.

### 화면 구성
```
▼ 일상/대화 ⑫           [        ⤴ 패스         ]  ← 대목차 헤더
  🟠 appointment                                    ← 학습 대상 (주황)
  ○ reservation
  ○ cancel
  ...
  ● therapy                                         ← 학습완료 (아래로)
  ● recover
```

대목차 헤더 구성:
- **▶/▼** 화살표 — 펼침/접힘 표시
- **제목** — 대목차 이름
- **⑫ 카운트 배지** — 제목 바로 뒤에 원형 표시 (소목차 총 개수, 학습 동기 부여)
- **⤴ 패스 버튼** — 헤더 오른쪽 끝까지 확장 (손가락으로 누르기 편함)

### 학습 동작 — 버튼 1개 + 꾹누르기 1개

| 동작 | 트리거 | 결과 | 저장 |
|---|---|---|---|
| **펼치기/접기** | 소목차 짧게 탭 | 내용 표시 (아코디언) | — |
| **패스** | 대목차 헤더의 **⤴ 패스** 버튼 | 맨 위 소목차가 이번 회에서 빠지고 다음 단어가 위로 올라옴 | localStorage (챕터 단위, 영구) |
| **완료/다시 토글** | 소목차를 600ms 꾹누르기 | 학습완료 ● 표시 ↔ 미학습 토글 | DB (`op_understood`) |

→ 버튼 1개 + 꾹누르기 1개로 모든 학습 흐름 처리. 버튼은 단순하고 크게, 동작은 직관적으로.

### 모두 패스 시 — 폭죽 축하 + 자동 재시작
대목차 안 **모든** 소목차를 패스(완료된 것도 포함)하면:
1. 화면 가득 폭죽 🎉 오버레이 + "수고하셨어요!" 메시지 (1.5초)
2. 자동으로 해당 대목차의 패스 상태 초기화
3. 처음부터 다시 학습 시작

→ "다시 시작" 버튼 없이도 한 사이클이 자연스럽게 닫힘.

### 첫 단어 강조
첫 미학습 소목차는 🟠 **주황 배경**으로 강조 → "지금 이걸 학습하세요" 신호.

### 영구 저장된 패스 상태
- 키: `localStorage.op_passed_<chapterId>`
- 챕터 진입 시 자동 복원 → 마지막 학습 위치에서 계속

### 마지막 본 콘텐츠 자동 로딩
- 페이지를 닫았다 다시 열어도 마지막에 보던 챕터·대목차·소목차가 그대로 복원
- 페이지 단위로 기억하므로 다른 탭에서 다른 챕터를 봐도 충돌 없음

---

## 8. 콘텐츠 정렬 규칙

소목차는 다음 순서로 자동 정렬:

1. **미학습** (`understood=false` AND `passed=false`) — 위에
2. **학습완료** (`understood=true`) — 아래로
3. **패스됨** — 화면에서 숨김 (전부 패스 시 폭죽 후 자동 초기화)

같은 그룹 내에서는 `sort_order` 기준.

→ 위에서 아래로 읽기만 하면 자연스럽게 미학습부터 보임.

---

## 9. 위치 고정 — 학습 중 스크롤 안 밀림

학습 액션 시 화면이 흔들리지 않도록 두 단계 방어:

### CSS 단계 — Auto-scroll 방지
```css
.chapter-tree {
  padding-bottom: 100vh;   /* 마지막 대목차 아래 1화면 분 여유 */
  overflow-anchor: none;
}
```
- 페이지가 항상 충분히 길어서 콘텐츠 줄어도 max-scroll 발동 X
- 마지막 대목차에서 패스해도 위에서 콘텐츠 안 내려옴

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
- 대목차 헤더(패스 버튼 포함)의 화면 Y 위치 캡쳐
- 렌더 후 위치 변화량만큼 scrollBy로 보정
- 패스 / 꾹누르기 / 펼침 모두 이 함수로 감싸짐

→ 패스 버튼 위치가 항상 같은 자리에 있어 연속 탭 가능

### 소목차 펼침도 동일
`subClick` 함수도 같은 패턴으로 펼침 시 위치 보정.

---

## 10. 선생님 — 콘텐츠 관리

### 트리 CRUD
- 챕터 → 대목차 → 소목차 → 내용 블록 (4단계)
- 각 단계 추가/편집/삭제 (`✎`/`🗑️`)
- DB FK CASCADE로 챕터 삭제 시 아래 모두 자동 정리

### 소목차 편집 모달
- 제목·sort_order
- **대표 이미지** picker + 클립보드 붙여넣기 + 캡션
- 이미지는 op_subtopics.image_b64에 base64로 저장

### 내용 블록 (op_items)
- 텍스트 또는 이미지 단위
- 텍스트: `prompt()`로 빠른 추가/편집
- 이미지: 파일 업로드 또는 Ctrl+V 페이스트

### 모두 접기 / 새로고침 / 일괄 입력
- 툴바에 버튼 3개

---

## 11. 일괄 입력 (TSV)

엑셀 → 복사 → 붙여넣기 한 번에 콘텐츠 대량 입력.

### 포맷 (가로형)
```
A: 대목차       B: 소목차    C~ : 내용1, 내용2, 내용3 ...
─────────────────────────────────────────────
조선 왕의 업적   세종        훈민정음 창제  집현전 설치  4군 6진 개척
                성종        경국대전 완성  홍문관 설치
```

- 대목차 칸 비우면 "이전 대목차에 계속"
- 첫 행 헤더(`대목차`)는 자동 스킵
- C열부터 끝까지가 그 소목차의 N개 내용 항목

### Excel 멀티라인 셀 지원
- 셀 안에 Alt+Enter로 줄바꿈한 경우 Excel은 셀을 `"..."`로 감쌈
- 파서가 따옴표 안의 `\n`을 행 구분자로 안 보고 셀 내용으로 처리
- 따옴표 안의 `""`는 이스케이프된 `"`로 복원

### 파일 업로드 대안
- 큰 데이터는 엑셀 → "텍스트 (탭으로 분리)(*.txt)"로 저장
- 모달의 **📂 파일에서 불러오기** 버튼으로 로드
- textarea 우측에 행/글자 수 실시간 표시

### Cloudflare 청크 처리
→ [§17 청크 처리](#17-cloudflare-workers-청크-처리) 참조

---

## 12. 이미지 처리

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

## 13. 보안 — 워터마크·캡쳐 차단

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

## 14. 라이브 학습자 카운트

### 헤더에 "🟢 N명 학습 중" 표시
- 60초마다 `POST /stats/ping` 호출 (학생 앱)
- nocodebackend `op_pings` 테이블에 (phone, first_ping_today) upsert
- `GET /stats/learners-now`가 `first_ping_today = 오늘`인 행 수 반환

### "오늘 N명"
- KST 기준 자정에 자동 리셋 (다음 ping부터 새 카운트)
- 실시간 학습 인원 = 오늘 한 번이라도 ping 보낸 사용자 수

---

## 15. 데이터 모델

### Airtable (사람·돈)
- **OnepageUsers**: name, phone, email, password_hash, role, referral_code, referred_by_code, point, first_paid_at
- **OnepageChapterAccess**: user_phone, chapter_id, expires_at, last_payment_id, source
- **OnepagePayments**: mul_no, user_phone, chapter_id, amount, paid_at, raw (사용자님 webhook이 채움)
- **OnepagePointTx**: user_phone, delta, reason, balance_after (감사 로그)

### nocodebackend (콘텐츠)
- **op_chapters**: id, subject, title, sort_order, icon, description, monthly_price, is_all_free
- **op_topics**: id, chapter_id, title, sort_order, is_free
- **op_subtopics**: id, topic_id, title, sort_order, **image_b64, caption**
- **op_items**: id, subtopic_id, kind, text, image_b64, caption, sort_order
- **op_understood**: user_phone, subtopic_id, marked_at (꾹누르기 진도)
- **op_pings**: user_phone, first_ping_today, last_ping_at (라이브 카운트)

자세한 컬럼·타입·FK 설정은 [ONEPAGE_SCHEMA.md](ONEPAGE_SCHEMA.md) 참조.

---

## 16. Worker 엔드포인트

| 경로 | 메서드 | 동작 |
|---|---|---|
| `/auth/signup` | POST | 회원가입 (name, phone, email, pw, referral_code?) |
| `/auth/login` | POST | 로그인 → JWT 토큰 |
| `/auth/me` | GET | 내 정보 + 챕터 접근 맵 |
| `/referral/info?code=` | GET | 추천 코드 유효성 (이름 마스킹) |
| `/chapters` | GET | 챕터 목록 (subject 그룹핑 가능) |
| `/chapters` | POST/PUT/DELETE | (teacher만) CRUD |
| `/chapters/:id/bulk` | POST | TSV 일괄 입력 (청크 처리) |
| `/topics?chapter_id=` | GET | 대목차 목록 + 동봉 subtopics |
| `/topics` | POST/PUT/DELETE | (teacher만) |
| `/subtopics?topic_id=` | GET | 소목차 목록 |
| `/subtopics` | POST/PUT/DELETE | (teacher만) |
| `/items?subtopic_id=` | GET | 내용 블록 (구독 게이트 적용) |
| `/items` | POST/PUT/DELETE | (teacher만) |
| `/understood` | POST | 꾹누르기 토글 |
| `/understood?chapter_id=` | GET | 내 이해 표시 목록 |
| `/stats/ping` | POST | 60초마다 학생이 호출 |
| `/stats/learners-now` | GET | 오늘 학습자 수 |
| `/access` | GET | 내 챕터별 접근 상태 |
| `/access/redeem` | POST | 3,000P → 챕터 1개월 |

### 구독 게이트 (`/items` 응답)
- 무료 대목차 (is_free=1) → 누구나 200
- 비구독자 → 402 + `{error: 'subscription_required', chapter_id}`
- 비로그인 → 401
- 선생님 (role=teacher) → 항상 통과

---

## 17. Cloudflare Workers 청크 처리

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
