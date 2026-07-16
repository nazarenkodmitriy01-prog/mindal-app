// Минимальный service worker — нужен, чтобы браузер и инструменты сборки APK
// (PWABuilder) считали сайт полноценным устанавливаемым приложением.
// Данные приложения (зарплаты, график и т.п.) всё равно всегда идут через
// интернет напрямую в Google Таблицу — офлайн-режим для них не нужен и не
// делается, это чисто техническое требование для "устанавливаемости".

const CACHE_NAME = 'mindal-shell-v1';
const SHELL_FILES = ['./payroll_app.html'];

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

// Сеть в приоритете (данные должны быть свежими), кэш — только как запасной
// вариант, если вдруг совсем нет связи.
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
