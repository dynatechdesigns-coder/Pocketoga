// Web tests for the Record screen's waiting states: stage order, the 40 s
// limit, the plain error messages, correcting the heard text, and that
// nothing is saved before Save. Fake fetch, short timers; fake data only.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

const { ApiError, proposeAudio, proposeText, setShop } = await import("../src/api.js");
const { MESSAGES, STAGES, STAGE_DELAYS_MS, TIMEOUT_MS, WaitError, canRetry, isEmptyRecording, waitForProposal } = await import("../src/recordWait.js");

const realFetch = globalThis.fetch;
let calls;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proposal = (extra = {}) => ({ id: 7, status: "pending", heard: "Ada buy 2 bags of rice, 45k", entries: [], source: "voice", ...extra });

beforeEach(() => {
  calls = [];
  setShop("demo");
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeServer(handler = () => ({ status: 201, data: { proposal: proposal() } })) {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    const { status, data } = await handler(path, body, init);
    return { ok: status < 400, status, json: async () => data };
  };
}

describe("stages", () => {
  test("the order is Listening, Reading, Checking, and there are no percentages", () => {
    assert.deepEqual(STAGES, ["Listening…", "Reading your note…", "Checking the numbers…"]);
    assert.ok(STAGES.every((s) => !/%|\d/.test(s)));
    assert.equal(TIMEOUT_MS, 40_000);
    assert.equal(STAGE_DELAYS_MS.length, 2);
  });

  test("a voice note shows Listening at once, then each stage in order while it waits", async () => {
    const seen = [];
    const p = await waitForProposal(async () => (await sleep(80), proposal()), { onStage: (s) => seen.push(s), delays: [20, 45], timeoutMs: 1000 });
    assert.deepEqual(seen, STAGES);
    assert.equal(p.id, 7);
  });

  test("a quick answer skips the later stages", async () => {
    const seen = [];
    await waitForProposal(async () => proposal(), { onStage: (s) => seen.push(s), delays: [30, 60], timeoutMs: 1000 });
    assert.deepEqual(seen, [STAGES[0]]);
  });

  test("a typed note starts at Reading, never Listening", async () => {
    const seen = [];
    await waitForProposal(async () => (await sleep(50), proposal()), { onStage: (s) => seen.push(s), startAt: 1, delays: [10, 25], timeoutMs: 1000 });
    assert.deepEqual(seen, [STAGES[1], STAGES[2]]);
  });
});

describe("errors", () => {
  test("after the limit it stops with a plain message, aborts, and ignores a late answer", async () => {
    let signal;
    const err = await waitForProposal(
      (s) => {
        signal = s;
        return new Promise((resolve, reject) => {
          s.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          setTimeout(() => resolve(proposal()), 200); // too late
        });
      },
      { timeoutMs: 30, delays: [] },
    ).catch((e) => e);
    assert.ok(err instanceof WaitError);
    assert.equal(err.kind, "timeout");
    assert.equal(err.message, MESSAGES.timeout);
    assert.equal(signal.aborted, true);
    assert.equal(canRetry(err), true);
  });

  test("the timeout really cancels the request through the api", async () => {
    globalThis.fetch = (url, init) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const err = await waitForProposal((s) => proposeText("Ada buy rice", undefined, s), { timeoutMs: 30, delays: [] }).catch((e) => e);
    assert.equal(err.kind, "timeout");
  });

  test("no connection gives the network message and a retry", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("failed to fetch");
    };
    const err = await waitForProposal((s) => proposeText("Ada buy rice", undefined, s), { timeoutMs: 1000, delays: [] }).catch((e) => e);
    assert.equal(err.kind, "network");
    assert.equal(err.message, MESSAGES.network);
    assert.equal(canRetry(err), true);
  });

  test("a server error shows its plain sentence and no retry button", async () => {
    fakeServer(() => ({ status: 413, data: { error: "too big" } }));
    const err = await waitForProposal((s) => proposeAudio("QUJD", "wav", undefined, s), { timeoutMs: 1000, delays: [] }).catch((e) => e);
    assert.equal(err.message, "That recording is too long. Keep it under 2 minutes.");
    assert.equal(canRetry(err), false);
  });

  test("an empty recording is caught before anything is uploaded", () => {
    assert.equal(isEmptyRecording(new Blob([])), true);
    assert.equal(isEmptyRecording(null), true);
    assert.equal(isEmptyRecording(new Blob(["abc"])), false);
    assert.match(MESSAGES.empty, /did not catch anything/);
    assert.equal(calls.length, 0);
  });

  test("a blocked microphone has its own plain message", () => {
    assert.match(MESSAGES.mic, /needs your microphone/);
    assert.ok(!new WaitError("mic").message.includes("undefined"));
    assert.equal(canRetry(new WaitError("mic")), false);
  });

  test("a retry after a failure goes through and the proposal arrives", async () => {
    let n = 0;
    const call = (s) => proposeText("Ada buy rice", undefined, s);
    fakeServer(() => (++n === 1 ? { status: 503, data: { error: "x" } } : { status: 201, data: { proposal: proposal() } }));
    await assert.rejects(waitForProposal(call, { delays: [] }));
    assert.equal((await waitForProposal(call, { delays: [] })).id, 7);
  });
});

describe("correcting the heard text", () => {
  test("re-running sends the corrected text only, with no audio", async () => {
    fakeServer((path, body) => ({ status: 201, data: { proposal: body.text ? proposal({ heard: body.text, source: "text" }) : proposal() } }));
    const first = await proposeAudio("QUJD", "wav", "sale");
    assert.equal(first.source, "voice");
    const second = await waitForProposal((s) => proposeText("Ada buy 3 bags of rice, 45k", "sale", s), { startAt: 1, delays: [] });
    assert.equal(second.heard, "Ada buy 3 bags of rice, 45k");
    const rerun = calls[1];
    assert.equal(rerun.path, "/propose");
    assert.equal(rerun.body.text, "Ada buy 3 bags of rice, 45k");
    assert.ok(!("audioBase64" in rerun.body));
  });
});

describe("nothing is saved before Save", () => {
  test("waiting, a timeout, a retry and a re-run never call confirm", async () => {
    fakeServer();
    await waitForProposal((s) => proposeAudio("QUJD", "wav", undefined, s), { delays: [] });
    await waitForProposal((s) => proposeText("fixed text", undefined, s), { startAt: 1, delays: [] });
    globalThis.fetch = (url, init) => (calls.push({ path: String(url).replace(/^\/api/, "") }), new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("x")))));
    await waitForProposal((s) => proposeText("slow", undefined, s), { timeoutMs: 20, delays: [] }).catch(() => {});
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.path === "/propose"));
  });
});
