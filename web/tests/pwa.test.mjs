// Web tests for the installable app: the manifest, the page links, and the
// service worker's rules (run in a sandbox with fake caches and fetch).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import vm from "node:vm";

const { STATIC_SHELL, renderServiceWorker } = await import("../scripts/pwa-shell.mjs");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("public/manifest.webmanifest"));
const template = read("sw.template.js");

describe("manifest and page", () => {
  test("name, start, display and colours", () => {
    assert.equal(manifest.name, "PocketOga");
    assert.equal(manifest.short_name, "PocketOga");
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.theme_color, "#f7f8fc"); // the light page colour in index.html
    assert.equal(manifest.background_color, "#f7f8fc");
  });

  test("192 and 512 icons exist on disk", () => {
    for (const size of ["192x192", "512x512"]) {
      const icon = manifest.icons.find((i) => i.sizes === size && i.type === "image/png");
      assert.ok(icon, size);
      assert.ok(existsSync(new URL(`../public${icon.src}`, import.meta.url)), icon.src);
    }
  });

  test("index.html links the manifest and sets theme-color", () => {
    const html = read("index.html");
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(html, /<meta name="theme-color" content="#f7f8fc"/);
  });
});

describe("build step", () => {
  test("fills in the id and the list; a different build gets a different id", () => {
    const a = renderServiceWorker(template, ["/assets/index-AAA.js", "/assets/index-AAA.css"]);
    const b = renderServiceWorker(template, ["/assets/index-BBB.js", "/assets/index-AAA.css"]);
    assert.doesNotMatch(a, /__BUILD_ID__|__PRECACHE__/);
    assert.match(a, /\/assets\/index-AAA\.js/);
    assert.notEqual(a.match(/pocketoga-shell-\w+/)[0], b.match(/pocketoga-shell-\w+/)[0]);
    assert.equal(a, renderServiceWorker(template, ["/assets/index-AAA.css", "/assets/index-AAA.js"])); // order does not matter
  });

  test("the shell holds only the page, the manifest, icons and built files", () => {
    assert.deepEqual(STATIC_SHELL, ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"]);
  });
});

// Runs the worker in a sandbox and returns what it did for each request.
function sandbox({ fetchImpl, cached = {} } = {}) {
  const listeners = {};
  const store = new Map(Object.entries(cached));
  const caches = {
    open: async () => ({ addAll: async () => {} }),
    keys: async () => ["pocketoga-shell-old", "other-app"],
    delete: async (k) => void deleted.push(k),
    match: async (req) => store.get(typeof req === "string" ? req : new URL(req.url).pathname) ?? undefined,
  };
  const deleted = [];
  const self = { addEventListener: (t, fn) => (listeners[t] = fn), location: { origin: "https://app.test" }, clients: { claim: async () => {} }, skipWaiting: () => (self.skipped = true) };
  const sw = renderServiceWorker(template, ["/assets/index-AAA.js", "/assets/index-AAA.css"]);
  vm.runInNewContext(sw, { self, caches, URL, Request: class { constructor(url) { this.url = url; } }, Response, fetch: fetchImpl ?? (async () => new Response("net")), setTimeout, clearTimeout });
  const fetched = [];
  async function request(path, { method = "GET", mode = "cors" } = {}) {
    const req = { url: `https://app.test${path}`, method, mode };
    let answer;
    let handled = false;
    listeners.fetch({ request: req, respondWith: (p) => ((handled = true), (answer = p)) });
    return { handled, response: handled ? await answer : null };
  }
  return { listeners, request, deleted, self, fetched };
}

describe("service worker rules", () => {
  test("API calls, audio, photos and shop data are never handled", async () => {
    const s = sandbox({ cached: { "/api/ledger": new Response("secret") } });
    for (const path of ["/api/ledger", "/api/debts", "/api/photo-checks/unconfirmed", "/api/propose", "/api"]) {
      assert.equal((await s.request(path)).handled, false, path);
    }
    for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await s.request("/api/propose", { method })).handled, false);
    assert.equal((await s.request("/assets/index-AAA.js", { method: "POST" })).handled, false);
  });

  test("files outside the shell are left to the network", async () => {
    const s = sandbox();
    for (const path of ["/landing/photos/x.webp", "/recording.wav", "/photo.jpg", "/assets/other-ZZZ.js"]) {
      assert.equal((await s.request(path)).handled, false, path);
    }
  });

  test("shell files come from the cache first", async () => {
    const cached = new Response("cached js");
    const s = sandbox({ cached: { "/assets/index-AAA.js": cached }, fetchImpl: async () => new Response("net") });
    const { handled, response } = await s.request("/assets/index-AAA.js");
    assert.equal(handled, true);
    assert.equal(await response.text(), "cached js");
  });

  test("opening the app with no signal gives the cached shell", async () => {
    const s = sandbox({ cached: { "/": new Response("<html>shell") }, fetchImpl: async () => Promise.reject(new TypeError("offline")) });
    const { response } = await s.request("/money", { mode: "navigate" });
    assert.equal(await response.text(), "<html>shell");
  });

  test("opening the app online uses the network, so a new version shows", async () => {
    const s = sandbox({ cached: { "/": new Response("old shell") }, fetchImpl: async () => new Response("new shell") });
    const { response } = await s.request("/", { mode: "navigate" });
    assert.equal(await response.text(), "new shell");
  });

  test("activating deletes older shell caches only", async () => {
    const s = sandbox();
    let done;
    s.listeners.activate({ waitUntil: (p) => (done = p) });
    await done;
    assert.deepEqual(s.deleted, ["pocketoga-shell-old"]);
  });

  test("a new version waits until the page asks it to take over", () => {
    const s = sandbox();
    s.listeners.install({ waitUntil() {} });
    assert.equal(s.self.skipped, undefined);
    s.listeners.message({ data: "SKIP_WAITING" });
    assert.equal(s.self.skipped, true);
  });
});
