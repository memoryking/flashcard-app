# Flashcard-User 전체 기능 상세 가이드

## 목차
1. [전체 앱 구조](#1-전체-앱-구조)
2. [IndexedDB 구조](#2-indexeddb-구조)
3. [접속 제한 보안](#3-접속-제한-보안)
4. [URL/페이지 감지](#4-url페이지-감지)
5. [에어테이블 연동](#5-에어테이블-연동)
6. [자료 불러오기](#6-자료-불러오기)
7. [하루 1회 업데이트 체크](#7-하루-1회-업데이트-체크)
8. [학습 모드 3가지](#8-학습-모드-3가지)
9. [암기박스 우선순위](#9-암기박스-우선순위)
10. [퀴즈 로직](#10-퀴즈-로직)
11. [known 값 변화 규칙](#11-known-값-변화-규칙)
12. [단어 진행도 관리](#12-단어-진행도-관리)
13. [통계 바](#13-통계-바)
14. [설정](#14-설정)
15. [사이드바](#15-사이드바)
16. [콘텐츠 삭제](#16-콘텐츠-삭제)
17. [홈 버튼](#17-홈-버튼)
18. [퀴즈 완료 화면](#18-퀴즈-완료-화면)
19. [모바일 대응](#19-모바일-대응)
20. [localStorage 저장 값](#20-localstorage-저장-값)
21. [CSS 애니메이션](#21-css-애니메이션)
22. [이미지 하이라이트 텍스트 라벨](#22-이미지-하이라이트-텍스트-라벨)

---

## 1. 전체 앱 구조

### 클래스
`WordMemorizationApp` — 단일 클래스로 모든 기능 포함

### 초기화 흐름
```
constructor()
  └→ init()
      ├→ loadPageCategory()         에어테이블에서 페이지 카테고리 로드
      ├→ initDB()                   IndexedDB v6 초기화
      ├→ setupFlashcardEventListeners()  이벤트 리스너 등록
      ├→ loadData()                 저장된 콘텐츠 목록 로드
      ├→ updateToggleUI()           구분학습/암기학습 토글 UI 복원
      ├→ 500ms 후: loadLastViewedContent()  마지막 본 콘텐츠 자동 로드
      └→ 2000ms 후: checkForUpdates()      하루 1회 업데이트 체크
```

### 전역 접근
```javascript
window.app = new WordMemorizationApp();
```
HTML에서 `window.app && window.app.메서드()` 형태로 호출

---

## 2. IndexedDB 구조

- **DB명**: `MemorykingDB_User`
- **버전**: 6
- **Origin**: `memoryking.github.io` (모든 iframe이 공유)

### contents 스토어
| 필드 | 설명 |
|------|------|
| id | 자동 증가 (keyPath) |
| title | 콘텐츠 제목 |
| content | 원본 텍스트 |
| content_type | 'text' / 'mindmap' / 'image' |
| mindmap_data | JSON 문자열 (branches 배열) |
| image_data | 이미지 데이터 |
| category1~3 | 카테고리 분류 |
| url_path | page= 파라미터 값 |
| created_at | 생성일 |
| imported_at | 가져온 날짜 |

### highlights 스토어
| 필드 | 설명 |
|------|------|
| id | 자동 증가 (keyPath) |
| content_id | contents 참조 |
| text | 하이라이트 텍스트 |
| is_priority | 우선 학습 여부 |

### word_progress 스토어
| 필드 | 설명 |
|------|------|
| id | 자동 증가 (keyPath) |
| content_id | contents 참조 |
| word | 영단어 (level1) |
| meaning | 뜻 (level2) |
| association | 연결고리 (level3) |
| known | `null`=미학습, `0`=미암기, `1`=1차암기, `2`=완전암기 |
| last_studied | 마지막 학습일 (KST ISO 문자열) |
| study_count | 총 시도 횟수 |
| correct_count | 총 정답 횟수 |
| created_at | 생성일 |

**유니크 인덱스**: `[content_id, word]` — 같은 콘텐츠에 같은 단어 중복 불가

---

## 3. 접속 제한 보안

앱 클래스 생성 **전에** 실행되는 IIFE (즉시 실행 함수)

### 허용 도메인
| 도메인 | 용도 |
|--------|------|
| `vipup.site` | 실제 서비스 (아임웹) |
| `www.vipup.site` | www 포함 접속 |
| `memoryking.github.io` | GitHub Pages (개발/테스트) |
| `localhost` | 로컬 개발 |
| `127.0.0.1` | 로컬 개발 |

### 검사 방식
- **직접 접속** → `window.location.hostname` 검사
- **iframe 내부** → `document.referrer` 호스트 검사
- **차단 시** → 화면을 차단 메시지로 교체 + `throw Error`로 JS 중단

---

## 4. URL/페이지 감지

`detectUrlPath()` — 우선순위별로 페이지 경로를 결정

```
1순위: URL의 ?page= 파라미터
       예: ?page=memorycard-eng-voca-hs-free → "memorycard-eng-voca-hs-free"

2순위: iframe 부모 페이지의 마지막 경로
       예: vipup.site/eng-voca → "eng-voca"

3순위: 자신의 URL 마지막 경로
       예: /flashcard-app/flashcard-user.html → "flashcard-user"

기본값: hostname (예: "memoryking.github.io")
```

### 용도
- 에어테이블 `page_config`의 `url_path`와 매칭 → 카테고리 결정
- 콘텐츠 저장 시 `url_path` 필드에 기록
- **page= 값이 같으면 같은 학습 데이터**, 다르면 다른 학습 데이터

---

## 5. 에어테이블 연동

### 프록시 URL
```
https://airtable-proxy.memoryking.workers.dev
```

### 카테고리 로드 (`loadPageCategory`)
```
fetch(proxyUrl + '/page_config')
  → page_config 테이블에서 url_path 매칭
  → pageCategory = { category1, category2, category3 }
```

### 데이터 가져오기 (`importFromAirtable`)
```
fetch(proxyUrl)
  → 전체 레코드 수신
  → pageCategory로 필터링:
     category1, category2, category3 모두 일치하는 레코드만
```

### 데이터 구조 (에어테이블 레코드)
```json
{
  "fields": {
    "category1": "영어",
    "category2": "영단어",
    "category3": "수능영단어무료학습",
    "json": "{\"content\": {\"title\": \"...\", \"content_type\": \"mindmap\", \"mindmap_data\": \"...\"}}"
  }
}
```

---

## 6. 자료 불러오기

### 버전 비교 시스템

제목 끝에 숫자가 있으면 버전으로 인식:
```
"수능영단어 필수명사 v2"  → baseName: "수능영단어 필수명사 v", version: 2
"단어장 1.5"             → baseName: "단어장", version: 1.5
"기본 단어장"            → baseName: "기본 단어장", version: 0
```

### 상태 판정
| 상태 | 조건 | 표시 |
|------|------|------|
| **중복** | 로컬에 동일 제목이 있음 | 빨간 태그 |
| **업데이트** | baseName이 같고 에어테이블 버전이 더 높음 | 초록 태그 |
| **신규** | 로컬에 없는 콘텐츠 | 태그 없음 |

### 선택 버튼
- **전체 선택** — 모든 항목 선택
- **전체 해제** — 모든 항목 해제
- **중복 제외 선택** — 중복이 아닌 것만 선택
- **중복 항목만 선택** — 중복인 것만 선택
- **업데이트 항목만 선택** — 업데이트 가능한 것만 (업데이트가 있을 때만 표시)

### Import 다이얼로그 UI (다크 테마)
- 모바일: 전체 화면, 버튼 균등 배치
- 데스크탑: 중앙 모달, max-width 800px
- 체크박스 accent-color: `#e94560`

---

## 7. 하루 1회 업데이트 체크

### 동작 흐름
```
앱 시작 2초 후 checkForUpdates() 실행
  ├→ localStorage.lastUpdateCheck === 오늘 날짜?
  │     YES → 체크 안 함 (하루 1회)
  │     NO  → 계속
  ├→ pageCategory 없으면 → 체크 안 함
  ├→ 프록시에서 데이터 fetch
  ├→ pageCategory로 필터링
  ├→ 로컬 콘텐츠와 비교 (버전 비교)
  ├→ 신규/업데이트 개수 카운트
  ├→ localStorage.lastUpdateCheck = 오늘 날짜
  └→ 배지 표시
```

### 배지 표시 (☰ 버튼)
| 배지 | 의미 |
|------|------|
| **NEW** | 신규 콘텐츠가 있음 |
| **UP** | 기존 콘텐츠의 새 버전이 있음 |
| **N+U** | 신규 + 업데이트 둘 다 있음 |

- 빨간 배지, 펄스 애니메이션 (2초 주기)
- **사이드바를 열면 자동으로 배지 제거**

### 자정 넘김 대응
- `getKSTDateString()`을 매번 호출하므로 새로고침 없이 자정 이후 자동 재체크

---

## 8. 학습 모드 3가지

### 8.1 남은박스 (remaining)
| 항목 | 값 |
|------|-----|
| 조건 | `known === null` (아직 학습 안 한 단어) |
| 정렬 | **저장 순서 유지** (DB 저장 순서 = 에어테이블 콘텐츠 순서) |
| 제한 | `wordLimitRemaining` (기본 10개) |
| 정답 시 | known: null → **1** |
| 오답 시 | known: null → **0** |

### 8.2 미암기박스 (notMemorized)
| 항목 | 값 |
|------|-----|
| 조건 | `known === 0` (틀린 단어) |
| 정렬 | **10개 단위 청크 셔플** (저장순서 기반으로 10개씩 묶어서 그 안에서만 랜덤) |
| 제한 | `wordLimitNotMemorized` (기본 10개) |
| 정답 시 | known: 0 → **1** |
| 오답 시 | known: 0 → **0** (유지) |

#### 두 가지 학습 모드 (토글)
| 모드 | 설명 |
|------|------|
| **구분학습** (test) | 뜻의 첫 글자 2개 중 선택 + 타이머 |
| **암기학습** (memorize) | 단어+뜻+연결고리 표시 → 탭하여 O/X 자가 평가 |

### 8.3 암기박스 (memorized)
| 항목 | 값 |
|------|-----|
| 조건 | `known === 1` 또는 `known === 2` |
| 정렬 | **우선순위 순서 유지** (아래 9번 참조) |
| 제한 | `wordLimitMemorized` (기본 10개) |
| 정답 시 | known: 1 또는 2 → **2** |
| 오답 시 | known → **0** (미암기로 강등) |

---

## 9. 암기박스 우선순위

### 4단계 우선순위 (예: 오늘이 3/17일 경우)

| 순위 | 조건 | 설명 |
|------|------|------|
| 1순위 | `known=1`, 오늘 학습 X | 1차 암기된 단어, 아직 오늘 안 본 것 |
| 2순위 | `known=2`, 3일 이전 (3/14 포함 그 이전) | 완전 암기 but 오래됨 → 복습 필요 |
| 3순위 | `known=2`, 최근 (3/15 ~ 오늘) | 완전 암기 + 최근 학습 → 덜 급함 |
| 4순위 | `known=1`, 오늘 학습 O | 오늘 이미 본 1차 암기 단어 |

각 그룹 내에서는 `last_studied` **오래된 순** 정렬

### 3일 기준 계산
```javascript
const cutoffStr = new Date(todayDate.getTime() - 3 * 24 * 60 * 60 * 1000)
                    .toISOString().split('T')[0];
// 오늘 3/17 → cutoffStr = "2026-03-14"
// 2순위: last_studied <= "2026-03-14"
// 3순위: last_studied > "2026-03-14"
```

### 왕관 👑 표시 조건

| 시점 | 조건 |
|------|------|
| **퀴즈 중** | 1순위+2순위를 모두 풀고 **3순위 진입** 시 |
| **상태바** | 1순위 단어 0개 AND 2순위 단어 0개 (모두 복습 완료) |

---

## 10. 퀴즈 로직

### 선택지 생성 — 뜻의 첫 글자 추출

`getHintChar(meaning)` 동작:
```
원본 뜻 → 전처리 (반복 적용)
  1. ~, ～ 제거
  2. 조사 제거: 에게, 에서, 으로, 에, 의, 을, 를, 와, 과, 로, 이, 가
  3. 괄호 내용 제거: (품사) 등
  → 첫 글자 반환
```

예시:
| 원본 뜻 | 추출 결과 |
|---------|----------|
| "의미" | "의" |
| "~의 표면" | "표" |
| "(명) 구조" | "구" |
| "에 대한 관심" | "관" |

### 오답 선택지
1. 현재 퀴즈 단어들 중 **다른 첫 글자**를 가진 단어에서 추출
2. 없으면 한글 음절 폴백: 가, 나, 다, ..., 포

### 좌우 배치
`Math.random() < 0.5` — 정답이 왼쪽 또는 오른쪽에 랜덤 배치

### 타이머
- `requestAnimationFrame` 기반 (60fps)
- `performance.now()` 사용 — 정확한 시간 측정
- 기본 3초, 설정에서 0.5초~5초 조절 가능
- 타이머 바가 우→좌로 줄어듦
- 시간 초과 시 **오답 처리**

### 정답/오답 후 동작
| | 정답 | 오답/타임아웃 |
|---|---|---|
| 카드 색상 | 노란 플래시 | 흰색 플래시 |
| 뜻 표시 | X | O (잠깐 표시) |
| 대기 시간 | 200ms | 800ms (오답) / 1000ms (타임아웃) |
| 날아가는 방향 | 해당 박스로 | 미암기 박스로 |

---

## 11. known 값 변화 규칙

### 정답 시

| 어디서 맞췄나 | 변화 | 의미 |
|--------------|------|------|
| 남은박스 | null → **1** | 처음 맞춤 → 1차 암기 |
| 미암기박스 | 0 → **1** | 틀렸던 단어를 맞춤 → 1차 암기 복귀 |
| 암기박스 | 1/2 → **2** | 검증됨 → 완전 암기 |

### 오답 시

| 어디서 틀렸나 | 변화 | 의미 |
|--------------|------|------|
| 모든 박스 | → **0** | 무조건 미암기로 강등 |

### known 값 흐름도
```
null (남은박스)
  ├─ 정답 → 1 (암기박스)
  └─ 오답 → 0 (미암기박스)

0 (미암기박스)
  ├─ 정답 → 1 (암기박스)
  └─ 오답 → 0 (미암기 유지)

1 (암기박스)
  ├─ 정답 → 2 (완전암기)
  └─ 오답 → 0 (미암기로 강등)

2 (암기박스)
  ├─ 정답 → 2 (완전암기 유지)
  └─ 오답 → 0 (미암기로 강등)
```

### 추가 업데이트
- `last_studied` = 현재 KST 시간
- `study_count` += 1
- 정답이면 `correct_count` += 1

---

## 12. 단어 진행도 관리

### initWordProgress(contentId)

콘텐츠를 열 때 호출 — `mindmap_data`의 branches를 word_progress에 동기화

```
1. 기존 word_progress 조회 → existingMap (word 기준)
2. branches 순회:
   - existingMap에 있으면 → 건너뜀 (학습 기록 유지)
   - 없으면 → 새 레코드 생성 (known: null)
3. 뜻/연결고리 변경 감지:
   - 기존 단어의 meaning/association이 다르면 → 업데이트 (known 유지)
```

### 중복 단어 처리
- `[content_id, word]` 유니크 인덱스로 보호
- 같은 단어가 2번 있으면 첫 번째만 등록, 두 번째는 무시
- **380단어 중 중복 1개 → 379개로 표시되는 이유**

### 콘텐츠 업데이트 시
- 기존 학습 기록 (known, study_count 등) **완전 유지**
- meaning/association만 최신으로 갱신

---

## 13. 통계 바

### 레이아웃
```
┌──────────┬──────────┬──────────┐
│ 구분 암기 │          │          │
│  학습학습 │   남은   │          │
│          │   개수   │   암기   │
│   0      │    0     │   0 👑   │
│  미암기   │  남은개수 │   암기   │
│          │    0     │          │
│          │  3/17    │          │
└──────────┴──────────┴──────────┘
```

### 각 박스
| 박스 | 색상 | 내용 |
|------|------|------|
| 미암기 | #ff9800 (주황) | 구분/암기학습 토글 + 미암기 단어 수 |
| 남은개수 | #e94560 (빨강) | 남은 단어 수 + 오늘 학습 수 + 날짜 |
| 암기 | #4caf50 (초록) | 암기 단어 수 + 왕관 |

### 오늘 학습 수
- `last_studied`가 오늘 KST 날짜로 시작하는 단어 수
- 자정 이후 자동 초기화 (KST 기준)
- 라벨은 "3/17" 형식으로 날짜 표시

### 활성 박스 표시
- 현재 학습 중인 박스에 빨간 테두리 + 그림자

---

## 14. 설정

설정 아이콘(⚙) 클릭 시 모달 표시

| 설정 항목 | 범위 | 기본값 | 단위 |
|-----------|------|--------|------|
| 시간 제한 | 0.5 ~ 5.0 | 3.0 | 초 |
| 남은개수 단어 수 | 10 ~ 100 | 10 | 개 (10단위) |
| 미암기 단어 수 | 10 ~ 100 | 10 | 개 (10단위) |
| 암기 단어 수 | 10 ~ 100 | 10 | 개 (10단위) |

- 슬라이더 UI
- 변경 즉시 localStorage에 저장
- 현재 퀴즈 중이면 단어 미리보기 표시

---

## 15. 사이드바

### 열기/닫기
- ☰ 버튼 클릭으로 토글
- 오버레이 방식 (왼쪽에서 슬라이드)

### 구성
```
┌─────────────────────┐
│ 저장된 콘텐츠     ✕ │
│                     │
│ 🧠 단어장 제목      │
│        380단어  🗑️  │
│                     │
│ [📥 자료 불러오기]   │
└─────────────────────┘
```

### 콘텐츠별 표시
- 아이콘: 🧠 (mindmap) / 🖼️ (image) / 📝 (text)
- 단어 수 배지 (mindmap만)
- 삭제 버튼 (🗑️)

### 콘텐츠 클릭 시
1. 해당 콘텐츠 로드
2. 사이드바 자동 닫힘
3. `lastViewedContentId` 저장

---

## 16. 콘텐츠 삭제

### 삭제 순서 (await로 순차 실행)
```
1. 확인 대화 표시
2. word_progress 삭제 (content_id 기준, 완료 대기)
3. highlights 삭제 (content_id 기준)
4. contents 삭제
5. 현재 콘텐츠면 UI 초기화
6. 목록 갱신 + 토스트
```

### 완전 삭제 보장
- word_progress 트랜잭션 완료를 `await`로 대기한 후 다음 삭제 진행
- 이전 버그: await 없이 실행 → 데이터 잔류 가능 → 수정 완료

---

## 17. 홈 버튼

```html
<a href="https://vipup.site/memoryking-app" target="_top">🏠</a>
```
- 설정(⚙) 왼쪽에 위치
- `target="_top"` — iframe에서 부모 페이지 전체를 이동

---

## 18. 퀴즈 완료 화면

### 단어가 없을 때
```
🎉
더 이상 학습할 단어가 없습니다
```

### 결과 표시
```
15 / 20
75% 정답
```
→ 1.2초 후 카드 분배 애니메이션 (정답은 초록, 오답은 빨강으로 각 박스로 날아감)

### 격려 메시지
| 정답률 | 아이콘 | 메시지 |
|--------|--------|--------|
| 100% | 👑 | 완벽 그 자체! 당신은 이미 천재입니다 |
| 90%+ | 🌟 | 참 잘했어요! 거의 완벽에 가까워요 |
| 70%+ | 🧠 | 영리한 반복은 당신을 천재로 만듭니다 |
| 50%+ | 🔥 | 반드시 암기할 수 있어요! 노력하는 모습이 멋져요 |
| 50% 미만 | 🌱 | 씨앗은 심어졌어요! 반복할수록 꽃이 핍니다 |

---

## 19. 모바일 대응

### 터치 최적화
- `user-select: none` — 텍스트 선택 차단
- `touch-action: manipulation` — 더블탭 줌 방지
- `-webkit-touch-callout: none` — 길게 누르기 메뉴 차단
- 터치 기기: 버튼 최소 크기 44x44px, 선택지 최소 60px

### 뷰포트 높이 관리
- `window.visualViewport` API 사용
- 모바일 키보드 등장 시 높이 자동 조절
- CSS 변수 `--app-height`로 동적 관리

### 미디어 쿼리 (768px 이하)
- 카드 크기 축소 (max-width: 320px)
- 통계 바 폰트 축소
- Import 다이얼로그 전체 화면
- 구분/암기학습 버튼 "구분\n학습" 줄바꿈 표시

---

## 20. localStorage 저장 값

| 키 | 타입 | 기본값 | 설명 |
|----|------|--------|------|
| `quizTimeLimit` | 정수 (ms) | 3000 | 퀴즈 타이머 |
| `notMemorizedMode` | 문자열 | 'test' | 미암기 모드 ('test' / 'memorize') |
| `wordLimitRemaining` | 정수 | 10 | 남은박스 단어 수 |
| `wordLimitNotMemorized` | 정수 | 10 | 미암기박스 단어 수 |
| `wordLimitMemorized` | 정수 | 10 | 암기박스 단어 수 |
| `lastViewedContentId` | 정수 | - | 마지막 본 콘텐츠 ID |
| `lastUpdateCheck` | 문자열 | - | 마지막 업데이트 체크 날짜 (YYYY-MM-DD) |

---

## 21. CSS 애니메이션

### 카드 관련
| 애니메이션 | 동작 | 시간 |
|-----------|------|------|
| `cascadeIn` | 위에서 아래로 떨어지며 등장 | 0.4초 |
| `cascadePour` | 박스에서 쏟아지듯 등장 (퀴즈 시작) | 0.45초 |
| `flyToBox` | 정답/오답 후 해당 박스로 날아감 | 0.5초 |
| `flashCorrect` | 정답 시 노란 반짝임 | - |
| `flashWrong` | 오답 시 흰색 반짝임 | - |

### 퀴즈 완료
| 애니메이션 | 동작 | 시간 |
|-----------|------|------|
| `distFly` | 결과 카드가 각 박스로 분배 | 0.5초 |
| `statBump` | 카드 도착 시 숫자 튀어오름 | 0.35초 |

### UI 관련
| 애니메이션 | 동작 | 시간 |
|-----------|------|------|
| `fadeIn` | 모달 등장 | 0.3초 |
| `badgePulse` | NEW/UP 배지 크기 펄스 | 2초 (반복) |
| `spin` | 로딩 스피너 회전 | 1초 (반복) |

### 카드 그림자 (깊이감)
```
flashcard-shadow-2: 뒤쪽 두 번째 카드 (작게, 위로)
flashcard-shadow-3: 뒤쪽 세 번째 카드 (더 작게, 더 위로)
```
→ 카드 더미가 쌓여 있는 느낌 연출

---

## 22. 이미지 하이라이트 텍스트 라벨

### 개요
이미지 콘텐츠의 하이라이트 영역에 텍스트 라벨(예: "측우기")을 지정하고, 사용자가 클릭 시 하단에 표시하는 기능.

### Teacher (memoryking-teacher.html)

#### 하이라이트 생성 흐름
```
이미지에서 드래그 → 하이라이트 박스 생성
  → 이전 하이라이트 텍스트 자동 DB 저장
  → 새 하이라이트가 파란 테두리(selected)로 표시
  → 하단 텍스트 입력창 나타남 (커서 자동 포커스)
  → 텍스트 입력 → blur 시 자동 저장
```

#### 이벤트 (setupImageHighlightEvents)
| 동작 | 결과 |
|------|------|
| **클릭** | selectImageHighlight() — 해당 하이라이트 선택, 텍스트 입력창에 기존 텍스트 로드 |
| **길게 누르기 (800ms)** | 삭제 메뉴 표시 |
| 클릭/더블클릭 reveal | 없음 (이미지 하이라이트 전용) |

#### 텍스트 자동 저장 시점
- 다른 하이라이트 클릭 시 (이전 텍스트 저장 후 전환)
- 입력창 blur 시
- 새 하이라이트 생성 시 (이전 것 저장)
- 에어테이블 업로드 시 (exportSingleToAirtable / exportToAirtable)
- 다른 콘텐츠로 전환 시 (displayImage)

#### DB 저장
highlights 스토어에 `highlight_text` 필드 추가:
```
{
  content_id, highlight_type: 'image',
  rect_data, relative_data,
  highlight_text: "측우기",   ← 새 필드
  ...
}
```

#### CSS
| 클래스 | 설명 |
|--------|------|
| `.image-highlight.selected` | 파란 테두리 + 글로우 (편집 중 표시) |
| `.highlight-text-input-area` | 입력 영역 wrapper (기본 숨김) |
| `#highlightTextInput` | 노란 테두리 입력창, 포커스 시 파란색 |

### User (memoryking-user.html)

#### 클릭 시 동작
```
하이라이트 클릭 → revealed 상태
  → 가는 실선 테두리로 영역 표시 (투명 배경)
  → 하단에 텍스트 라벨 오버레이 표시
다른 곳 클릭 → unreveal
  → 텍스트 숨김, 하이라이트 masked 원복
```

#### revealed 스타일
| 상태 | 테두리 |
|------|--------|
| 일반 revealed | `1px solid rgba(255,193,7,0.5)` (노란 가는 실선) |
| 우선순위 revealed | `1px solid rgba(244,67,54,0.5)` (빨간 가는 실선) |

#### 텍스트 표시 영역
- `#highlightTextDisplay` — `.image-wrapper` 안에 `position: absolute; bottom: 0`
- 반투명 배경 (`rgba(22,33,62,0.92)`) + `backdrop-filter: blur(6px)`
- 노란색 텍스트 (`#ffc107`), 1.3em, 굵게

---

## KST 시간 처리

모든 시간은 **한국 표준시(KST, UTC+9)** 기준

| 함수 | 반환 | 용도 |
|------|------|------|
| `getKSTISOString()` | `"2026-03-17T15:30:00.000Z"` | last_studied 저장 |
| `getKSTDateString()` | `"2026-03-17"` | 날짜 비교, 왕관 판정 |

자정 넘김 시 새로고침 없이도 정확한 날짜 적용
