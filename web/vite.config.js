import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import landingImages from "./scripts/landing-images.mjs";

// In dev, the app calls /api/... and Vite forwards it to the backend, so the
// browser never needs CORS. Point BACKEND_URL elsewhere if the server moves.
// The backend stays plain http; only the browser-to-Vite hop is https.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";

export default defineConfig(({ command, isPreview }) => {
  const dev = command === "serve" && !isPreview;

  // MOCK_CONTRACT=1 is an explicit, development-only switch: /api goes to
  // scripts/mock-contract.mjs, which answers the routes still being built
  // (profit, expenses, products, customers, ledger corrections) with fake
  // data and forwards the rest to the backend. It is read ONLY for the dev
  // server. Builds and vite preview ignore it, so a production bundle never
  // contains the flag, the mock address or any fallback to fake numbers
  // (npm run check:build proves it). Without it, a route the backend does
  // not have yet shows "not available yet" in the app.
  const mock = dev && process.env.MOCK_CONTRACT === "1";
  const apiTarget = mock ? process.env.MOCK_URL ?? "http://localhost:3999" : BACKEND_URL;
  if (mock) console.log(`\n  MOCK_CONTRACT=1: /api uses the mock server at ${apiTarget} (fake data, development only)\n`);

  return {
    // The dev server (npm run dev) runs on https with a self-signed
    // certificate, because phones only allow the microphone on secure pages.
    // landingImages: which landing photos/illustrations exist, and their sizes,
    // decided at build time (virtual:landing-images).
    plugins: [react(), tailwindcss(), landingImages(), dev && basicSsl()],
    // True only while the mock is on in dev; a constant false in builds, so
    // the dev banner is removed from the bundle.
    define: { __MOCK_CONTRACT__: JSON.stringify(mock) },
    server: {
      host: true, // also reachable from a phone on the same Wi-Fi
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
  };
});
