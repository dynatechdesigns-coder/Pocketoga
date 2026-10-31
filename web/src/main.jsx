import React from "react";
import { createRoot } from "react-dom/client";
import Root from "./Root.jsx";
import "./index.css";
import { startInstallCapture } from "./install.js";

// Keep the browser install prompt from the start; the More menu uses it.
startInstallCapture();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);

// Service worker (installable, opens offline). Only in the built app, so it
// never serves stale files while developing. A new version downloads in the
// background and waits; when the app is opened again it takes over and the
// page reloads once, so nobody stays on an old version and a running screen
// is never swapped under the trader.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  let reloadForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadForUpdate) location.reload();
  });
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      if (reg.waiting && navigator.serviceWorker.controller) {
        reloadForUpdate = true;
        reg.waiting.postMessage("SKIP_WAITING");
      }
      reg.update().catch(() => {}); // look for a newer build on every open
    } catch {
      // no service worker: the app still works online
    }
  });
}
