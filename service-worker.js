// Кэш статических файлов для офлайн-работы. Данные пользователя (слова,
// прогресс) тут ни при чём — они живут в localStorage, это отдельно.
// Имя кэша нужно менять при любом заметном обновлении статических файлов,
// чтобы старые версии не мешали новым (см. bump ?v= в index.html).
const CACHE_NAME = 'kw-static-v17';
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css?v=17',
  './hanja-data.js?v=17',
  './storage.js?v=17',
  './srs.js?v=17',
  './app.js?v=17',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Stale-while-revalidate: сразу отдаём то, что в кэше (быстро, работает
// офлайн), а в фоне подтягиваем свежую версию для следующего раза. Только
// свой источник — GitHub API и Anthropic API не трогаем и не кэшируем.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
