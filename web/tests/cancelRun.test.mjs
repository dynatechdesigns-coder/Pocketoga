// Web tests for cancel-and-start-afresh logic and the Home "Check" label.
// Fake timers and a fake fetch; nothing is ever saved by a cancel.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

const { CANCELLED_MESSAGE, CANCELLED_MS, checkLabel, createRunTracker, micAction } = await import("../src/cancelRun.js");
const { proposeText, setShop } = await import("../src/api.js");
const { toWaitError, waitForProposal } = await import("../src/recordWait.js");

const realFetch = globalThis.fetch;
let calls;
beforeEach(() => {
  calls = [];
  setShop("demo");
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

// A server that answers only when the test says so, and notes every path hit.
function slowServer() {
  let answer;
  globalThis.fetch = (url, init = {}) =>
    new Promise((resolve, reject) => {
      calls.push({ path: String(url).replace(/^\/api/, ""), aborted: () => init.signal?.aborted });
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      answer = () => resolve({ ok: true, status: 201, json: async () => ({ proposal: { id: 1, entries: [] } }) });
    });
  return { answer: () => answer() };
}

// What RecordScreen does around one request.
async function runLikeScreen(tracker, log) {
  const run = tracker.begin();
  try {
    const p = await waitForProposal((signal) => proposeText("Ada buy rice", undefined, signal), { outer: run.signal });
    if (!run.isCurrent()) return log.push("ignored late answer");
    log.push("shown");
  } catch (err) {
    if (!run.isCurrent()) return log.push("cancelled quietly");
    log.push(`error:${toWaitError(err).kind}`);
  } finally {
    tracker.end(run);
  }
}

describe("cancel while processing", () => {
  test("aborts the in-flight request, shows nothing, shows no error, saves nothing", async () => {
    const server = slowServer();
    const tracker = createRunTracker();
    const log = [];
    const done = runLikeScreen(tracker, log);
    await new Promise((r) => setImmediate(r));
    assert.equal(tracker.busy, true);
    assert.equal(tracker.cancel(), true);
    await done;
    assert.deepEqual(log, ["cancelled quietly"]);
    assert.equal(calls[0].aborted(), true);
    assert.deepEqual(calls.map((c) => c.path), ["/propose"]); // no /confirm, ever
    assert.equal(tracker.busy, false);
    server.answer?.();
  });

  test("a late answer after Cancel is ignored", async () => {
    // A server that ignores the abort and answers anyway.
    globalThis.fetch = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 201, json: async () => ({ proposal: { id: 1, entries: [] } }) };
    };
    const tracker = createRunTracker();
    const log = [];
    const done = runLikeScreen(tracker, log);
    tracker.cancel();
    await done;
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(log, ["ignored late answer"]);
  });

  test("cancelling with nothing in flight does nothing", () => {
    assert.equal(createRunTracker().cancel(), false);
  });

  test("a new run replaces and cancels the old one (record again)", async () => {
    const tracker = createRunTracker();
    const first = tracker.begin();
    const second = tracker.begin();
    assert.equal(first.signal.aborted, true);
    assert.equal(first.isCurrent(), false);
    assert.equal(second.isCurrent(), true);
  });

  test("a finished run lets go; Cancel afterwards does nothing", () => {
    const tracker = createRunTracker();
    const run = tracker.begin();
    tracker.end(run);
    assert.equal(tracker.busy, false);
    assert.equal(tracker.cancel(), false);
    assert.equal(run.signal.aborted, false);
  });

  test("the mic tap while processing cancels and starts recording in one tap", () => {
    const base = { busy: true, recording: false, sheetOpen: false, canRecord: true };
    assert.deepEqual(micAction(base), ["cancel", "start"]);
    assert.deepEqual(micAction({ ...base, canRecord: false }), ["cancel"]);
    // the same steps against a real tracker: the request is aborted, then idle
    const tracker = createRunTracker();
    const run = tracker.begin();
    for (const step of micAction(base)) if (step === "cancel") tracker.cancel();
    assert.equal(run.signal.aborted, true);
    assert.equal(tracker.busy, false);
  });

  test("the mic tap otherwise starts, stops, or waits for the sheet", () => {
    const idle = { busy: false, recording: false, sheetOpen: false, canRecord: true };
    assert.deepEqual(micAction(idle), ["start"]);
    assert.deepEqual(micAction({ ...idle, recording: true }), ["stop"]);
    assert.deepEqual(micAction({ ...idle, sheetOpen: true }), []);
    assert.deepEqual(micAction({ ...idle, canRecord: false }), []);
  });

  test("the timeout still reports a timeout when nobody cancelled", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    slowServer();
    const tracker = createRunTracker();
    const log = [];
    const done = runLikeScreen(tracker, log);
    await Promise.resolve();
    mock.timers.tick(40_000);
    await done;
    assert.deepEqual(log, ["error:timeout"]);
  });
});

describe("the Cancelled note", () => {
  test("is the word Cancelled and lasts about 2 seconds", () => {
    assert.equal(CANCELLED_MESSAGE, "Cancelled");
    assert.equal(CANCELLED_MS, 2000);
    mock.timers.enable({ apis: ["setTimeout"] });
    let shown = true;
    setTimeout(() => (shown = false), CANCELLED_MS);
    mock.timers.tick(1999);
    assert.equal(shown, true);
    mock.timers.tick(1);
    assert.equal(shown, false);
  });
});

describe("Home Check action label", () => {
  test("spoken label carries the count; no count, no extra words", () => {
    assert.equal(checkLabel(2), "Check, 2 need attention");
    assert.equal(checkLabel(1), "Check, 1 needs attention");
    assert.equal(checkLabel(0), "Check");
  });
});
