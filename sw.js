const CACHE = 'mwb-verplaatslijst-v22';

const BESTANDEN = [
  './index.html',
  './manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(BESTANDEN))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // API-calls nooit cachen — altijd rechtstreeks naar netwerk
  if (e.request.url.includes('workers.dev') || e.request.url.includes('api.notion')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // Statische assets: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
