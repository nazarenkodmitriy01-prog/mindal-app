// Минимальный service worker для "Миндаль — Брони" — та же логика, что и у
// учётного приложения: сеть в приоритете, кэш — только как запасной вариант.
const CACHE_NAME = 'mindal-bron-shell-v1';
const SHELL_FILES = ['./bron.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
