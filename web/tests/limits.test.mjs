// Web tests for three fixes: the contact link, the privacy lines, and the calm
// handling of HTTP 429 (daily and hourly limits). Fake data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const L = await import("../src/limits.js");
const P = await import("../src/privacyNotes.js");
const { ApiError, friendlyError, setShop } = await import("../src/api.js");
const { toWaitError, canRetry } = await import("../src/recordWait.js");
const { createQueue } = await import("../src/offlineQueue.js");
const { queuedRow } = await import("../src/queuedRow.js");
const { CONTACT_URL } = await import("../src/config.js");
const { contactHref, CONTACT_LINK_TEXT } = await import("../src/landing/heroCopy.js");

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("Message the builder", () => {
  test("one CONTACT_URL constant holds the number and the text", () => {
    assert.equal(CONTACT_URL, "https://wa.me/2348053801610?text=Hi%2C%20I%27d%20like%20early%20access%20to%20PocketOga");
    assert.equal(contactHref(), CONTACT_URL);
    assert.equal(CONTACT_LINK_TEXT, "Message the builder");
    assert.equal((src("config.js").match(/2348053801610/g) ?? []).length, 1);
  });

  test("the link opens in a new tab with rel noopener noreferrer", () => {
    assert.match(src("landing/Hero.jsx"), /<a href=\{contact\} target="_blank" rel="noopener noreferrer"/);
  });
});

describe("privacy lines", () => {
  test("exact words", () => {
    assert.equal(P.FEEDBACK_PRIVACY, "Please don't include real customer names, phone numbers or bank details. A voice message is turned into text and then deleted.");
    assert.equal(P.DEMO_PRIVACY, "This is a demo with simulated data. Please don't enter real names, phone numbers or bank details.");
    assert.equal(P.EARLY_ACCESS_PRIVACY, "Early access: while we test, please keep customers' phone numbers and bank details out of your entries.");
  });

  test("shown under the feedback form, on the demo card (landing, Settings) and on the real-shop login card", () => {
    assert.match(src("feedback.js"), /export const PRIVACY_NOTE = FEEDBACK_PRIVACY;/);
    assert.match(src("FeedbackSection.jsx"), /\{PRIVACY_NOTE\}/);
    assert.match(src("landing/Hero.jsx"), /data-part="demo-privacy"[^]*?\{DEMO_PRIVACY\}/);
    assert.match(src("landing/FinalCta.jsx"), /data-part="demo-privacy"[^]*?\{DEMO_PRIVACY\}/);
    assert.match(src("screens/SettingsScreen.jsx"), /info\.kind === "demo" && \([^]*?\{DEMO_PRIVACY\}/);
    assert.match(src("screens/LoginScreen.jsx"), /data-part="early-access-privacy"[^]*?\{EARLY_ACCESS_PRIVACY\}/);
  });

  test("small muted text that wraps, in plain words", () => {
    for (const file of ["landing/Hero.jsx", "screens/LoginScreen.jsx", "screens/SettingsScreen.jsx"]) {
      assert.match(src(file), /text-sm[^"]*(text-muted)?[^"]*\[overflow-wrap:anywhere\]/, file);
    }
    assert.doesNotMatch(JSON.stringify(P), /\b(api|json|token|payload|pii|gdpr)\b/i);
  });
});

describe("a 429 is a calm sentence", () => {
  test("the server's own text is shown when it is plain words", () => {
    assert.equal(friendlyError(new ApiError(429, "the daily limit for voice notes is used up")), "The daily limit for voice notes is used up");
  });

  test("code-style or empty text gets our sentence", () => {
    for (const m of ["server error 429", "rate_limited", "", "payload too many"]) assert.equal(friendlyError(new ApiError(429, m)), L.LIMIT_MESSAGE, m);
    assert.equal(L.LIMIT_MESSAGE, "PocketOga has reached today's limit. Please try again later.");
  });

  test("recording, typing and photo check: a limit is its own kind, with no Try again", () => {
    const e = toWaitError(new ApiError(429, "daily limit reached for today"));
    assert.equal(e.kind, "limit");
    assert.equal(e.message, "Daily limit reached for today");
    assert.equal(canRetry(e), false);
    assert.equal(toWaitError(new ApiError(500, "x")).kind, "api");
  });

  test("feedback: the server's sentence, else 'You've sent a few messages already. Please try again in an hour.'", async () => {
    const F = await import("../src/feedback.js");
    assert.equal(F.feedbackError(new ApiError(429, "")), "You've sent a few messages already. Please try again in an hour.");
    assert.equal(F.feedbackError(new ApiError(429, "five an hour is the limit")), "Five an hour is the limit");
  });

  test("the screens show a calm notice card with an OK button, not the red error card", () => {
    const notice = src("LimitNotice.jsx");
    assert.match(notice, /data-part="limit-notice" role="status"/);
    assert.match(notice, /bg-lavender/);
    assert.doesNotMatch(notice, /coral|role="alert"/);
    assert.match(notice, /data-part="limit-ok"[^]*?OK/);
    assert.match(src("screens/RecordScreen.jsx"), /error\?\.limit && <LimitNotice message=\{error\.message\} onOk=\{\(\) => setError\(null\)\}/);
    assert.match(src("screens/RecordScreen.jsx"), /\{error && !error\.limit && \(/);
    assert.match(src("screens/AlertCheckScreen.jsx"), /problem\?\.limit && <LimitNotice message=\{problem\.message\} onOk=\{\(\) => setProblem\(null\)\}/);
    assert.match(src("screens/AlertCheckScreen.jsx"), /\{problem && !problem\.limit && \(/);
    assert.match(src("FeedbackSection.jsx"), /form\.error && form\.limit && <LimitNotice message=\{form\.error\} onOk=\{\(\) => dispatch\(\{ type: "dismiss" \}\)\}/);
  });

  test("feedback keeps what was typed and OK just closes the notice", async () => {
    const F = await import("../src/feedback.js");
    let s = F.feedbackReducer(F.emptyFeedback(), { type: "text", value: "hello" });
    s = F.feedbackReducer(s, { type: "failed", message: "Too many", limit: true });
    assert.equal(s.limit, true);
    assert.equal(s.text, "hello");
    s = F.feedbackReducer(s, { type: "dismiss" });
    assert.deepEqual([s.error, s.limit, s.text], [null, false, "hello"]);
  });

  test("the notice fits 320px: it can shrink and the text wraps", () => {
    assert.match(src("LimitNotice.jsx"), /grid min-w-0 gap-3/);
    assert.match(src("LimitNotice.jsx"), /\[overflow-wrap:anywhere\]/);
  });
});

describe("a 429 on a queued entry keeps it in Waiting to send", () => {
  function memoryStore() {
    const map = new Map();
    return { getAll: async () => [...map.values()].map((r) => structuredClone(r)), put: async (i) => void map.set(i.id, structuredClone(i)), delete: async (id) => void map.delete(id), map };
  }

  test("it stays waiting, is not counted as a failed try, and is sent again later", async () => {
    let clock = 1_000_000;
    let limited = true;
    const sent = [];
    const queue = createQueue({
      store: memoryStore(),
      now: () => clock,
      isOnline: () => true,
      send: async (item) => {
        sent.push(item.requestId);
        if (limited) throw new ApiError(429, "daily limit reached");
        return { id: "p1" };
      },
    });
    await queue.load();
    const item = await queue.enqueue("text", { text: "sold rice 5k" });
    for (let i = 0; i < 8; i++) {
      await queue.flush();
      clock += L.LIMIT_RETRY_MS + 1; // far more tries than the queue gives a failing entry
    }
    const [kept] = queue.list();
    assert.equal(kept.id, item.id);
    assert.equal(kept.status, "waiting"); // never "Needs you"
    assert.equal(kept.tries, 0);
    assert.equal(kept.limit, true);
    assert.ok(new Set(sent).size === 1); // always the same request id
    limited = false;
    await queue.flush();
    assert.equal(queue.list().length, 0);
  });

  test("the row says: PocketOga has reached today's limit. It will try again later.", () => {
    const row = queuedRow({ id: "q", kind: "text", status: "waiting", limit: true, spokenAt: "2026-11-02T08:00:00Z", payload: { text: "x" } }, () => "09:00");
    assert.equal(row.notice, "PocketOga has reached today's limit. It will try again later.");
    assert.equal(row.stuck, false);
    assert.equal(queuedRow({ id: "q", kind: "text", status: "waiting", spokenAt: "2026-11-02T08:00:00Z", payload: { text: "x" } }, () => "09:00").notice, null);
    assert.match(src("WaitingToSend.jsx"), /data-part="queued-limit"[^]*?\{row\.notice\}/);
  });
});
