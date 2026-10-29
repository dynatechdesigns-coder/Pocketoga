import React from "react";
import { createRoot } from "react-dom/client";
import Root from "./Root.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);

// Service worker (makes the app installable). Only in the built app, so it
// never serves stale files while developing.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}
