// Web tests for feedback: the request format (no type), the form's checks and
// limits, the three message states, state after errors (what was typed is
// kept), offline, the compact collapsed card, the Home link and plain wording.
// Fake data only.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";

const F = await import("../src/feedback.js");
const { buildFeedbackRequest, parseFeedbackReply, FEEDBACK_ROUTE } = await import("../src/feedbackFormat.js");
const { ApiError, sendFeedback, setShop } = await import("../src/api.js");
const { MAX_RECORD_SECONDS } = await import("../src/recordLimits.js");

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const form = (extra = {}) => ({ ...F.emptyFeedback(), text: "Add a dark mode", ...extra });
const audio = (seconds = 12) => ({ blob: { size: 10 }, seconds });
const run = (...actions) => actions.reduce((s, a) => F.feedbackReducer(s, a), F.emptyFeedback());

describe("request format", () => {
  test("typed: optional rating and trimmed text, and no type", () => {
    const req = buildFeedbackRequest({ rating: 4, text: "  It is slow \n" });
    assert.equal(req.path, "/feedback");
    assert.equal(req.path, FEEDBACK_ROUTE);
    assert.deepEqual(req.body, { rating: 4, text: "It is slow" });
    assert.equal("type" in req.body, false);
  });

  test("no rating means no rating field", () => {
    assert.deepEqual(buildFeedbackRequest({ text: "Good" }).body, { text: "Good" });
    assert.deepEqual(buildFeedbackRequest({ rating: undefined, text: "Good" }).body, { text: "Good" });
  });

  test("voice: the voice route's audio fields and never text, and no type", () => {
    const body = buildFeedbackRequest({ text: "ignored", audioBase64: "AAAA" }).body;
    assert.deepEqual(body, { audioBase64: "AAAA", audioFormat: "wav" });
  });

  test("a type is never sent, even if one is passed in", () => {
    assert.equal("type" in buildFeedbackRequest({ type: "problem", text: "x" }).body, false);
    assert.doesNotMatch(read("src/feedbackFormat.js"), /input\.type|FEEDBACK_TYPES/);
  });

  test("the reply: a transcript for voice, none for typed", () => {
    assert.deepEqual(parseFeedbackReply({ ok: true }), { heard: null });
    assert.deepEqual(parseFeedbackReply({ ok: true, text: " I like it " }), { heard: "I like it" });
    assert.deepEqual(parseFeedbackReply({ ok: true, text: "  " }), { heard: null });
    assert.deepEqual(parseFeedbackReply(undefined), { heard: null });
  });
});

describe("validation and limits", () => {
  test("there is no type to pick any more", () => {
    assert.equal("type" in F.emptyFeedback(), false);
    assert.equal(F.TYPE_OPTIONS, undefined);
    assert.equal(F.validateFeedback(form()).ok, true);
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
    assert.equal(F.clampText("y".repeat(1500)).length, 1000);
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

  test("voice is at most 45 seconds, the same limit as Record", () => {
    assert.equal(F.FEEDBACK_AUDIO_MAX_SECONDS, 45);
    assert.equal(MAX_RECORD_SECONDS, 45);
    assert.equal(F.validateFeedback(form({ text: "", audio: audio(45) })).ok, true);
    assert.equal(F.validateFeedback(form({ text: "", audio: audio(60) })).field, "audio");
  });
});

describe("the three message states", () => {
  test("exactly one present: nothing extra is shown and Send is enabled", () => {
    assert.deepEqual(F.messageState(form()), { canSend: true, line: null });
    assert.deepEqual(F.messageState(form({ text: "", audio: audio() })), { canSend: true, line: null });
    assert.deepEqual(F.messageState(run({ type: "text", value: "Hello" })), { canSend: true, line: null });
    assert.deepEqual(F.messageState(run({ type: "audio", blob: {}, seconds: 5 })), { canSend: true, line: null });
  });

  test("nothing present: Send is disabled and the plain hint shows", () => {
    assert.deepEqual(F.messageState(F.emptyFeedback()), { canSend: false, line: "Write or record your message" });
    assert.deepEqual(F.messageState(form({ text: "   " })), { canSend: false, line: "Write or record your message" });
    assert.equal(F.EMPTY_HINT, "Write or record your message");
  });

  test("a voice message recorded over typed text keeps the newest (voice) and says so", () => {
    const s = run({ type: "text", value: "I typed this" }, { type: "audio", blob: {}, seconds: 7 });
    assert.equal(s.text, "");
    assert.equal(s.audio.seconds, 7);
    assert.deepEqual(F.messageState(s), { canSend: true, line: "We'll send your voice message." });
  });

  test("typing over a held voice message keeps the newest (typed) and says so", () => {
    const s = run({ type: "audio", blob: {}, seconds: 7 }, { type: "text", value: "Now I typed" });
    assert.equal(s.audio, null);
    assert.equal(s.text, "Now I typed");
    assert.deepEqual(F.messageState(s), { canSend: true, line: "We'll send your typed message." });
  });

  test("the form never holds both, and what is sent is exactly one of them", async () => {
    for (const s of [run({ type: "text", value: "a" }, { type: "audio", blob: {}, seconds: 3 }), run({ type: "audio", blob: {}, seconds: 3 }, { type: "text", value: "a" })]) {
      assert.equal(!!s.text.trim() && !!s.audio, false);
    }
    const calls = [];
    await F.runSubmit(run({ type: "text", value: "a" }, { type: "audio", blob: {}, seconds: 3 }), { online: () => true, toWav: async () => "B64", send: async (r) => (calls.push(r), { ok: true }) });
    assert.deepEqual(calls[0].body, { audioBase64: "B64", audioFormat: "wav" });
  });

  test("removing the voice message, emptying the text or sending clears the line", () => {
    const voice = run({ type: "text", value: "x" }, { type: "audio", blob: {}, seconds: 4 });
    assert.equal(F.messageState(F.feedbackReducer(voice, { type: "removeAudio" })).line, F.EMPTY_HINT);
    const typed = run({ type: "audio", blob: {}, seconds: 4 }, { type: "text", value: "x" });
    assert.equal(F.messageState(F.feedbackReducer(typed, { type: "text", value: "" })).line, F.EMPTY_HINT);
    assert.equal(F.feedbackReducer(voice, { type: "sending" }).switched, null);
  });

  test("no developer wording about one-of-text-or-audio anywhere in the form", () => {
    for (const file of ["src/feedback.js", "src/FeedbackSection.jsx", "src/feedbackFormat.js"]) {
      const text = read(file).replace(/^\s*\/\/.*$/gm, "");
      assert.doesNotMatch(text, /exactly one|one of text|text or audio|not both|Send either/i, file);
    }
  });
});

describe("form state", () => {
  test("typing and rating", () => {
    const s = run({ type: "text", value: "Broken" }, { type: "rating", value: 3 });
    assert.deepEqual([s.text, s.rating], ["Broken", 3]);
  });

  test("tapping the same star again clears the rating", () => {
    assert.equal(run({ type: "rating", value: 3 }, { type: "rating", value: 3 }).rating, null);
  });

  test("a failed send keeps everything that was typed and shows the message", () => {
    const typed = run({ type: "text", value: "Lovely app" }, { type: "rating", value: 5 });
    const sending = F.feedbackReducer(typed, { type: "sending" });
    assert.equal(sending.status, "sending");
    const failed = F.feedbackReducer(sending, { type: "failed", message: "Too many sent. Try again later." });
    assert.equal(failed.status, "idle");
    assert.equal(failed.error, "Too many sent. Try again later.");
    assert.deepEqual([failed.text, failed.rating], ["Lovely app", 5]);
  });

  test("a failed voice send keeps the recording", () => {
    const s = run({ type: "audio", blob: { id: 1 }, seconds: 20 }, { type: "sending" }, { type: "failed", message: "x" });
    assert.deepEqual(s.audio, { blob: { id: 1 }, seconds: 20 });
  });

  test("a good send clears the form and keeps the transcript for the thank-you", () => {
    const s = run({ type: "text", value: "Nice" }, { type: "sent", heard: "I like it" });
    assert.equal(s.status, "sent");
    assert.equal(s.heard, "I like it");
    assert.equal(s.text, "");
  });

  test("editing after an error clears the message but keeps the rest", () => {
    const s = run({ type: "text", value: "a" }, { type: "failed", message: "boom" }, { type: "text", value: "ab" });
    assert.equal(s.error, null);
    assert.equal(s.text, "ab");
  });
});

describe("sending", () => {
  const online = () => true;
  const fail = (status, message) => async () => {
    throw new ApiError(status, message);
  };

  test("typed message: sends the format, then Thank you", async () => {
    const calls = [];
    const out = await F.runSubmit(form({ rating: 5 }), { online, toWav: async () => "no", send: async (req) => (calls.push(req), { ok: true }) });
    assert.deepEqual(out, { type: "sent", heard: null });
    assert.deepEqual(calls[0], { path: "/feedback", body: { rating: 5, text: "Add a dark mode" } });
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
    assert.deepEqual(calls[0].body, { audioBase64: "BASE64", audioFormat: "wav" });
  });

  test("a 429 says exactly: Too many sent. Try again later.", async () => {
    const out = await F.runSubmit(form(), { online, toWav: null, send: fail(429, "slow down, 5 per hour") });
    assert.deepEqual(out, { type: "failed", message: "Too many sent. Try again later." });
  });

  test("a 400 shows the server's message when it is plain words", async () => {
    const out = await F.runSubmit(form(), { online, toWav: null, send: fail(400, "your message is too long") });
    assert.deepEqual(out, { type: "failed", message: "Your message is too long" });
  });

  test("a plain message in { error } is shown as it is, for any 4xx except the 429 sentence", async () => {
    const cases = [
      [400, "message is too short", "Message is too short"],
      [400, "rating must be a whole number from 1 to 5", "Rating must be a whole number from 1 to 5"],
      [403, "you cannot send feedback for this shop", "You cannot send feedback for this shop"],
      [409, "that was already sent", "That was already sent"],
    ];
    for (const [status, msg, shown] of cases) {
      const out = await F.runSubmit(form(), { online, toWav: null, send: fail(status, msg) });
      assert.equal(out.message, shown, msg);
    }
  });

  test("code-style server text gets the generic sentence, which is kept for unknown errors only", async () => {
    for (const msg of ["Send exactly one of text or audio", "audioBase64 is required", "invalid_field", "payload is null", "server error 400"]) {
      const out = await F.runSubmit(form(), { online, toWav: null, send: fail(400, msg) });
      assert.equal(out.message, F.REFUSED_MESSAGE, msg);
    }
    assert.equal(F.isPlainMessage("Please write something first"), true);
    assert.equal(F.isPlainMessage("PocketOga is busy"), true);
    assert.match(F.REFUSED_MESSAGE, /still here/);
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
    assert.deepEqual(out, { type: "failed", message: F.UNREADABLE_MESSAGE });
    assert.equal(sent, 0);
  });

  test("an empty form is not sent", async () => {
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

  test("POST /feedback with the shop header, a JSON body with no type and no x-request-id", async () => {
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = { url: String(url), init };
      return { ok: true, status: 201, json: async () => ({ ok: true }) };
    };
    await sendFeedback(buildFeedbackRequest({ rating: 5, text: "Great" }));
    assert.match(seen.url, /\/feedback$/);
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.headers["x-shop-id"], "demo");
    assert.equal(seen.init.headers["Content-Type"], "application/json");
    assert.equal(seen.init.headers["x-request-id"], undefined);
    assert.deepEqual(JSON.parse(seen.init.body), { rating: 5, text: "Great" });
  });

  test("a 429 reply reaches the form as the fixed sentence", async () => {
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

describe("the Home link", () => {
  test("a quiet centred text link at the very end of the Money screen, not a button, not floating", () => {
    const money = read("src/screens/MoneyScreen.jsx");
    const link = money.match(/<p className="([^"]*)">\s*<button type="button" data-part="feedback-link"[^]*?className="([^"]*)">\s*Send feedback\s*<\/button>\s*<\/p>/);
    assert.ok(link, "the link is in the Money screen");
    assert.match(link[1], /text-center/);
    assert.match(link[2], /text-muted/);
    assert.match(link[2], /underline/);
    assert.doesNotMatch(link[1] + link[2], /fixed|absolute|sticky|bg-(primary|hero|cta)|border-\[1\.5px\]/);
    assert.ok(money.indexOf("<MoneyBody report") < money.indexOf('data-part="feedback-link"'));
  });

  test("it opens Settings, expands the Feedback card and scrolls to it", () => {
    assert.match(read("src/screens/MoneyScreen.jsx"), /onClick=\{\(\) => onGo\("settings", "feedback"\)\}/);
    const settings = read("src/screens/SettingsScreen.jsx");
    assert.match(settings, /useState\(intent === "feedback"\)/); // already open on the first paint
    assert.match(settings, /intent !== "feedback"[^]*?setFeedbackOpen\(true\)[^]*?scrollIntoView/);
    assert.match(read("src/App.jsx"), /<SettingsScreen shop=\{shop\} intent=\{intent\}/);
  });

  test("there is no separate Send feedback screen or More row", () => {
    assert.doesNotMatch(read("src/App.jsx"), /FeedbackScreen|Send feedback|key: "feedback"|tab === "feedback"/);
    assert.equal(existsSync(new URL("../src/screens/FeedbackScreen.jsx", import.meta.url)), false);
  });
});

describe("the compact card", () => {
  const section = read("src/FeedbackSection.jsx");

  test("one card titled 'Send feedback' with the muted line and a chevron, folded by default", () => {
    assert.match(section, /<span>Send feedback<\/span>/);
    assert.match(section, /text-sm font-normal text-muted">Tell us what to fix or add</);
    assert.match(section, /<ChevronDown/);
    assert.match(section, /aria-expanded=\{open\}/);
    assert.match(section, /hidden=\{!open\}/);
    const settings = read("src/screens/SettingsScreen.jsx");
    assert.match(settings, /useState\(intent === "feedback"\)/);
    assert.match(settings, /onToggle=\{\(\) => setFeedbackOpen\(\(o\) => !o\)\}/);
  });

  test("the form stays mounted while folded, so a half-written message is not lost", () => {
    assert.match(section, /<div id="feedback-panel"[^>]*hidden=\{!open\}[^>]*>\s*<FeedbackBoundary>\s*<FeedbackForm/);
  });

  test("expanded it has only: a 3-line box with the counter, the mic, stars, the privacy line and Send", () => {
    for (const needle of ["rows={3}", "counterText(form.text)", 'data-part="feedback-mic"', "[1, 2, 3, 4, 5].map", "{PRIVACY_NOTE}", 'data-part="feedback-send"']) {
      assert.ok(section.includes(needle), needle);
    }
    assert.doesNotMatch(section, /What kind of feedback|TYPE_OPTIONS|feedback-type|Suggestion|Problem|Review|Lightbulb/);
  });

  test("the privacy line is always in the expanded form, word for word", () => {
    assert.equal(F.PRIVACY_NOTE, "Please don't include phone numbers or real customer names. Voice is turned into text and the recording is deleted.");
    assert.doesNotMatch(section, /PRIVACY_NOTE\s*&&|\?\s*PRIVACY_NOTE/);
  });

  test("the mic stops by itself at 45 seconds and Cancel throws the audio away", () => {
    assert.match(section, /limitSeconds: FEEDBACK_AUDIO_MAX_SECONDS/);
    assert.match(section, /rec\.discarded = true/);
    assert.match(section, /CANCELLED_MESSAGE/);
  });

  test("Send is disabled with nothing to send, and the hint line is shown", () => {
    assert.match(section, /disabled=\{!canSend \|\| sending \|\| recording\}/);
    assert.match(section, /data-part="feedback-line"/);
    assert.match(section, /messageState\(form\)/);
  });

  test("Thank you shows, then the form resets and the card folds up after a short while", () => {
    assert.ok(F.COLLAPSE_AFTER_MS >= 3000 && F.COLLAPSE_AFTER_MS <= 10000);
    assert.match(section, /setTimeout\(\(\) => \{\s*dispatch\(\{ type: "reset" \}\);\s*foldRef\.current\(\);\s*\}, COLLAPSE_AFTER_MS\)/);
    assert.match(section, /\{THANKS\}/);
  });

  test("a broken Feedback card does not break Settings: its own error boundary", () => {
    assert.match(section, /getDerivedStateFromError/);
    assert.match(section, /The rest of Settings is fine/);
  });

  test("on any error what was typed stays in the box (the form is not cleared or unmounted)", () => {
    assert.match(section, /dispatch\(action\)/);
    assert.equal((section.match(/type: "reset"/g) ?? []).length, 1); // only the timer after Thank you resets the form
  });

  test("narrow phones: 44px stars fit in a 320px screen, text wraps, no fixed colours", () => {
    assert.match(section, /grid size-11 shrink-0/);
    assert.match(section, /<div className="flex gap-1">/);
    assert.ok(5 * 44 + 4 * 4 <= 320 - 2 * 20 - 2 * 20); // stars and gaps inside the page gutter and the card padding
    assert.match(section, /overflow-wrap:anywhere/);
    assert.doesNotMatch(section, /#[0-9a-fA-F]{3,6}\b|bg-white|text-black|bg-black|text-white/);
  });
});

describe("plain wording", () => {
  const section = read("src/FeedbackSection.jsx");
  const ids = ["PRIVACY_NOTE", "OFFLINE_MESSAGE", "TOO_MANY_MESSAGE", "NETWORK_MESSAGE", "FAILED_MESSAGE", "THANKS", "EMPTY_HINT", "SENDING_VOICE", "SENDING_TEXT", "MIC_BLOCKED_MESSAGE", "MIC_EMPTY_MESSAGE", "UNREADABLE_MESSAGE", "REFUSED_MESSAGE"];

  test("no message the person can see uses developer words", () => {
    for (const id of ids) {
      const s = F[id];
      assert.equal(typeof s, "string", id);
      assert.doesNotMatch(s, /\b(audio|payload|json|api|server|field|endpoint|exactly|required|invalid|exception|status|null|undefined)\b/i, s);
      assert.doesNotMatch(s.replace(/PocketOga/g, "Pocket"), /[a-z][A-Z]|_/, s); // no code-style names
    }
  });

  test("the words written on the card are plain", () => {
    const shown = [...section.matchAll(/>\s*([A-Z][^<>{}]{3,80}?)\s*</g)].map((m) => m[1]);
    assert.ok(shown.length > 3);
    for (const s of shown) assert.doesNotMatch(s, /\b(audio|payload|json|api|endpoint|exactly one)\b/i, s);
  });
});
