import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// In dev, the app calls /api/... and Vite forwards it to the backend, so the
// browser never needs CORS. Point BACKEND_URL elsewhere if the server moves.
// The backend stays plain http; only the browser-to-Vite hop is https.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";

// MOCK_CONTRACT=1: send /api to scripts/mock-contract.mjs instead, which
// answers the routes still being built (profit, expenses, products,
// customers, ledger corrections) with fake data and forwards the rest to
// the backend. Drop the flag once the real routes exist.
const API_TARGET = process.env.MOCK_CONTRACT === "1" ? process.env.MOCK_URL ?? "http://localhost:3999" : BACKEND_URL;

export default defineConfig(({ command, isPreview }) => ({
  // The dev server (npm run dev) runs on https with a self-signed
  // certificate, because phones only allow the microphone on secure pages.
  // Builds and vite preview are untouched.
  plugins: [react(), tailwindcss(), command === "serve" && !isPreview && basicSsl()],
  server: {
    host: true, // also reachable from a phone on the same Wi-Fi
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
}));
