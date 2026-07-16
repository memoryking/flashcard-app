# 단어풀(Word Pool) 연동 — 이 저장소에서 알아야 할 것

> **영단어·한자 콘텐츠는 이 저장소에 없습니다.** 별도 프로젝트에서 관리합니다.
> 📁 **`C:\Users\memoryking\00_DEV\word-pool`** (flashcard-app과 **형제 폴더**)
> 🔐 백업: **`github.com/memoryking/word-pool` (Private)** — `word_pool.db` 포함
>
> 문서: `word-pool/README.md`(사용법) · `SETS_PLAN.md`(아키텍처) · `WORKLOG.md`(주제별·함정) · `DEVLOG.md`(시간순 개발기록)

## 왜 분리되어 있나 (합치면 안 되는 이유)
- **이 저장소(flashcard-app)는 공개(public)** 다. word-pool 에는 **교사 토큰**(`scripts/.worker.config.json`)과
  **`word_pool.db`(전체 단어 자산)** 가 있어, 밑에 두면 `.gitignore` 실수 한 번에 유출된다.
  → word-pool 은 **비공개 저장소**로 따로 백업한다.
- 배포 방식도 다르다 — 이 저장소는 **push = 배포**(GitHub Pages/Vercel), word-pool 은 로컬 도구.

## 어떻게 연결되나 (풀 참조 아키텍처)
```
word_pool.db (원천: 뜻·발음·암기법·예문·image_url·video_url)
   ├─ push_op_pool.py ──▶ nocodebackend op_pool          ← 서버 사본
   └─ publish.py ──────▶ onepage-user/word-images.json   ← 단어→이미지 URL (이 저장소)

onepage-teacher.html  📥 단어 일괄 추가 → 단어마다
      op_subtopics(title=단어) + op_items(text="@@WORD:단어@@")   ← 내용 저장 안 함(참조만)
                                   │ 서빙 시
onepage-worker/worker.js  derefWordItems() → op_pool 에서 뒷면 HTML 조합
                                   ▼
onepage-user  카드 뒷면 자동 완성 + 이미지 자동 매칭(word-images.json)
```
- **풀을 고치면** → 관리콘솔 **☁️ 서버 반영**(= export_op_pool + push_op_pool) → **그 단어가 든 모든 콘텐츠 자동 갱신**
- **적용 범위**: 영단어·한자만. 한국사·수학·과학 등은 **기존 방식**(op_items 에 본문 저장) 그대로
- **결제·진도·통계**는 기존 그대로 (서버 DB 유지)

## 이 저장소에서 관련된 파일
| 파일 | 역할 |
|---|---|
| `onepage-worker/worker.js` | `derefWordItems` / `composeWordCardHTML` / `POST /admin/op_pool/sync` |
| `onepage-teacher.html` | **📥 단어 일괄 추가**(중복제외·알파벳/입력순) · **🚀 발행 점검** · 🗂️ 단어풀 탭 |
| `onepage-user/index.html` | `wordImageFor()` — 카드 제목(단어)으로 이미지 자동 매칭 |
| `onepage-user/word-images.json` | 단어 → 이미지 URL (1004개, word-pool 의 `publish.py` 가 생성) |
| `word-pool.json` | teacher앱 🗂️ 단어풀 탭용 export (word-pool 의 `export_pool.py` 가 생성) |

스키마: [ONEPAGE_SCHEMA.md § B7 `op_pool`](ONEPAGE_SCHEMA.md) · [§ B4 `op_items` 단어풀 참조 규약](ONEPAGE_SCHEMA.md)

## 자주 쓰는 흐름
```
# 단어 내용을 고쳤다 → 모든 콘텐츠에 반영
word-pool: 관리콘솔.bat → ✏️편집 → ☁️ 서버 반영

# 새 이미지를 배포했다 → 학생앱 반영
word-pool: 콘솔 🚀 배포  (word-images.json 갱신 + 이 저장소로 커밋·푸시)

# 새 단어묶음을 만든다
onepage-teacher → 📥(✨ 새 콘텐츠로 발행) → 단어 붙여넣기 → 🚀 발행 점검 → 공개
```
