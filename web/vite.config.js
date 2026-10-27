import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the app calls /api/... and Vite forwards it to the backend, so the
// browser never needs CORS. Point BACKEND_URL elsewhere if the server moves.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // also reachable from a phone on the same Wi-Fi
    proxy: {
      "/api": {
        target: BACKEND_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
