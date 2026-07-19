# 오류 신고 + 후기 게시판 — 구현 명세 (2026-07-19 착수)

> 사용자 요구 원문 요약: ① 학생앱에서 오류 신고(단원·문제 선택+내용) → CRM 등록 + 관리자(01056426775) 문자
> → CRM에서 수동검사 + AI 검증 프롬프트 자동작성(복붙용) + 사용자 피드백(문자·메일) 최대 자동화
> → 채택 시 포인트 적립(기본값 수정 가능, 공헌 크면 증액) + 감사 문자(포인트 안내 포함)
> ② 후기 1인 1회 작성 → AI가 긍정/부정 자동 분류 → 관리자 문자 → 긍정 중 채택 → 학생 메인 하단
> **자동 스크롤 마퀴**로 노출(이름 부분 마스킹) + 채택자 포인트 + 감사 문자

## 재사용 인프라 (확인 완료)
- **SMS·이메일**: worker의 Pabbly 웹훅 (`channel: 'sms'|'email'|'both'` — 캠페인 발송 코드 worker.js:2131 패턴 재사용)
- **포인트**: `atUpdate(env, AT_USERS, rec.id, { point: newPoint })` + 포인트 트랜잭션 기록 패턴 (worker.js:1797)
- **감성 분석**: Cloudflare Workers AI 바인딩 (wrangler.toml `[ai]` + `env.AI.run('@cf/meta/llama-3.1-8b-instruct', ...)` — 무료, API 키 불필요). 실패 시 'pending'으로 두고 CRM에서 수동 분류 폴백
- **관리자 번호**: 01056426775 (worker 환경변수 ADMIN_PHONE로)

## ⛔ 선행 작업 ✅ 완료 (테이블 2개 생성됨, created_at/updated_at=DATETIME) — 사용자가 nocodebackend 대시보드에서 테이블 2개 생성 (op_pool 때와 동일)

### 테이블 1: `op_error_reports`
| 컬럼 | 타입 | 비고 |
|---|---|---|
| user_phone | VARCHAR(255) | 신고자 |
| user_name | VARCHAR(255) | |
| chapter_id | INT | |
| chapter_title | VARCHAR(255) | |
| subtopic_id | INT | 0 허용(챕터 전반 신고) |
| subtopic_title | VARCHAR(255) | |
| content | TEXT | 신고 내용 |
| status | VARCHAR(255) | Default 'new' (new/checking/adopted/rejected/answered) |
| points_awarded | INT | Default 0 |
| admin_note | TEXT | |
| created_at | VARCHAR(255) | |
| updated_at | VARCHAR(255) | |

### 테이블 2: `op_reviews`
| 컬럼 | 타입 | 비고 |
|---|---|---|
| user_phone | VARCHAR(255) | 1인 1회 검사 키 |
| user_name | VARCHAR(255) | |
| content | TEXT | |
| sentiment | VARCHAR(255) | Default 'pending' (positive/negative/neutral/pending) |
| adopted | INT | Default 0 |
| points_awarded | INT | Default 0 |
| created_at | VARCHAR(255) | |
| updated_at | VARCHAR(255) | |

## 구현 단계 (테이블 생성 후)

### P1 — worker ✅ 완료(2026-07-19, 배포 934fea89) — ncbRead는 {data:[…]} 반환·필터에 선행 & 금지 주의 (onepage-worker/worker.js + wrangler.toml)
- wrangler.toml에 `[ai]` binding = "AI", vars에 ADMIN_PHONE
- `sendAdminSms(env, text)` / `sendUserMsg(env, phone, email, channel, text)` — Pabbly 웹훅 재사용
- `POST /error-reports` (인증): 등록 + 관리자 SMS "🐛 오류신고: {단원}/{문제} — {내용 앞 40자}"
- `GET /error-reports/mine` (인증): 내 신고 목록/상태 (학생앱 표시용)
- 관리자 전용 (teacherGate): `GET /admin/error-reports?status=`, `PUT /admin/error-reports/:id`
  (status·admin_note 변경), `POST /admin/error-reports/:id/adopt` {points} →
  포인트 적립 + 트랜잭션 기록 + 감사 SMS("소중한 제보 감사합니다. {P}P 적립!") + status=adopted
- `POST /admin/error-reports/:id/feedback` {channel, message} → 신고자에게 문자/메일
- `POST /reviews` (인증): 1인 1회 검사(기존 존재 시 409) → Workers AI 감성분류(ko 프롬프트,
  JSON {sentiment}) → 저장 + 관리자 SMS "⭐ 새 후기({sentiment}): {내용 앞 40자}"
- `GET /reviews/adopted` (무인증·캐시 10분): 채택 후기 목록 {masked_name, content} — 이름 마스킹은
  서버에서: 2자=첫+*, 3자+=첫+*…+끝
- 관리자: `GET /admin/reviews?sentiment=`, `POST /admin/reviews/:id/adopt` {points} (포인트+감사SMS),
  `PUT /admin/reviews/:id` (sentiment 수동 재분류, adopted 해제)

### P2 — 학생앱 ✅ 완료 (onepage-user/index.html)
- 메인(홈) 하단: 「🐛 오류 제보」 버튼 → 모달: 챕터 선택(내 접근 챕터) → (선택) 학습카드 선택 → 내용
  textarea → 제출 → "접수되었습니다" + 내 신고 상태 보기
- 홈 최하단: 채택 후기 **자동 무한 스크롤 마퀴** (CSS keyframes, 호버 시 일시정지, /reviews/adopted)
- 「⭐ 후기 쓰기」 버튼 (이미 작성했으면 "이미 참여하셨습니다")

### P3 — CRM ✅ 완료 (onepage-crm/index.html)
- 「🐛 오류신고」 탭: 목록(status 필터) / 상세 / 버튼: [🔍 AI 검증 프롬프트 복사](문제·신고내용 포함
  검증 프롬프트 조립 — math-bank 검증 프롬프트 스타일) / [✅ 채택+포인트](기본값 입력칸, 수정 가능 —
  localStorage 'crm_err_pts' 기본 500) / [반려] / [피드백 보내기](문자/메일 선택, 템플릿 자동 채움)
- 「⭐ 후기」 탭: 긍정/부정/보류 필터 / [✅ 채택+포인트](기본 'crm_rev_pts' 300, 수정 가능) /
  감성 수동 변경 / 채택 해제
- 처리 시 CRM에서 최대 자동: 채택 버튼 하나로 포인트+문자+상태 변경이 한 번에

### P4 — 검증·배포 ✅ 완료 (2026-07-19 전 구간 실사용 테스트 통과)
- 워커 배포(`npx wrangler deploy`) 전 신규 테이블 존재 확인 (NCB는 잘못된 필드 묵음 무시 함정)
- 학생앱은 push=배포. CRM은 Vercel(onepage-crm) — push로 배포되는지 확인 필요
- 문서: ONEPAGE_FEATURES.md 신규 섹션 + ONEPAGE_SCHEMA.md 테이블 2개 + 캔버스

## 정책 기본값 (CRM에서 수정 가능)
- 오류 채택 기본 500P, 후기 채택 기본 300P (localStorage 저장, 채택 시마다 조정 가능)
- 문자 문구: 오류 "「원페이지 학습」 소중한 오류 제보 감사합니다! 확인 후 {P}포인트를 적립해 드렸습니다 🙏" /
  후기 "「원페이지 학습」 따뜻한 후기 감사합니다! {P}포인트를 적립해 드렸습니다 💜"


## 최종 확정 사항 (테스트 반영, 2026-07-19)
- **오류 제보는 문제형(수학) 카드에만**: 홈 버튼 제거, `caption='암기카드'` 보유 카드에만 🐛 버튼
  (일반 펼침·다지기·집중 세션 3곳). → 모든 신고에 문제가 자동 지정됨
- **문자 발신 경로 분리**: SMS는 재설정 워크플로(Webhook→SOLAPI 직행) — ChatGPT 문구 변형 차단.
  이메일은 캠페인 워크플로(Gmail 라우트)
- **감성 분류**: llama-3.1-8b 폐기(2026-05-30) → 모델 체인(llama-3.3-70b→llama-4→gpt-oss)
  + 키워드 휴리스틱 폴백. CRM 🤖 재분류 버튼으로 재시도 가능
- **CRM 오류신고 카드**: 📖 문제·해설 인라인 보기(MathJax·SVG 렌더) / 🔍 검증 프롬프트에
  원문+SVG 코드 동봉(그래프 오판 방지) / 🗑 삭제 / 피드백 이력 admin_note 누적
- **CRM 후기**: 홈 노출중 필터 / 노출 해제 / 🗑 삭제 / 감성 수동 변경
- 학생 가이드 6+ 섹션(참여하고 포인트 받기) 추가
