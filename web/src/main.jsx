import React from "react";
import { createRoot } from "react-dom/client";
import Root from "./Root.jsx";
import "./index.css";
import { startInstallCapture } from "./install.js";
import { registerServiceWorker } from "./swRegister.js";

// Keep the browser install prompt from the start; the More menu uses it.
startInstallCapture();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);

// Service worker: only in the built app, so it never serves stale files while
// developing (see swRegister.js for the update rules).
if (import.meta.env.PROD) registerServiceWorker();
