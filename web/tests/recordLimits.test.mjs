// Web tests for the Record limits, with fake timers: the 45 s auto-stop, the
// 30 s slow-wait line and the 60 s voice failure (text keeps 40 s).
import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";

const L = await import("../src/recordLimits.js");
const W = await import("../src/recordWait.js");

afterEach(() => mock.timers.reset());

describe("recording limit", () => {
  test("hint and message wording", () => {
    assert.equal(L.VOICE_HINT, "Short notes work best (under 30 seconds)");
    assert.equal(L.TIME_UP_MESSAGE, "Time's up. Send it or record again.");
    assert.equal(L.MAX_RECORD_SECONDS, 45);
  });

  test("stops by itself at 45 s, once, and not before", () => {
    mock.timers.enable({ apis: ["setInterval", "Date"] });
    let limit = 0;
    let last = 0;
    const stop = L.createRecordTimer({ onTick: (s) => (last = s), onLimit: () => limit++ });
    mock.timers.tick(44_000);
    assert.equal(limit, 0);
    mock.timers.tick(1_000);
    assert.equal(last, 45);
    assert.equal(limit, 1);
    mock.timers.tick(10_000);
    assert.equal(limit, 1);
    stop();
  });
});

describe("voice waiting limits", () => {
  const hang = (signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("abort"))));
  const voice = { stages: W.VOICE_STAGES, delays: W.VOICE_STAGE_DELAYS_MS, timeoutMs: W.VOICE_TIMEOUT_MS };

  test("constants: 30 s slow line and 60 s failure for voice, 40 s unchanged for text", () => {
    assert.equal(W.VOICE_STAGE_DELAYS_MS[2], 30_000);
    assert.match(W.VOICE_STAGES[3], /longer than usual/);
    assert.equal(W.VOICE_TIMEOUT_MS, 60_000);
    assert.equal(W.TIMEOUT_MS, 40_000);
    assert.equal(W.STAGES.length, 3);
  });

  test("voice: slow line at 30 s, still waiting at 40 s, fails at 60 s", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const seen = [];
    let settled = null;
    const p = W.waitForProposal(hang, { onStage: (s) => seen.push(s), ...voice }).catch((e) => (settled = e));
    mock.timers.tick(29_999);
    assert.ok(!seen.includes(W.VOICE_STAGES[3]));
    mock.timers.tick(1);
    assert.equal(seen.at(-1), W.VOICE_STAGES[3]);
    mock.timers.tick(30_000); // 60 s total minus one ms to go
    mock.timers.tick(0);
    await Promise.resolve();
    assert.equal(settled, null);
    mock.timers.tick(1_000);
    await p;
    assert.equal(settled.kind, "timeout");
  });

  test("text: no slow line, still fails at 40 s", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const seen = [];
    let settled = null;
    const p = W.waitForProposal(hang, { onStage: (s) => seen.push(s), startAt: 1 }).catch((e) => (settled = e));
    mock.timers.tick(39_999);
    await Promise.resolve();
    assert.equal(settled, null);
    mock.timers.tick(1);
    await p;
    assert.equal(settled.kind, "timeout");
    assert.ok(!seen.some((s) => /longer than usual/.test(s)));
  });
});
