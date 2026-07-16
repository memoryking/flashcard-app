# flashcard/ — 참고용 아카이브 (배포 대상 아님)

원페이지 학습(`onepage-*`)의 **이전 세대 앱**들. 개발하면서 참고하려고 남겨둔 것으로
**서비스에 쓰이지 않는다. 고치지 말 것.** 현행 기능은 전부 `onepage-*` 쪽에 있다.

## 왜 루트가 아니라 이 폴더에 있나 — 배포 사고 방지

배포 표면이 **둘**이고, 서빙 범위가 다르다.

| 표면 | 서빙 범위 | 이 폴더는 |
|---|---|---|
| **Vercel** — 학생앱 (memoryking.kr) | 프로젝트 **Root Directory = `onepage-user/`** | 애초에 배포에 **미포함** |
| **GitHub Pages** — 선생님앱·랜딩 | **저장소 루트 전체** | 루트에 두면 **공개 URL이 생김** |

즉 위험한 쪽은 **Pages**다. 루트에 두면 옛 앱이 그대로 공개 서빙된다.

### 진짜 문제였던 것 — `sw.js` (service worker)

- **루트에 있던 시절**: `memoryking-user.html`이 `./sw.js`를 등록 → scope가 **`/flashcard-app/`**.
  service worker는 **scope 아래 모든 요청을 가로챈다** → 같은 origin의
  **`onepage-teacher.html`과 `onepage-user/`까지 가로채고 캐시**했다.
  → *"배포했는데 자꾸 옛날 게 나온다"* 의 원인.
- **이 폴더로 옮긴 뒤**: 등록 경로가 `/flashcard-app/flashcard/sw.js` → scope가
  **`/flashcard-app/flashcard/`** 안으로 갇힌다. 원페이지 앱에 영향 없음.
- 루트 `/flashcard-app/sw.js`는 이제 **404** → 예전에 등록된 service worker는
  브라우저가 업데이트를 확인할 때 **자동으로 등록 해제**된다. 별도 조치 불필요.

> 정리: **문서만으로는 못 막고, 폴더로 격리하는 것 자체가 대책이다.** 이 문서는 그 위에 얹는 설명.

## 규칙

1. 이 폴더는 **읽기 전용**으로 취급 — 참고만 하고 수정하지 않는다.
2. **루트로 다시 꺼내지 말 것.** 꺼내는 순간 Pages에 공개되고 `sw.js` scope 사고가 재발한다.
3. 여기에 옛 파일을 추가할 때 `sw.js` / `manifest` / `icon` 류가 딸려오면
   **경로가 이 폴더 안으로 닫히는지** 반드시 확인한다.
4. 참고하다 되살릴 코드가 있으면 **복사**해서 `onepage-*` 쪽에 옮겨 쓴다.

## 무엇이 들어있나

| 파일 | 설명 |
|---|---|
| `memoryking-user*.html` | 학생앱 이전 세대 (PWA 전 / 이벤트 전 / 학습그래프 생성 전 …) |
| `memoryking-teacher*.html` | 선생님앱 이전 세대 |
| `flashcard-*.html`, `mathmac-*.html`, `higllight-user.html` | 더 이전 세대 앱들 |
| `landing.html`, `guide.html`, `image-guide.html`, `purchase-section.html` | 옛 랜딩·가이드·결제 섹션 |
| `stats-worker/` | 옛 통계 워커 (현행은 루트 `onepage-worker/`) |
| `sw.js`, `icon-*.png`, `_guide_img_b64.txt` | 옛 PWA 자산 |
| `55910_flashcard_app_swagger.json` | 옛 nocodebackend 스펙 |
| `FEATURES.md` | **옛 세대 문서.** 현행은 루트 [ONEPAGE_FEATURES.md](../ONEPAGE_FEATURES.md) |

현행 문서: [ONEPAGE_FEATURES.md](../ONEPAGE_FEATURES.md) · [ONEPAGE_SCHEMA.md](../ONEPAGE_SCHEMA.md) · [WORD_POOL.md](../WORD_POOL.md)
