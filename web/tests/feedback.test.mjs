// Web tests for "Send feedback": the request format, the form's checks and
// limits, the state after errors (what was typed is kept), offline, the two
// entry points and the screen's fixed wording. Fake data only.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";

const F = await import("../src/feedback.js");
const { buildFeedbackRequest, parseFeedbackReply, FEEDBACK_ROUTE } = await import("../src/feedbackFormat.js");
const { ApiError, sendFeedback, setShop } = await import("../src/api.js");
const { MAX_RECORD_SECONDS } = await import("../src/recordLimits.js");

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const form = (extra = {}) => ({ ...F.emptyFeedback(), type: "suggestion", text: "Add a dark mode", ...extra });
const audio = (seconds = 12) => ({ blob: { size: 10 }, seconds });

describe("request format", () => {
  test("typed: type, optional rating, trimmed text, no audio", () => {
    const req = buildFeedbackRequest({ type: "problem", rating: 4, text: "  It is slow \n" });
    assert.equal(req.path, "/feedback");
    assert.equal(req.path, FEEDBACK_ROUTE);
    assert.deepEqual(req.body, { type: "problem", rating: 4, text: "It is slow" });
  });

  test("no rating means no rating field", () => {
    assert.deepEqual(buildFeedbackRequest({ type: "review", text: "Good" }).body, { type: "review", text: "Good" });
    assert.deepEqual(buildFeedbackRequest({ type: "review", rating: undefined, text: "Good" }).body, { type: "review", text: "Good" });
  });

  test("voice: the voice route's audio fields and never text", () => {
    const body = buildFeedbackRequest({ type: "suggestion", text: "ignored", audioBase64: "AAAA" }).body;
    assert.deepEqual(body, { type: "suggestion", audioBase64: "AAAA", audioFormat: "wav" });
    assert.equal("text" in body, false);
  });

  test("the reply: a transcript for voice, none for typed", () => {
    assert.deepEqual(parseFeedbackReply({ ok: true }), { heard: null });
    assert.deepEqual(parseFeedbackReply({ ok: true, text: " I like it " }), { heard: "I like it" });
    assert.deepEqual(parseFeedbackReply({ ok: true, text: "  " }), { heard: null });
    assert.deepEqual(parseFeedbackReply(undefined), { heard: null });
  });
});

describe("validation and limits", () => {
  test("a type is required", () => {
    const out = F.validateFeedback(form({ type: null }));
    assert.equal(out.field, "type");
    assert.equal(F.validateFeedback(form({ type: "complaint" })).field, "type");
  });

  test("text or a voice message is required, and blank text does not count", () => {
    assert.equal(F.validateFeedback(form({ text: "" })).field, "text");
    assert.equal(F.validateFeedback(form({ text: "   \n " })).field, "text");
    assert.deepEqual(F.validateFeedback(form()), { ok: true, mode: "text" });
    assert.deepEqual(F.validateFeedback(form({ text: "", audio: audio() })), { ok: true, mode: "audio" });
  });

  test("text is at most 1000 characters (1000 is fine, 1001 is not)", () => {
    assert.equal(F.validateFeedback(form({ text: "x".repeat(1000) })).ok, true);
    const out = F.validateFeedback(form({ text: "x".repeat(1001) }));
    assert.equal(out.field, "text");
    assert.match(out.error, /at most 1000/);
    // the box itself cuts a long paste
    assert.equal(F.clampText("y".repeat(1500)).length, 1000);
    // the limit is on the trimmed text, as the server counts it
    assert.equal(F.validateFeedback(form({ text: ` ${"x".repeat(1000)} ` })).ok, true);
  });

  test("the counter", () => {
    assert.equal(F.counterText(""), "0 / 1000");
    assert.equal(F.counterText("hello"), "5 / 1000");
  });

  test("rating is optional, a whole number from 1 to 5", () => {
    assert.equal(F.validateFeedback(form({ rating: null })).ok, true);
    for (const r of [1, 2, 3, 4, 5]) assert.equal(F.validateFeedback(form({ rating: r })).ok, true);
    for (const r of [0, 6, 2.5, "3", -1]) assert.equal(F.validateFeedback(form({ rating: r })).field, "rating");
  });

  test("typed text and a voice message are never sent together", () => {
    const out = F.validateFeedback(form({ audio: audio() }));
    assert.equal(out.field, "text");
    assert.match(out.error, /not both/);
  });

  test("voice is at most 45 seconds, the same limit as Record", () => {
    assert.equal(F.FEEDBACK_AUDIO_MAX_SECONDS, 45);
    assert.equal(MAX_RECORD_SECONDS, 45);
    assert.equal(F.validateFeedback(form({ text: "", audio: audio(45) })).ok, true);
    assert.equal(F.validateFeedback(form({ text: "", audio: audio(60) })).field, "audio");
  });
});

describe("form state", () => {
  const run = (...actions) => actions.reduce((s, a) => F.feedbackReducer(s, a), F.emptyFeedback());

  test("picking a type, typing and rating", () => {
    const s = run({ type: "type", value: "problem" }, { type: "text", value: "Broken" }, { type: "rating", value: 3 });
    assert.deepEqual([s.type, s.text, s.rating], ["problem", "Broken", 3]);
  });

  test("tapping the same star again clears the rating", () => {
    const s = run({ type: "rating", value: 3 }, { type: "rating", value: 3 });
    assert.equal(s.rating, null);
  });

  test("recording a voice message drops typed text, and removing it goes back to typing", () => {
    let s = run({ type: "text", value: "draft" }, { type: "audio", blob: {}, seconds: 8 });
    assert.equal(s.text, "");
    assert.equal(s.audio.seconds, 8);
    s = F.feedbackReducer(s, { type: "removeAudio" });
    assert.equal(s.audio, null);
  });

  test("a failed send keeps everything that was typed and shows the message", () => {
    const typed = run({ type: "type", value: "review" }, { type: "text", value: "Lovely app" }, { type: "rating", value: 5 });
    const sending = F.feedbackReducer(typed, { type: "sending" });
    assert.equal(sending.status, "sending");
    const failed = F.feedbackReducer(sending, { type: "failed", message: "Too many sent. Try again later." });
    assert.equal(failed.status, "idle");
    assert.equal(failed.error, "Too many sent. Try again later.");
    assert.deepEqual([failed.type, failed.text, failed.rating], ["review", "Lovely app", 5]);
  });

  test("a failed voice send keeps the recording", () => {
    const s = run({ type: "type", value: "problem" }, { type: "audio", blob: { id: 1 }, seconds: 20 }, { type: "sending" }, { type: "failed", message: "x" });
    assert.deepEqual(s.audio, { blob: { id: 1 }, seconds: 20 });
  });

  test("a good send clears the form and keeps the transcript for the thank-you", () => {
    const s = run({ type: "type", value: "review" }, { type: "text", value: "Nice" }, { type: "sent", heard: "I like it" });
    assert.equal(s.status, "sent");
    assert.equal(s.heard, "I like it");
    assert.equal(s.text, "");
    assert.equal(s.type, null);
  });

  test("editing after an error clears the message but keeps the rest", () => {
    const s = run({ type: "type", value: "problem" }, { type: "text", value: "a" }, { type: "failed", message: "boom" }, { type: "text", value: "ab" });
    assert.equal(s.error, null);
    assert.equal(s.text, "ab");
    assert.equal(s.type, "problem");
  });
});

describe("sending", () => {
  const online = () => true;
  const ok = (extra) => async () => ({ ok: true, ...extra });
  const fail = (status, message) => async () => {
    throw new ApiError(status, message);
  };

  test("typed message: sends the format, then Thank you", async () => {
    const calls = [];
    const out = await F.runSubmit(form({ rating: 5 }), { online, toWav: async () => "no", send: async (req) => (calls.push(req), { ok: true }) });
    assert.deepEqual(out, { type: "sent", heard: null });
    assert.deepEqual(calls[0], { path: "/feedback", body: { type: "suggestion", rating: 5, text: "Add a dark mode" } });
    assert.equal(F.THANKS, "Thank you");
  });

  test("voice message: converts the recording, sends audio only, returns the transcript", async () => {
    const calls = [];
    const out = await F.runSubmit(form({ text: "", audio: audio() }), {
      online,
      toWav: async (blob) => (assert.deepEqual(blob, { size: 10 }), "BASE64"),
      send: async (req) => (calls.push(req), { ok: true, text: "I like the app" }),
    });
    assert.deepEqual(out, { type: "sent", heard: "I like the app" });
    assert.deepEqual(calls[0].body, { type: "suggestion", audioBase64: "BASE64", audioFormat: "wav" });
  });

  test("a 429 says exactly: Too many sent. Try again later.", async () => {
    const out = await F.runSubmit(form(), { online, toWav: null, send: fail(429, "slow down, 5 per hour") });
    assert.deepEqual(out, { type: "failed", message: "Too many sent. Try again later." });
  });

  test("a 400 shows the server's plain message", async () => {
    const out = await F.runSubmit(form(), { online, toWav: null, send: fail(400, "text is too long") });
    assert.deepEqual(out, { type: "failed", message: "Text is too long" });
  });

  test("a lost connection, a 500 and an odd error each give a plain message", async () => {
    for (const err of [new ApiError(0, "network"), new ApiError(500, "boom"), new ApiError(503, "down"), new Error("weird")]) {
      const out = await F.runSubmit(form(), { online, toWav: null, send: async () => { throw err; } });
      assert.equal(out.type, "failed");
      assert.match(out.message, /still here|not sent/i);
      assert.doesNotMatch(out.message, /boom|down|weird/);
    }
  });

  test("offline: says so, sends nothing, and keeps what was typed", async () => {
    let sent = 0;
    const out = await F.runSubmit(form(), { online: () => false, toWav: null, send: async () => void sent++ });
    assert.deepEqual(out, { type: "failed", message: F.OFFLINE_MESSAGE });
    assert.match(F.OFFLINE_MESSAGE, /offline/i);
    assert.equal(sent, 0);
    const kept = F.feedbackReducer(F.feedbackReducer(form(), { type: "sending" }), out);
    assert.equal(kept.text, "Add a dark mode");
  });

  test("a problem turning the recording into WAV is a plain message, nothing is sent", async () => {
    let sent = 0;
    const out = await F.runSubmit(form({ text: "", audio: audio() }), { online, toWav: async () => { throw new Error("decode"); }, send: async () => void sent++ });
    assert.equal(out.type, "failed");
    assert.match(out.message, /could not read that recording/i);
    assert.equal(sent, 0);
  });

  test("an invalid form is not sent", async () => {
    let sent = 0;
    const out = await F.runSubmit(form({ text: "" }), { online, toWav: null, send: async () => void sent++ });
    assert.equal(out.type, "error");
    assert.equal(sent, 0);
  });

  test("it never touches the offline queue", () => {
    for (const file of ["src/feedback.js", "src/feedbackFormat.js", "src/FeedbackSection.jsx"]) {
      assert.doesNotMatch(read(file), /offlineQueue|shopQueue|enqueue|getShopQueue/, file);
    }
  });
});

describe("over the wire", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => setShop("demo"));
  afterEach(() => (globalThis.fetch = realFetch));

  test("POST /feedback with the shop header, a JSON body and no x-request-id", async () => {
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = { url: String(url), init };
      return { ok: true, status: 201, json: async () => ({ ok: true }) };
    };
    await sendFeedback(buildFeedbackRequest({ type: "review", rating: 5, text: "Great" }));
    assert.match(seen.url, /\/feedback$/);
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.headers["x-shop-id"], "demo");
    assert.equal(seen.init.headers["Content-Type"], "application/json");
    assert.equal(seen.init.headers["x-request-id"], undefined);
    assert.deepEqual(JSON.parse(seen.init.body), { type: "review", rating: 5, text: "Great" });
  });

  test("a 429 reply reaches the form as 429 and then as the fixed sentence", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: "too many" }) });
    const out = await F.runSubmit(form(), { online: () => true, toWav: null, send: (req) => sendFeedback(req) });
    assert.deepEqual(out, { type: "failed", message: "Too many sent. Try again later." });
  });

  test("no network reaches the form as a plain message", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const out = await F.runSubmit(form(), { online: () => true, toWav: null, send: (req) => sendFeedback(req) });
    assert.equal(out.message, F.NETWORK_MESSAGE);
  });
});

describe("entry points", () => {
  test("Home: a quiet centred text link at the very end of the Money screen, not a button, not floating", () => {
    const money = read("src/screens/MoneyScreen.jsx");
    const link = money.match(/<p className="([^"]*)">\s*<button type="button" data-part="feedback-link"[^]*?className="([^"]*)">\s*Send feedback\s*<\/button>\s*<\/p>/);
    assert.ok(link, "the link is in the Money screen");
    assert.match(link[1], /text-center/);
    assert.match(link[2], /text-muted/);
    assert.match(link[2], /underline/);
    assert.doesNotMatch(link[1] + link[2], /fixed|absolute|sticky|bg-(primary|hero|cta)|border-\[1\.5px\]/);
    assert.ok(money.indexOf("<MoneyBody report") < money.indexOf('data-part="feedback-link"'));
    assert.match(money, /data-part="feedback-link"[^]*?<\/section>/);
  });

  test("Home: the link opens Settings and asks it to scroll to Feedback", () => {
    assert.match(read("src/screens/MoneyScreen.jsx"), /onClick=\{\(\) => onGo\("settings", "feedback"\)\}/);
    const settings = read("src/screens/SettingsScreen.jsx");
    assert.match(settings, /intent !== "feedback"/);
    assert.match(settings, /scrollIntoView/);
    assert.match(read("src/App.jsx"), /<SettingsScreen shop=\{shop\} intent=\{intent\}/);
  });

  test("Home: the page's own bottom padding (dock, mic, safe area) still applies, nothing is fixed", () => {
    assert.match(read("src/App.jsx"), /pb-\[calc\(152px\+max\(env\(safe-area-inset-bottom\),16px\)\)\]/);
  });

  test("there is no separate Send feedback screen or More row any more", () => {
    const app = read("src/App.jsx");
    assert.doesNotMatch(app, /FeedbackScreen|Send feedback|key: "feedback"|tab === "feedback"/);
    assert.equal(existsSync(new URL("../src/screens/FeedbackScreen.jsx", import.meta.url)), false);
  });

  test("a broken Feedback section does not break Settings: it has its own error boundary", () => {
    const section = read("src/FeedbackSection.jsx");
    assert.match(section, /getDerivedStateFromError/);
    assert.match(section, /<FeedbackBoundary>\s*<FeedbackForm \/>\s*<\/FeedbackBoundary>/);
    assert.match(section, /The rest of Settings is fine/);
  });
});

describe("the screen", () => {
  const screen = read("src/FeedbackSection.jsx");

  test("always shows the privacy line, word for word", () => {
    assert.equal(F.PRIVACY_NOTE, "Please don't include phone numbers or real customer names. Voice is turned into text and the recording is deleted.");
    assert.match(screen, /\{PRIVACY_NOTE\}/);
    assert.doesNotMatch(screen, /PRIVACY_NOTE\s*&&|\?\s*PRIVACY_NOTE/); // not conditional
  });

  test("three types: Suggestion, Problem, Review", () => {
    assert.deepEqual(F.TYPE_OPTIONS.map((t) => t.label), ["Suggestion", "Problem", "Review"]);
    assert.deepEqual(F.TYPE_OPTIONS.map((t) => t.key), ["suggestion", "problem", "review"]);
    assert.match(screen, /min-h-16/); // big tap targets
  });

  test("text box limit and counter, 45 s recorder with Cancel, optional stars", () => {
    assert.match(screen, /maxLength=\{FEEDBACK_TEXT_MAX\}/);
    assert.match(screen, /counterText\(form\.text\)/);
    assert.match(screen, /limitSeconds: FEEDBACK_AUDIO_MAX_SECONDS/);
    assert.match(screen, /createRecordTimer/);
    assert.match(screen, /rec\.discarded = true/);
    assert.match(screen, /CANCELLED_MESSAGE/);
    assert.match(screen, /\[1, 2, 3, 4, 5\]\.map/);
  });

  test("on any error what was typed stays in the box (the form is not cleared or unmounted)", () => {
    assert.doesNotMatch(screen, /type: "reset"[^]*catch/);
    assert.match(screen, /dispatch\(action\)/);
  });

  test("narrow phones: stacked full-width types, 48px stars that fit in 280px, wrapping text", () => {
    assert.match(screen, /grid gap-2/);
    assert.match(screen, /size-12/);
    assert.ok(5 * 48 + 4 * 4 <= 320 - 2 * 20); // five stars and gaps inside a 320px screen's 20px gutters
    assert.match(screen, /overflow-wrap:anywhere/);
  });

  test("light and dark: only theme tokens, no fixed colours", () => {
    assert.doesNotMatch(screen, /#[0-9a-fA-F]{3,6}\b|bg-white|text-black|bg-black|text-white/);
  });
});
