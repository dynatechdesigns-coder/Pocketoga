// Web tests for the 360px layout fixes: what a "Waiting to send" row says, and
// guards on the markup that kept overlapping (read from source, since the
// tests cannot render a page).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const { queuedRow } = await import("../src/queuedRow.js");
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const at = (iso) => (iso === "2026-10-31T13:05:00.000Z" ? "14:05" : iso);

const item = (extra = {}) => ({ id: "a", kind: "text", payload: { text: "Ada buy 2 bags of rice" }, spokenAt: "2026-10-31T13:05:00.000Z", status: "waiting", error: null, ...extra });

describe("queued row text", () => {
  test("name, time recorded and status are separate lines", () => {
    const r = queuedRow(item(), at);
    assert.equal(r.name, "Typed note");
    assert.equal(r.recorded, "Recorded 14:05");
    assert.equal(r.status, "Waiting");
    assert.equal(r.detail, "Ada buy 2 bags of rice");
    assert.equal(r.stuck, false);
    assert.equal(r.error, null);
  });

  test("a long note is shown in full, never cut", () => {
    const long = "Chinedu buy 40 cartons of Indomie and 12 bags of rice ".repeat(8).trim();
    assert.equal(queuedRow(item({ payload: { text: long } }), at).detail, long);
  });

  test("voice and photo have a name and no note text", () => {
    assert.equal(queuedRow(item({ kind: "audio", payload: { base64: "QUJD" } }), at).name, "Voice note");
    const photo = queuedRow(item({ kind: "photo", payload: { base64: "QUJD" } }), at);
    assert.equal(photo.name, "Alert photo");
    assert.equal(photo.detail, null);
  });

  test("Needs you carries the server's message, and Cancel is labelled", () => {
    const r = queuedRow(item({ status: "needs-you", error: "Text or audio is required." }), at);
    assert.equal(r.status, "Needs you");
    assert.equal(r.stuck, true);
    assert.equal(r.error, "Text or audio is required.");
    assert.match(r.cancelLabel, /^Cancel this item$/);
  });
});

describe("markup guards", () => {
  test("the Waiting row has a 44px Cancel, wraps text, and does not use the full-width Button", () => {
    const s = src("src/WaitingToSend.jsx");
    assert.match(s, /size-11 shrink-0/); // 44px
    assert.match(s, /min-w-0 flex-1/);
    assert.match(s, /\[overflow-wrap:anywhere\]/);
    assert.match(s, /overflow-hidden/);
    assert.doesNotMatch(s, /<Button/); // Button is w-full, which stretched the old Cancel
    assert.doesNotMatch(s, /truncate|line-clamp/); // text is never hidden
  });

  test("the dock and the page keep clear of the gesture bar and the Record button", () => {
    const s = src("src/App.jsx");
    assert.match(s, /pb-\[max\(env\(safe-area-inset-bottom\),16px\)\]/); // dock
    assert.match(s, /pb-\[calc\(152px\+max\(env\(safe-area-inset-bottom\),16px\)\)\]/); // page
    assert.match(s, /min-h-\[72px\]/); // labels may grow, never clip
    assert.match(s, /leading-4/);
  });
});
