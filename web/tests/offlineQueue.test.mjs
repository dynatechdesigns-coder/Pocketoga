// Web tests for the offline queue: order, retry with backoff, the same request
// id on every try, "Needs you", cancel, and no storage. Memory store, fake
// clock, fake send; fake data only.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { ApiError, proposeText, setShop } = await import("../src/api.js");
const Q = await import("../src/offlineQueue.js");
const { openQueueStore } = await import("../src/offlineStore.js");

function memoryStore(rows = []) {
  const map = new Map(rows.map((r) => [r.id, r]));
  return {
    getAll: async () => [...map.values()].map((r) => structuredClone(r)),
    put: async (item) => void map.set(item.id, structuredClone(item)),
    delete: async (id) => void map.delete(id),
    map,
  };
}

// A queue on a clock the test moves; `sent` records every attempt in order.
function setup({ outcomes = [], online = true } = {}) {
  let clock = 1_000_000;
  const state = { online };
  const sent = [];
  const results = [];
  const store = memoryStore();
  const queue = Q.createQueue({
    store,
    now: () => clock,
    isOnline: () => state.online,
    send: async (item) => {
      sent.push({ text: item.payload.text, requestId: item.requestId, spokenAt: item.spokenAt });
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return { id: `p-${sent.length}` };
    },
    onResult: (item, proposal) => results.push([item.payload.text, proposal.id]),
  });
  return { queue, store, sent, results, state, tick: (ms) => (clock += ms) };
}

const network = () => new ApiError(0, "network");

describe("order", () => {
  test("sends oldest first, one at a time", async () => {
    const t = setup({ online: false });
    await t.queue.enqueue("text", { text: "first" });
    await t.queue.enqueue("text", { text: "second" });
    await t.queue.enqueue("text", { text: "third" });
    await t.queue.flush();
    assert.deepEqual(t.sent, []); // offline: nothing goes
    t.state.online = true;
    await t.queue.flush();
    assert.deepEqual(t.sent.map((s) => s.text), ["first", "second", "third"]);
    assert.deepEqual(t.results.map((r) => r[0]), ["first", "second", "third"]);
    assert.equal(t.queue.list().length, 0);
    assert.equal(t.store.map.size, 0);
  });

  test("items survive a restart: a new queue reads the stored ones in order", async () => {
    const t = setup({ online: false });
    await t.queue.enqueue("text", { text: "a" });
    await t.queue.enqueue("audio", { base64: "QUJD" });
    const again = Q.createQueue({ store: memoryStore([...t.store.map.values()]), send: async () => ({ id: 1 }), isOnline: () => false });
    const items = await again.load();
    assert.deepEqual(items.map((i) => i.kind), ["text", "audio"]);
  });
});

describe("retry and request id", () => {
  test("a network failure keeps the item, backs off, and retries with the same request id and spoken time", async () => {
    const t = setup({ outcomes: [network(), network()] });
    const item = await t.queue.enqueue("text", { text: "ada" });
    await t.queue.flush();
    assert.equal(t.queue.list()[0].tries, 1);
    assert.equal(t.queue.list()[0].status, "waiting");
    await t.queue.flush(); // too soon: still backing off
    assert.equal(t.sent.length, 1);
    t.tick(Q.backoffMs(1));
    await t.queue.flush();
    t.tick(Q.backoffMs(2));
    await t.queue.flush();
    assert.equal(t.sent.length, 3);
    assert.equal(new Set(t.sent.map((s) => s.requestId)).size, 1);
    assert.equal(t.sent[0].requestId, item.requestId);
    assert.equal(new Set(t.sent.map((s) => s.spokenAt)).size, 1);
    assert.deepEqual(t.results, [["ada", "p-3"]]);
  });

  test("backoff grows: 5 s, 15 s, 45 s, 135 s", () => {
    assert.deepEqual([1, 2, 3, 4].map(Q.backoffMs), [5000, 15000, 45000, 135000]);
  });

  test("after 5 failed tries the item says Needs you and is not sent again", async () => {
    const t = setup({ outcomes: Array.from({ length: 10 }, network) });
    await t.queue.enqueue("text", { text: "stuck" });
    for (let i = 0; i < 8; i++) {
      await t.queue.flush();
      t.tick(Q.backoffMs(5));
    }
    assert.equal(t.sent.length, Q.MAX_TRIES);
    const [item] = t.queue.list();
    assert.equal(item.status, "needs-you");
    assert.match(item.error, /5 tries/);
    assert.equal(t.results.length, 0);
  });

  test("a live send that already failed counts as try one and waits", async () => {
    const t = setup();
    await t.queue.enqueue("text", { text: "x" }, { failed: true, requestId: "req-1" });
    await t.queue.flush();
    assert.equal(t.sent.length, 0);
    t.tick(Q.backoffMs(1));
    await t.queue.flush();
    assert.equal(t.sent[0].requestId, "req-1");
  });

  test("Try again on a Needs you item restarts it with the same request id", async () => {
    const t = setup({ outcomes: [new ApiError(400, "amount is required")] });
    const item = await t.queue.enqueue("text", { text: "bad" });
    await t.queue.flush();
    assert.equal(t.queue.list()[0].status, "needs-you");
    await t.queue.retry(item.id);
    await t.queue.flush();
    assert.equal(t.sent.length, 2);
    assert.equal(t.sent[1].requestId, item.requestId);
    assert.equal(t.queue.list().length, 0);
  });

  test("the retry timer wakes the queue by itself", async () => {
    const { mock } = await import("node:test");
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const t = setup({ outcomes: [network()] });
      await t.queue.enqueue("text", { text: "later" });
      await t.queue.flush();
      assert.equal(t.sent.length, 1);
      t.tick(Q.backoffMs(1));
      mock.timers.tick(Q.backoffMs(1));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(t.sent.length, 2);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("server errors are shown", () => {
  test("a 400 stops the item at once as Needs you, with the server's message", async () => {
    const t = setup({ outcomes: [new ApiError(400, "text or audio is required")] });
    await t.queue.enqueue("text", { text: "" });
    await t.queue.enqueue("text", { text: "next" });
    await t.queue.flush();
    const [bad, next] = t.queue.list();
    assert.equal(bad.status, "needs-you");
    assert.equal(bad.tries, 1);
    assert.match(bad.error, /Text or audio is required/);
    assert.equal(next, undefined); // the second one went through after it
    assert.deepEqual(t.sent.map((s) => s.text), ["", "next"]);
  });

  test("a 503 is tried again later and its message is kept", async () => {
    const t = setup({ outcomes: [new ApiError(503, "down")] });
    await t.queue.enqueue("text", { text: "x" });
    await t.queue.flush();
    const [item] = t.queue.list();
    assert.equal(item.status, "waiting");
    assert.match(item.error, /not answering/);
  });
});

describe("cancel", () => {
  test("Cancel removes the item from the list and the store, and it is never sent", async () => {
    const t = setup({ online: false });
    const a = await t.queue.enqueue("text", { text: "a" });
    await t.queue.enqueue("text", { text: "b" });
    await t.queue.cancel(a.id);
    assert.deepEqual(t.queue.list().map((i) => i.payload.text), ["b"]);
    assert.equal(t.store.map.size, 1);
    t.state.online = true;
    await t.queue.flush();
    assert.deepEqual(t.sent.map((s) => s.text), ["b"]);
  });

  test("Cancel while it is being sent aborts it and ignores the answer", async () => {
    let release;
    const store = memoryStore();
    const results = [];
    const queue = Q.createQueue({
      store,
      send: (item, signal) =>
        new Promise((resolve, reject) => {
          release = () => resolve({ id: "late" });
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      onResult: (i, p) => results.push(p.id),
    });
    const item = await queue.enqueue("text", { text: "mid" });
    const flushing = queue.flush();
    await new Promise((r) => setImmediate(r));
    await queue.cancel(item.id);
    release?.();
    await flushing;
    assert.deepEqual(results, []);
    assert.equal(queue.list().length, 0);
    assert.equal(store.map.size, 0);
  });
});

describe("nothing is saved to the ledger", () => {
  test("a queued note only asks for a proposal: the one route called is /propose", async () => {
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ path: String(url).replace(/^\/api/, ""), headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 201, json: async () => ({ proposal: { id: 4 } }) };
    };
    try {
      setShop("demo");
      const { sendItem } = await import("../src/shopQueue.js").catch(() => ({}));
      const meta = { requestId: "req-9", spokenAt: "2026-10-31T08:00:00.000Z" };
      await proposeText("Ada buy rice", undefined, undefined, meta);
      assert.deepEqual(calls.map((c) => c.path), ["/propose"]);
      assert.equal(calls[0].headers["x-request-id"], "req-9");
      assert.equal(calls[0].body.spokenAt, "2026-10-31T08:00:00.000Z");
      assert.ok(!calls.some((c) => c.path.startsWith("/confirm")));
      void sendItem;
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("without meta no header or field is added", async () => {
    const realFetch = globalThis.fetch;
    let seen;
    globalThis.fetch = async (url, init = {}) => {
      seen = init;
      return { ok: true, status: 201, json: async () => ({ proposal: { id: 4 } }) };
    };
    try {
      setShop("demo");
      await proposeText("hello");
      assert.equal(seen.headers["x-request-id"], undefined);
      assert.equal(JSON.parse(seen.body).spokenAt, undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("no IndexedDB", () => {
  test("the store is null, so the screen can say You are offline", async () => {
    assert.equal(await openQueueStore("demo", undefined), null);
    assert.equal(
      await openQueueStore("demo", {
        open: () => {
          const req = {};
          setTimeout(() => req.onerror?.(), 0);
          return req;
        },
      }),
      null
    );
    assert.equal(Q.OFFLINE_MESSAGE, "You are offline. Try again when you are back online.");
    assert.equal(Q.SAVED_MESSAGE, "Saved. It will send when you are back online.");
  });
});
