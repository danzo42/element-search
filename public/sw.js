// データを更新したら VERSION を上げる（端末側のキャッシュが入れ替わる）
const VERSION = 'peacock-ele-v62';
const VENDOR = 'peacock-vendor-v1';   // 部品(vendor/)用。部品を差し替えるときだけ番号を上げる
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'camera.js',
  'paddle.js',
  'data.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

// 新しい版は待たずに有効化する（データ更新が次回起動時に自動で反映される）
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // 同じ配信元の別アプリのキャッシュは消さない。このアプリの名前の旧版だけを削除する
      .then((keys) => Promise.all(keys
        .filter((k) => (k.startsWith('peacock-ele-') && k !== VERSION) || (k.startsWith('peacock-vendor-') && k !== VENDOR))
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// オフラインでも使えるよう、キャッシュ優先で返す
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          // 文字認識の部品（約22MB）は、アプリのデータ更新のたびに取り直さないよう別の保存領域に置く
          const target = new URL(req.url).pathname.includes('/vendor/') ? VENDOR : VERSION;
          caches.open(target).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    })
  );
});
