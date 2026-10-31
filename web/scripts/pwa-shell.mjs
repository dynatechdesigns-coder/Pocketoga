// Builds the service worker for each production build: sw.template.js with a
// build id and the list of built files (JS, CSS) to keep for offline. The id
// comes from those file names, which carry content hashes, so every new build
// gets a new worker and a new cache, and the old cache is deleted when it
// takes over. Used by vite.config.js; the pure part is tested.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Always kept, besides the built files: the shell page and the app's icons.
export const STATIC_SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

export function renderServiceWorker(template, builtFiles) {
  const files = [...new Set(builtFiles)].sort();
  const id = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 10);
  return template.replace("__BUILD_ID__", id).replace("__PRECACHE__", JSON.stringify([...STATIC_SHELL, ...files]));
}

export default function pwaShell() {
  return {
    name: "pocketoga-pwa-shell",
    apply: "build",
    generateBundle(_, bundle) {
      const built = Object.keys(bundle)
        .filter((f) => /\.(js|css)$/.test(f))
        .map((f) => `/${f}`);
      const template = readFileSync(new URL("../sw.template.js", import.meta.url), "utf8");
      this.emitFile({ type: "asset", fileName: "sw.js", source: renderServiceWorker(template, built) });
    },
  };
}
