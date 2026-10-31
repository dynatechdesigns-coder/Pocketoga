// Web tests for the Offline pill's state logic: what makes it show, what puts
// it right again, the "N waiting" text, and what the api reports.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

const C = await import("../src/connection.js");
const { connection, createConnection, isOffline, pillText } = C;
const { proposeText, setShop } = await import("../src/api.js");
const { waitForProposal } = await import("../src/recordWait.js");

const realFetch = globalThis.fetch;
beforeEach(() => {
  setShop("demo");
  connection.setDeviceOnline(true);
  connection.reportReached();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});

describe("state", () => {
  test("online and last request fine: no pill", () => {
    const c = createConnection({ isOnline: () => true });
    assert.equal(isOffline(c.get()), false);
    assert.equal(pillText(c.get()), null);
  });

  test("device offline shows the pill, and the online event clears it", () => {
    const c = createConnection({ isOnline: () => false });
    assert.equal(pillText(c.get()), "Offline");
    c.setDeviceOnline(true);
    assert.equal(pillText(c.get()), null);
  });

  test("a network failure shows it even while the device says online; the next success clears it", () => {
    const c = createConnection({ isOnline: () => true });
    c.reportFailed();
    assert.equal(pillText(c.get()), "Offline");
    c.reportReached();
    assert.equal(pillText(c.get()), null);
  });

  test("the online event also clears an earlier failure", () => {
    const c = createConnection({ isOnline: () => true });
    c.reportFailed();
    c.setDeviceOnline(true);
    assert.equal(pillText(c.get()), null);
  });

  test("going offline keeps a failure until something succeeds", () => {
    const c = createConnection({ isOnline: () => true });
    c.reportFailed();
    c.setDeviceOnline(false);
    c.setDeviceOnline(true); // the browser says online again
    assert.equal(pillText(c.get()), null);
  });

  test("listeners hear only real changes", () => {
    const c = createConnection({ isOnline: () => true });
    let n = 0;
    const stop = c.subscribe(() => n++);
    c.reportReached(); // no change
    c.reportFailed();
    c.reportFailed(); // no change
    c.reportReached();
    stop();
    c.reportFailed();
    assert.equal(n, 2);
  });
});

describe("pill tone", () => {
  const { pillTone } = C;
  test("grey while simply offline, with or without queued items", () => {
    assert.equal(pillTone([]), "neutral");
    assert.equal(pillTone(), "neutral");
    assert.equal(pillTone([{ status: "waiting" }, { status: "waiting" }]), "neutral");
  });

  test("amber only when a queued item is in the Needs you state", () => {
    assert.equal(pillTone([{ status: "waiting" }, { status: "needs-you" }]), "warn");
  });

  test("the pill source keeps role=status, an icon, and no amber unless warned", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/OfflinePill.jsx", import.meta.url), "utf8");
    assert.match(src, /role="status"/);
    assert.match(src, /CloudOff/);
    assert.match(src, /neutral: "border-line bg-slate text-ink"/);
    assert.match(src, /warn: "border-amber bg-amber-soft text-amber-ink"/);
  });
});

describe("text", () => {
  test("queued items show 'Offline · N waiting' only while offline", () => {
    const off = createConnection({ isOnline: () => false }).get();
    assert.equal(pillText(off, 0), "Offline");
    assert.equal(pillText(off, 3), "Offline · 3 waiting");
    const on = createConnection({ isOnline: () => true }).get();
    assert.equal(pillText(on, 3), null);
  });
});

describe("what the api reports", () => {
  test("a lost connection reports a failure; a later answer clears it (even a 400)", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await assert.rejects(proposeText("x"));
    assert.equal(pillText(connection.get()), "Offline");
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: "bad" }) });
    await assert.rejects(proposeText("x"));
    assert.equal(pillText(connection.get()), null);
  });

  test("a Cancel (abort) does not make the app look offline", async () => {
    globalThis.fetch = async () => {
      throw new DOMException("aborted", "AbortError");
    };
    await assert.rejects(proposeText("x"));
    assert.equal(pillText(connection.get()), null);
  });

  test("a timeout counts as unreachable", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    globalThis.fetch = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    const p = waitForProposal((signal) => proposeText("x", undefined, signal)).catch((e) => e);
    mock.timers.tick(40_000);
    const err = await p;
    assert.equal(err.kind, "timeout");
    assert.equal(pillText(connection.get()), "Offline");
  });
});
