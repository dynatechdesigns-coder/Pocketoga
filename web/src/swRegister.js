// Service worker registration (installable, opens offline). Plain JavaScript so
// the web tests can run it under node with fake browser objects.
//
// updateViaCache "none": the browser always asks the server for a fresh sw.js
// instead of trusting its HTTP cache. A new version downloads in the background
// and waits; when the app is opened again it takes over and the page reloads
// once, so nobody stays on an old version and a running screen is never swapped
// under the trader.
export const SW_URL = "/sw.js";
export const SW_OPTIONS = { updateViaCache: "none" };
export const UPDATE_CHECK_MS = 10 * 60 * 1000;

// env: { serviceWorker, document, window, location, now } (defaults: the page's own).
export function registerServiceWorker(env = {}) {
  const {
    serviceWorker = globalThis.navigator?.serviceWorker,
    document: doc = globalThis.document,
    window: win = globalThis.window,
    location: loc = globalThis.location,
    now = Date.now,
  } = env;
  if (!serviceWorker) return;

  let reloadForUpdate = false;
  serviceWorker.addEventListener("controllerchange", () => {
    if (reloadForUpdate) loc.reload();
  });

  let lastCheck = -Infinity;
  const checkForUpdate = async (reg) => {
    if (now() - lastCheck < UPDATE_CHECK_MS) return;
    lastCheck = now();
    try {
      await reg.update();
    } catch {
      // offline or the server is down: try again later
    }
  };

  win.addEventListener("load", async () => {
    try {
      const reg = await serviceWorker.register(SW_URL, SW_OPTIONS);
      if (reg.waiting && serviceWorker.controller) {
        reloadForUpdate = true;
        reg.waiting.postMessage("SKIP_WAITING");
      }
      checkForUpdate(reg);
      doc.addEventListener("visibilitychange", () => {
        if (doc.visibilityState === "visible") checkForUpdate(reg);
      });
    } catch {
      // no service worker: the app still works online
    }
  });
}
