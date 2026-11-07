/* Audabook — service worker: keeps the app working with no internet once it has been opened.
   Each release is cached as one complete set (the build stamps CACHE_VERSION), so the app always runs a
   single, whole version; a new release downloads in full in the background and takes over in one step. */
const CACHE = 'audabook-CACHE_VERSION';
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/util.js',
  'js/wav.js',
  'js/zip.js',
  'js/model.js',
  'js/peaks.js',
  'js/storage.js',
  'js/songsfolder.js',
  'js/autotune.js',
  'js/effects.js',
  'js/engine.js',
  'js/exporter.js',
  'js/projectfile.js',
  'js/ui.js',
  'js/timeline.js',
  'js/app.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's copies (GitHub lets those be reused for 10 minutes),
  // so a new release can never be saved with old files mixed in.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('audabook-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Serve the app from this release's set (fast, and works offline). Files are never refreshed one by one:
// updates arrive only as a whole new release, so old and new files can't get mixed.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true }) ||
      (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (err) {
      return new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
