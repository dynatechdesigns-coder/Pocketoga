// PocketOga service worker. It keeps only the static app shell (the page, the
// built JS and CSS, the icons) so the app opens with no signal. It never
// answers or stores anything else: API calls, voice notes, photos and every
// shop's data always go to the network. When the network is down the app
// opens from here and the Offline pill and the offline queue take over.
//
// The build id and the file list below are filled in at build time
// (scripts/pwa-shell.mjs), so each build has its own cache and the old one is
// deleted.
const CACHE = "pocketoga-shell-__BUILD_ID__";
const SHELL = new Set(__PRECACHE__);
const NAVIGATION_WAIT_MS = 4000; // a weak signal falls back to the shell too

self.addEventListener("install", (event) => {
  // "reload": always the server's copy, not an older browser-cached one.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...SHELL].map((url) => new Request(url, { cache: "reload" })))));
  // No skipWaiting here: a new version waits until the app is opened again
  // (the page asks for it then), so a running screen never loses its files.
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("pocketoga-shell-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // saving, sending, uploading: network only
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return; // never touched

  // Opening the app: the network first (so a new version shows), the cached
  // shell when there is no signal or it is too slow.
  if (request.mode === "navigate") {
    event.respondWith(
      new Promise((resolve) => {
        const timer = setTimeout(() => caches.match("/").then((hit) => hit && resolve(hit)), NAVIGATION_WAIT_MS);
        fetch(request)
          .then((res) => {
            clearTimeout(timer);
            resolve(res);
          })
          .catch(() => {
            clearTimeout(timer);
            caches.match("/").then((hit) => resolve(hit ?? Response.error()));
          });
      })
    );
    return;
  }

  // Only the shell's own files, cache first. Anything else is not ours.
  if (SHELL.has(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
  }
});
