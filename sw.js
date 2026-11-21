// Caches the app so it opens with no internet. Bump VERSION when files change.
const VERSION = 'wayfare-v5';
const FILES = ['./', './index.html', './app.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Shared from Google Maps: hand the shared text to the app's "new restaurant" form.
  if (url.pathname.endsWith('/share')) {
    const p = new URLSearchParams(url.search); p.set('share', '1');
    e.respondWith(Response.redirect('./#/r-new?' + p.toString(), 303));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).catch(() => caches.match('./index.html'))));
});
