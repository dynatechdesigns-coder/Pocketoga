// Web tests for the quiet background refresh of saved copies: the schedule
// (waits for the screen, one request at a time, in order), the 10-minute limit,
// stopping on failure or going offline, nothing without a login or for another
// shop, and no phone numbers in what is saved. Fake timers, fake store, fake data.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const P = await import("../src/prefetch.js");
const { PREFETCH_TASKS, DEBTS_SAVED } = await import("../src/savedLoaders.js");
const { withoutPhones } = await import("../src/savedData.js");

const SHOP = { id: "wa-abc", token: "t" };

function setup({ shop = SHOP, online = true, active = SHOP.id, idleAnswers = null, tasks } = {}) {
  const s = { shop, online, active, saved: [], loads: [], concurrent: 0, maxConcurrent: 0, clock: 1_000_000, idleCalls: 0, pending: [] };
  const mk = (key, extra = {}) => ({
    key,
    ...extra,
    load: async () => {
      s.concurrent++;
      s.maxConcurrent = Math.max(s.maxConcurrent, s.concurrent);
      s.loads.push(key);
      await Promise.resolve();
      s.concurrent--;
      if (s.failOn === key) throw new Error("network");
      if (s.onLoad) s.onLoad(key);
      return { key, customers: [{ name: "Ada", phone: "08000000000" }] };
    },
  });
  const list = tasks ?? [mk("money"), mk("debts", { prepare: withoutPhones }), mk("report"), mk("profit:today")];
  const timers = new Set();
  s.timers = timers;
  s.prefetch = P.createPrefetch({
    getShop: () => s.shop,
    isOnline: () => s.online,
    isIdle: () => (idleAnswers ? (s.idleCalls++, idleAnswers.length ? idleAnswers.shift() : true) : true),
    activeShopId: () => s.active,
    tasks: list,
    store: { save: async (shopId, key, data) => void s.saved.push({ shopId, key, data }) },
    now: () => s.clock,
    // timers fire when the test says so (s.fire), never by themselves
    setTimer: (fn) => {
      const t = { fn };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => timers.delete(t),
  });
  // Runs every due timer until the refresh has finished.
  s.run = async () => {
    const done = s.prefetch.trigger();
    let over = false;
    done.then(() => (over = true));
    for (let i = 0; i < 200 && !over; i++) {
      await new Promise((r) => setImmediate(r));
      for (const t of [...timers]) {
        timers.delete(t);
        t.fn();
      }
    }
    await done;
  };
  return s;
}

describe("the schedule", () => {
  test("loads Money, Debts and Reports copies in order, one request at a time, saved under this shop", async () => {
    const s = setup();
    await s.run();
    assert.deepEqual(s.loads, ["money", "debts", "report", "profit:today"]);
    assert.deepEqual(s.saved.map((x) => x.key), ["money", "debts", "report", "profit:today"]);
    assert.ok(s.saved.every((x) => x.shopId === SHOP.id));
    assert.equal(s.maxConcurrent, 1);
  });

  test("waits a few seconds first so the screen on show loads first", async () => {
    const s = setup();
    const done = s.prefetch.trigger();
    await new Promise((r) => setImmediate(r));
    assert.equal(s.loads.length, 0); // the start delay timer has not fired
    assert.equal(s.timers.size, 1);
    s.prefetch.stop();
    await done;
  });

  test("does not start a request while something else is loading, and goes on when it is idle", async () => {
    const s = setup({ idleAnswers: [false, false, true] });
    await s.run();
    assert.ok(s.idleCalls >= 3);
    assert.equal(s.loads.length, 4);
  });

  test("gives up if the app stays busy for 30 seconds", async () => {
    const s = setup({ idleAnswers: Array(1000).fill(false) });
    s.onLoad = () => {};
    const done = s.prefetch.trigger();
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setImmediate(r));
      s.clock += P.PREFETCH_IDLE_POLL_MS * 5;
      for (const t of [...s.timers]) {
        s.timers.delete(t);
        t.fn();
      }
    }
    await done;
    assert.equal(s.loads.length, 0);
  });

  test("the saved copy of Debts has no phone numbers", async () => {
    const real = PREFETCH_TASKS.find((t) => t.key === "debts");
    assert.equal(real.prepare, DEBTS_SAVED.prepare);
    const s = setup();
    await s.run();
    const debts = s.saved.find((x) => x.key === "debts").data;
    assert.deepEqual(debts.customers, [{ name: "Ada", phone: null }]);
  });

  test("the real task list covers Money, Debts and Reports only", () => {
    assert.deepEqual(PREFETCH_TASKS.map((t) => t.key), ["money", "debts", "report", "profit:today"]);
  });
});

describe("the 10-minute limit", () => {
  test("a second trigger inside 10 minutes does nothing; after 10 minutes it runs again", async () => {
    const s = setup();
    await s.run();
    assert.equal(s.loads.length, 4);
    s.clock += P.PREFETCH_EVERY_MS - 1;
    await s.run();
    assert.equal(s.loads.length, 4);
    s.clock += 1;
    await s.run();
    assert.equal(s.loads.length, 8);
  });

  test("a trigger while a refresh is already running does not start a second one", async () => {
    const s = setup();
    const first = s.run();
    await s.prefetch.trigger();
    await first;
    assert.equal(s.loads.length, 4);
  });

  test("the limit is per shop", async () => {
    const s = setup();
    await s.run();
    s.shop = { id: "wa-other", token: "t" };
    s.active = "wa-other";
    await s.run();
    assert.equal(s.loads.length, 8);
    assert.deepEqual([...new Set(s.saved.map((x) => x.shopId))], [SHOP.id, "wa-other"]);
  });
});

describe("stopping", () => {
  test("the first failed request stops everything, saves nothing more, and waits its 10 minutes", async () => {
    const s = setup();
    s.failOn = "debts";
    await s.run();
    assert.deepEqual(s.loads, ["money", "debts"]);
    assert.deepEqual(s.saved.map((x) => x.key), ["money"]);
    s.failOn = null;
    s.clock += 60_000;
    await s.run();
    assert.equal(s.loads.length, 2);
  });

  test("going offline mid-run stops it and the answer in hand is not saved", async () => {
    const s = setup();
    s.onLoad = (key) => {
      if (key === "debts") s.online = false;
    };
    await s.run();
    assert.deepEqual(s.loads, ["money", "debts"]);
    assert.deepEqual(s.saved.map((x) => x.key), ["money"]);
  });

  test("signing out mid-run stops it and saves nothing for the shop that left", async () => {
    const s = setup();
    s.onLoad = (key) => {
      if (key === "money") s.shop = null;
    };
    await s.run();
    assert.deepEqual(s.saved, []);
    assert.deepEqual(s.loads, ["money"]);
  });

  test("another shop opened mid-run: nothing is saved for either", async () => {
    const s = setup();
    s.onLoad = (key) => {
      if (key === "money") s.active = "wa-other";
    };
    await s.run();
    assert.deepEqual(s.saved, []);
  });

  test("stop() ends a waiting refresh at once", async () => {
    const s = setup();
    const done = s.prefetch.trigger();
    s.prefetch.stop();
    await done;
    assert.equal(s.loads.length, 0);
    await s.prefetch.trigger();
    assert.equal(s.loads.length, 0); // a stopped prefetch stays stopped
  });
});

describe("when it must not run", () => {
  test("offline: nothing loads, and it does not use up the 10 minutes", async () => {
    const s = setup({ online: false });
    await s.run();
    assert.equal(s.loads.length, 0);
    s.online = true;
    await s.run();
    assert.equal(s.loads.length, 4);
  });

  test("going offline during the start delay: nothing loads", async () => {
    const s = setup();
    const done = s.prefetch.trigger();
    s.online = false;
    for (const t of [...s.timers]) {
      s.timers.delete(t);
      t.fn();
    }
    await done;
    assert.equal(s.loads.length, 0);
  });

  test("no signed-in shop (signed out, expired or demo): nothing loads", async () => {
    const s = setup({ shop: null });
    await s.run();
    assert.equal(s.loads.length, 0);
    assert.equal(s.saved.length, 0);
  });

  test("the API is set to a different shop than the signed-in one: nothing loads", async () => {
    const s = setup({ active: "wa-other" });
    await s.run();
    assert.equal(s.loads.length, 0);
  });
});

describe("quiet and wired in", () => {
  test("the prefetch module shows nothing: no UI, no events, no error text", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/prefetch.js", import.meta.url), "utf8");
    assert.doesNotMatch(src, /dispatchEvent|document\.|window\.|friendlyError|setState/);
  });

  test("the app starts it on open and on return to the foreground, only for a signed-in non-demo shop, and stops it on exit", async () => {
    const { readFileSync } = await import("node:fs");
    const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    assert.match(app, /createPrefetch\(/);
    assert.match(app, /visibilitychange/);
    assert.match(app, /!s\.demo && hasSession\(s\)/);
    assert.match(app, /prefetch\.stop\(\)/);
  });

  test("the screens and the refresh share one loader", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
    assert.match(read("screens/MoneyScreen.jsx"), /loadMoney[^]*savedLoaders/);
    assert.match(read("screens/DebtsScreen.jsx"), /loadDebts[^]*savedLoaders/);
  });

  test("the API layer counts running requests", async () => {
    const { requestsRunning, setShop } = await import("../src/api.js");
    const real = globalThis.fetch;
    setShop("demo");
    let release;
    globalThis.fetch = () => new Promise((r) => (release = () => r({ ok: true, status: 200, json: async () => ({ proposal: {} }) })));
    try {
      const { getProposal } = await import("../src/api.js");
      assert.equal(requestsRunning(), 0);
      const p = getProposal(1);
      await new Promise((r) => setImmediate(r));
      assert.equal(requestsRunning(), 1);
      release();
      await p;
      assert.equal(requestsRunning(), 0);
    } finally {
      globalThis.fetch = real;
    }
  });
});
