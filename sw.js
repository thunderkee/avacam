// AvaCam service worker: makes the app installable and usable offline after the first visit.
//  - App files (same origin): network first, so a deploy shows up straight away; cache when offline.
//  - CDN libraries and models (pinned versions): cache first, they never change at a given URL.
// Bump VERSION on a deploy that changes the file list below. (Fighter models aren't listed: they
// are cached the first time each one is picked, so installing doesn't download all of them.)
const VERSION = 'avacam-v9';
const APP_CACHE = `${VERSION}-app`;
const CDN_CACHE = `${VERSION}-cdn`;

const APP_FILES = [
  './', 'index.html', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
  'js/app.js', 'js/performance.js', 'js/blurb-render.js', 'js/blurb3d.js', 'js/toys3d.js', 'js/voice-fx.js', 'js/voice-worker.js', 'js/bda.js', 'js/captions.js',
  'blurb/cmu-dictionary.js', 'blurb/lipsync.js', 'blurb/motion.js', 'blurb/face-sync.js', 'blurb/rig.js', 'blurb/svg-path.js', 'blurb/character-kit.js',
  'lab/', 'lab/index.html', 'lab/lab.css', 'lab/lab.js', 'lab/bases.js', 'lab/blocks.js', 'lab/meshkit.js', 'lab/rig.js',
];
// Hosts whose files are versioned in the URL (safe to keep forever).
const CDN_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (!key.startsWith(VERSION)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(APP_CACHE)).put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
      }
    })());
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') (await caches.open(CDN_CACHE)).put(req, res.clone());
      return res;
    })());
  }
});
