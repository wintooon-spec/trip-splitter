// Service worker: cache-first app shell so the PWA opens offline.
// Firebase, Frankfurter and Anthropic traffic is never intercepted.
const CACHE = "tripsplit-v4";

const SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/main.js",
  "./js/config.js",
  "./js/db.js",
  "./js/currency.js",
  "./js/settle.js",
  "./js/receipt.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const PASS_THROUGH = ["firebasedatabase.app", "firebaseio.com", "api.frankfurter.dev", "api.anthropic.com", "googleapis.com"];

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (PASS_THROUGH.some((h) => url.hostname.endsWith(h))) return;

  // Cache-first with background refresh for the shell and the Firebase
  // CDN modules (gstatic) so the app works fully offline after first load.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetched = fetch(e.request)
        .then((res) => {
          if (res.ok && (url.origin === location.origin || url.hostname === "www.gstatic.com")) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
