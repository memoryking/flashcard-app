const CACHE_NAME = 'memoryking-v3';
const CACHE_FILES = [
  './memoryking-user.html',
  './guide.html',
  './icon-192.png',
  './icon-512.png',
];

// 설치: 핵심 파일 캐싱 (개별 캐싱 — 일부 파일이 없어도 설치는 성공)
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(CACHE_FILES.map(f => cache.add(f))))
      .then(() => self.skipWaiting())
  );
});

// 활성화: 이전 버전 캐시 삭제
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 요청 처리: HTML은 네트워크 우선 (업데이트 반영), 나머지는 캐시 우선
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API 호출은 항상 네트워크 (실패 시 앱에서 자체 처리)
  if (url.origin !== self.location.origin) return;

  // HTML 파일: 네트워크 우선 + HTTP 캐시 우회(항상 최신), 실패 시 캐시 (오프라인 지원)
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request.url, { cache: 'reload' })
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 이미지 등: 캐시 우선, 없으면 네트워크
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
