// Web tests for last known data: save and load, per-shop privacy, the label,
// network failure versus a server error, the GET time limit, and deleting a
// shop's copy. Fake IndexedDB, fake localStorage, fake fetch; fake data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

const { ApiError, GET_TIMEOUT_MS, getDebts, setShop } = await import("../src/api.js");
const { connection } = await import("../src/connection.js");
const { createSavedData, withoutPhones } = await import("../src/savedData.js");
const { loadWithSaved } = await import("../src/loadWithSaved.js");
const { lastUpdated, lastUpdatedSpoken, oldestSaved, retryDelayMs } = await import("../src/savedLabel.js");

// --- fakes ---------------------------------------------------------------------

function fakeLocalStorage({ broken = false } = {}) {
  const map = new Map();
  const fail = () => {
    if (broken) throw new Error("blocked");
  };
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (fail(), map.get(k) ?? null),
    setItem: (k, v) => (fail(), void map.set(k, String(v))),
    removeItem: (k) => (fail(), void map.delete(k)),
  };
}

// Just enough IndexedDB for savedData: one store, put / get / getAll / delete.
function fakeIdb() {
  const rows = new Map();
  const request = (fn) => {
    const req = {};
    queueMicrotask(() => {
      try {
        req.result = fn();
        req.onsuccess?.();
      } catch (e) {
        req.error = e;
        req.onerror?.();
      }
    });
    return req;
  };
  const db = {
    createObjectStore() {},
    transaction: () => ({
      objectStore: () => ({
        put: (row) => request(() => void rows.set(row.id, structuredClone(row))),
        get: (id) => request(() => (rows.has(id) ? structuredClone(rows.get(id)) : undefined)),
        getAll: () => request(() => [...rows.values()].map((r) => structuredClone(r))),
        delete: (id) => request(() => void rows.delete(id)),
      }),
    }),
  };
  return {
    rows,
    open() {
      const req = { result: db };
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

const failingIdb = { open: () => { const req = {}; queueMicrotask(() => req.onerror?.()); return req; } };

const realFetch = globalThis.fetch;
beforeEach(() => {
  setShop("shop-a");
  connection.setDeviceOnline(true);
  connection.reportReached();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

// --- save and load -------------------------------------------------------------

describe("save and load", () => {
  test("IndexedDB: saves the answer with the shop and the time, and loads it back", async () => {
    const idb = fakeIdb();
    const s = createSavedData({ idb, ls: fakeLocalStorage(), now: () => Date.parse("2026-10-31T09:10:00Z") });
    assert.equal(await s.save("shop-a", "money", { owed: { totalKobo: 5000 } }), true);
    const [row] = [...idb.rows.values()];
    assert.equal(row.shopId, "shop-a");
    assert.equal(row.savedAt, "2026-10-31T09:10:00.000Z");
    assert.deepEqual(await s.load("shop-a", "money"), { data: { owed: { totalKobo: 5000 } }, savedAt: "2026-10-31T09:10:00.000Z" });
  });

  test("another shop's data is never returned", async () => {
    const s = createSavedData({ idb: fakeIdb(), ls: fakeLocalStorage() });
    await s.save("shop-a", "money", { a: 1 });
    assert.equal(await s.load("shop-b", "money"), null);
    assert.equal(await s.load("shop-a", "debts"), null);
  });

  test("falls back to localStorage when IndexedDB is missing or fails", async () => {
    for (const idb of [undefined, null, failingIdb]) {
      const ls = fakeLocalStorage();
      const s = createSavedData({ idb, ls });
      assert.equal(await s.save("shop-a", "money", { n: 2 }), true);
      assert.deepEqual((await s.load("shop-a", "money")).data, { n: 2 });
      assert.ok([...ls.map.keys()][0].startsWith("pocketoga.saved.shop-a."));
    }
  });

  test("blocked storage: save says false, load says null, nothing throws", async () => {
    const s = createSavedData({ idb: undefined, ls: fakeLocalStorage({ broken: true }) });
    assert.equal(await s.save("shop-a", "money", { n: 1 }), false);
    assert.equal(await s.load("shop-a", "money"), null);
    await s.clearShop("shop-a");
    const none = createSavedData({ idb: undefined, ls: null });
    assert.equal(await none.save("shop-a", "money", {}), false);
  });

  test("debts are saved without phone numbers", () => {
    const out = withoutPhones({ debts: [1], customers: [{ id: 1, name: "Ada", phone: "2348030000011", owedKobo: 5 }] });
    assert.equal(out.customers[0].phone, null);
    assert.equal(out.customers[0].name, "Ada");
    assert.deepEqual(out.debts, [1]);
  });
});

// --- sign out ------------------------------------------------------------------

describe("deleting on sign-out or switching shops", () => {
  test("clearShop removes that shop from both stores and leaves other shops alone", async () => {
    const idb = fakeIdb();
    const ls = fakeLocalStorage();
    const s = createSavedData({ idb, ls });
    await s.save("shop-a", "money", { a: 1 });
    await s.save("shop-b", "money", { b: 1 });
    // a copy that only ever reached localStorage (the IndexedDB write failed once)
    ls.setItem("pocketoga.saved.shop-a.debts", JSON.stringify({ savedAt: "x", data: {} }));
    await s.clearShop("shop-a");
    assert.equal(await s.load("shop-a", "money"), null);
    assert.equal(await s.load("shop-a", "debts"), null);
    assert.deepEqual((await s.load("shop-b", "money")).data, { b: 1 });
    assert.deepEqual([...ls.map.keys()].filter((k) => k.includes("shop-a")), []);
  });

  test("Root clears the shop on sign-out, on a session end and when another shop opens", () => {
    const root = readFileSync(new URL("../src/Root.jsx", import.meta.url), "utf8");
    assert.equal((root.match(/savedData\.clearShop/g) ?? []).length, 3);
  });
});

// --- the label -----------------------------------------------------------------

describe("label", () => {
  const now = Date.parse("2026-10-31T10:30:00Z"); // 11:30 in Lagos

  test("saved today: a quiet 'Last updated' with the time, and no 'offline'", () => {
    assert.equal(lastUpdated("2026-10-31T04:10:00Z", now), "Last updated 05:10");
    assert.doesNotMatch(lastUpdated("2026-10-31T04:10:00Z", now), /offline/i);
  });

  test("saved yesterday: says yesterday; older: the date", () => {
    assert.equal(lastUpdated("2026-10-30T17:10:00Z", now), "Last updated yesterday 18:10");
    assert.equal(lastUpdated("2026-10-28T04:10:00Z", now), "Last updated 28 Oct 05:10");
  });

  test("screen readers still hear that it is saved data and that the app is offline", () => {
    assert.equal(lastUpdatedSpoken("2026-10-31T04:10:00Z", now), "Saved data. You are offline. Last updated 05:10.");
  });

  test("the banner is a muted one-liner: no box, no icon; spoken text for readers", () => {
    const ui = readFileSync(new URL("../src/ui.jsx", import.meta.url), "utf8");
    const banner = ui.slice(ui.indexOf("export function SavedBanner"), ui.indexOf("// Fade and rise"));
    assert.match(banner, /text-sm text-muted/);
    assert.match(banner, /sr-only/);
    assert.doesNotMatch(banner, /border|bg-amber|rounded|Icon|CloudOff/);
  });

  test("a screen made of two loads shows the older time; none means no label", () => {
    assert.equal(oldestSaved({ savedAt: "2026-10-31T09:00:00Z" }, null, { savedAt: "2026-10-30T09:00:00Z" }), "2026-10-30T09:00:00Z");
    assert.equal(oldestSaved(null, undefined), null);
  });

  test("retry delays: 20 s, then backoff to a 160 s ceiling", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 9].map(retryDelayMs), [20000, 40000, 80000, 160000, 160000, 160000]);
  });
});

// --- network failure versus a server answer -------------------------------------

describe("network failure versus server error", () => {
  const net = () => new ApiError(0, "network");
  const store = (hit) => ({ saves: [], save: async function (...a) { this.saves.push(a); return true; }, load: async () => hit });
  const hit = { data: { n: 1 }, savedAt: "2026-10-31T04:10:00.000Z" };

  test("fresh data is shown without a label, and saved for next time", async () => {
    const st = store(hit);
    const out = await loadWithSaved(async () => ({ n: 9 }), { shopId: "shop-a", cacheKey: "money", store: st });
    assert.deepEqual([out.data, out.saved, out.error], [{ n: 9 }, null, null]);
    assert.deepEqual(st.saves, [["shop-a", "money", { n: 9 }]]);
  });

  test("a lost connection shows the saved data with its time, and no error", async () => {
    const out = await loadWithSaved(async () => { throw net(); }, { shopId: "shop-a", cacheKey: "money", store: store(hit) });
    assert.deepEqual(out.data, { n: 1 });
    assert.deepEqual(out.saved, { savedAt: hit.savedAt });
    assert.equal(out.error, null);
  });

  test("a timeout counts as a lost connection", async () => {
    const out = await loadWithSaved(async () => { throw new ApiError(0, "timeout"); }, { shopId: "shop-a", cacheKey: "money", store: store(hit) });
    assert.deepEqual(out.saved, { savedAt: hit.savedAt });
  });

  test("400, 401, 403, 404, 500 and 503 still show their normal error, never saved data", async () => {
    for (const status of [400, 401, 403, 404, 500, 503]) {
      const out = await loadWithSaved(async () => { throw new ApiError(status, "no"); }, { shopId: "shop-a", cacheKey: "money", store: store(hit) });
      assert.equal(out.data, null, String(status));
      assert.equal(out.saved, null, String(status));
      assert.ok(out.error, String(status));
    }
  });

  test("no saved data yet: the normal 'did not load' error, with the network flag for auto retry", async () => {
    const out = await loadWithSaved(async () => { throw net(); }, { shopId: "shop-a", cacheKey: "money", store: store(null) });
    assert.equal(out.data, null);
    assert.match(out.error, /Cannot reach PocketOga/);
    assert.equal(out.network, true);
  });

  test("a screen with no cache key behaves as before", async () => {
    const out = await loadWithSaved(async () => { throw net(); }, { shopId: "shop-a", store: store(hit) });
    assert.equal(out.data, null);
    assert.ok(out.error);
  });

  test("a failing store never breaks the screen", async () => {
    const broken = { save: async () => { throw new Error("full"); }, load: async () => { throw new Error("gone"); } };
    assert.deepEqual((await loadWithSaved(async () => ({ n: 3 }), { shopId: "a", cacheKey: "k", store: broken })).data, { n: 3 });
    assert.ok((await loadWithSaved(async () => { throw net(); }, { shopId: "a", cacheKey: "k", store: broken })).error);
  });
});

describe("GET time limit", () => {
  test("a read with no answer in 20 s is a lost connection, and the Offline pill knows", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    globalThis.fetch = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    const p = getDebts().catch((e) => e);
    mock.timers.tick(GET_TIMEOUT_MS);
    const err = await p;
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 0);
    assert.equal(connection.get().lastFailed, true);
  });
});
