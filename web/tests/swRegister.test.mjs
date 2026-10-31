// Web tests for service worker registration: the options, the update checks
// (after registering and on return to the foreground, at most every 10
// minutes) and the take-over-on-next-open behaviour. Fake browser objects.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { registerServiceWorker, SW_OPTIONS, UPDATE_CHECK_MS } = await import("../src/swRegister.js");

function setup({ waiting = null, controller = {}, updateFails = false, registerFails = false } = {}) {
  const log = { register: [], updates: 0, posted: [], reloads: 0 };
  const handlers = { sw: {}, win: {}, doc: {} };
  const clock = { t: 1_000_000 };
  const reg = {
    waiting,
    update: async () => {
      log.updates++;
      if (updateFails) throw new Error("offline");
    },
  };
  if (waiting) waiting.postMessage = (m) => log.posted.push(m);
  const doc = { visibilityState: "visible", addEventListener: (n, f) => (handlers.doc[n] = f) };
  registerServiceWorker({
    serviceWorker: {
      controller,
      addEventListener: (n, f) => (handlers.sw[n] = f),
      register: async (...args) => {
        log.register.push(args);
        if (registerFails) throw new Error("no sw");
        return reg;
      },
    },
    document: doc,
    window: { addEventListener: (n, f) => (handlers.win[n] = f) },
    location: { reload: () => log.reloads++ },
    now: () => clock.t,
  });
  const load = () => handlers.win.load();
  const show = () => handlers.doc.visibilitychange();
  return { log, handlers, clock, doc, load, show };
}

describe("registration", () => {
  test("registers /sw.js with updateViaCache none", async () => {
    const t = setup();
    await t.load();
    assert.deepEqual(t.log.register, [["/sw.js", { updateViaCache: "none" }]]);
    assert.deepEqual(SW_OPTIONS, { updateViaCache: "none" });
  });

  test("does nothing without service worker support", () => {
    assert.doesNotThrow(() => registerServiceWorker({ serviceWorker: undefined }));
  });

  test("a failed registration is swallowed", async () => {
    const t = setup({ registerFails: true });
    await t.load();
    assert.equal(t.log.updates, 0);
  });
});

describe("update checks", () => {
  test("one right after registering", async () => {
    const t = setup();
    await t.load();
    assert.equal(t.log.updates, 1);
  });

  test("coming back to the foreground checks again, but not within 10 minutes", async () => {
    const t = setup();
    await t.load();
    t.clock.t += UPDATE_CHECK_MS - 1;
    await t.show();
    assert.equal(t.log.updates, 1);
    t.clock.t += 1;
    await t.show();
    assert.equal(t.log.updates, 2);
    await t.show(); // again straight away: too soon
    assert.equal(t.log.updates, 2);
  });

  test("going to the background does not check", async () => {
    const t = setup();
    await t.load();
    t.clock.t += UPDATE_CHECK_MS;
    t.doc.visibilityState = "hidden";
    await t.show();
    assert.equal(t.log.updates, 1);
  });

  test("a failing update is caught and still counts toward the 10 minutes", async () => {
    const t = setup({ updateFails: true });
    await t.load();
    await t.show();
    assert.equal(t.log.updates, 1);
    t.clock.t += UPDATE_CHECK_MS;
    await assert.doesNotReject(async () => t.show());
    assert.equal(t.log.updates, 2);
  });
});

describe("taking over on the next open", () => {
  test("a waiting worker on a controlled page is told to skip waiting, and the page reloads once it takes over", async () => {
    const t = setup({ waiting: {} });
    await t.load();
    assert.deepEqual(t.log.posted, ["SKIP_WAITING"]);
    t.handlers.sw.controllerchange();
    assert.equal(t.log.reloads, 1);
  });

  test("a first install (no controller) neither skips waiting nor reloads", async () => {
    const t = setup({ waiting: {}, controller: null });
    await t.load();
    assert.deepEqual(t.log.posted, []);
    t.handlers.sw.controllerchange();
    assert.equal(t.log.reloads, 0);
  });
});
