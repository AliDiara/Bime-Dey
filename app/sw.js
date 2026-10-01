const CACHE = 'bime-dey-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'jalali.js', 'manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// فقط GET: ابتدا شبکه، در صورت قطعی از کش. درخواست‌های API (POST) هرگز کش نمی‌شوند.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || e.request.url.includes('script.google')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
