/*
 * Ровно столько service worker, сколько нужно, чтобы Cord можно было поставить на экран
 * «Домой» и чтобы обрыв сети не встречал белой страницей.
 *
 * ПОЧЕМУ НЕ PRECACHE. Service worker — единственная правка, способная залипнуть у человека
 * навсегда: страница, положенная в кэш, переживает выкатку и продолжает запрашивать файлы,
 * которых на сервере уже нет. Поэтому навигации идут в сеть **всегда**, а кэш держит только
 * копию на случай, когда сети нет вовсе.
 *
 * Файлы под /assets/ несут хеш в имени — их содержимое не меняется никогда, и кэшировать их
 * безопасно. Всё остальное — API, медиа, загрузки — сюда не попадает: у запроса к встрече не
 * бывает правильного устаревшего ответа.
 */
const CACHE = 'cord-shell-v1';
const SHELL = '/index.html';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(SHELL))
      .catch(() => {}),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, fallback) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      caches
        .open(CACHE)
        .then((cache) => cache.put(fallback ?? request, copy))
        .catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await caches.match(fallback ?? request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const copy = response.clone();
    caches
      .open(CACHE)
      .then((cache) => cache.put(request, copy))
      .catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Встреча, файлы и сам установщик мимо: устаревший ответ здесь хуже, чем никакого.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/uploads/') ||
    url.pathname.startsWith('/downloads/') ||
    url.pathname.startsWith('/rtc')
  )
    return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL));
    return;
  }
  if (url.pathname.startsWith('/assets/')) event.respondWith(cacheFirst(request));
});
