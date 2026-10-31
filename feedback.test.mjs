// POST /feedback: format, rate limit, audio privacy, owner webhook and
// ledger isolation. Fake env and mock model only; no network, no real data.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeps, handleVoiceRequest } from "./server.mjs";
import { createMockModelClient } from "./model.mjs";
import { setLogSink } from "./log.mjs";
import { DEMO_SHOP_ID } from "./auth.mjs";
import {
  FEEDBACK_TEXT_MAX,
  FEEDBACK_AUDIO_MAX_SECONDS,
  FEEDBACK_WEBHOOK_TIMEOUT_MS,
  audioSeconds,
  notifyFeedbackWebhook,
} from "./feedback.mjs";

const FAKE_ENV = { LEDGER_DB: ":memory:", META_API_KEY: "fake-test-key" };
const WEBHOOK_ENV = {
  ...FAKE_ENV,
  FEEDBACK_WEBHOOK_URL: "https://owner.example/feedback-inbox",
  FEEDBACK_WEBHOOK_SECRET: "owner-shared-secret",
};

let scratch;
before(() => {
  try {
    scratch = mkdtempSync(join(tmpdir(), "pocketoga-feedback-test-"));
  } catch {
    scratch = mkdtempSync("./.feedback-test-tmp-");
  }
});
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// Minimal 16-bit mono WAV of N seconds at 8 kHz: exact durations, small.
function wav(seconds, sampleRate = 8000) {
  const dataSize = seconds * sampleRate * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

// One valid MPEG1 Layer III frame (128 kbps, 44.1 kHz): 417 bytes, 26 ms.
function mp3Frame() {
  const len = Math.floor((144 * 128000) / 44100);
  const frame = Buffer.alloc(len);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  return frame;
}

const TRANSCRIPT = "the ledger screen takes too long to open";
const baseSetup = { modelHandler: async () => ({ heard: TRANSCRIPT, entries: [] }) };

function setup({ modelHandler = baseSetup.modelHandler, env = FAKE_ENV, fetchStub = null } = {}) {
  const deps = buildDeps(env);
  deps.model = createMockModelClient(modelHandler);
  if (fetchStub) deps.feedbackFetch = fetchStub;
  return deps;
}

function tokenFor(deps, shop) {
  deps._testTokens ??= new Map();
  if (!deps._testTokens.has(shop)) {
    const issued = deps.auths.issueCode(shop, `test-login-${shop}`, {});
    const exchanged = deps.auths.exchangeCode(shop, issued.code, {});
    if (!exchanged.ok) throw new Error(`test login failed: ${exchanged.reason}`);
    deps._testTokens.set(shop, exchanged.token);
  }
  return deps._testTokens.get(shop);
}

// Fresh shop + IP per call, so the hourly quota never leaks between cases.
let pairCount = 0;
function freshPair() {
  pairCount += 1;
  return { shop: `fb-shop-${pairCount}`, ip: `10.20.${Math.floor(pairCount / 250)}.${(pairCount % 250) + 1}` };
}

function fakeReq({ headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = "POST";
  req.url = "/feedback";
  req.headers = headers;
  req.destroy = () => {};
  const text = body === undefined ? "" : JSON.stringify(body);
  process.nextTick(() => {
    if (text) req.emit("data", Buffer.from(text));
    req.emit("end");
  });
  return req;
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    text: "",
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    end(chunk) {
      if (chunk) this.text += String(chunk);
    },
  };
}

// Like the entries dispatch: thrown status errors become the HTTP reply,
// matching what withRequestLog does in production.
async function post(deps, body, { shop = null, ip = null, token = undefined } = {}) {
  const pair = shop === null ? freshPair() : { shop, ip: ip ?? "10.30.0.1" };
  const headers = { "x-shop-id": pair.shop, "x-forwarded-for": pair.ip };
  if (token !== false) headers.authorization = `Bearer ${token ?? tokenFor(deps, pair.shop)}`;
  const res = fakeRes();
  try {
    await handleVoiceRequest(fakeReq({ headers, body }), res, deps);
  } catch (err) {
    return { status: err.status ?? 500, json: { error: err.message ?? "internal error" }, pair };
  }
  return { status: res.statusCode, json: res.text ? JSON.parse(res.text) : null, pair };
}

function assertError(res, status) {
  assert.equal(res.status, status);
  assert.ok(res.json && typeof res.json.error === "string" && res.json.error.length > 0);
}

describe("feedback format (mock model)", () => {
  it("accepts each valid type with 201 { ok: true }", async () => {
    const deps = setup();
    try {
      for (const type of ["suggestion", "problem", "review"]) {
        const res = await post(deps, { type, text: `a ${type} note` });
        assert.equal(res.status, 201);
        assert.deepEqual(res.json, { ok: true });
      }
    } finally {
      deps.db.close();
    }
  });

  it("rejects a bad or missing type with a plain 400", async () => {
    const deps = setup();
    try {
      for (const body of [
        { type: "idea", text: "x" },
        { type: "SUGGESTION", text: "x" },
        { type: "", text: "x" },
        { type: null, text: "x" },
        { text: "x" },
      ]) {
        assertError(await post(deps, body), 400);
      }
    } finally {
      deps.db.close();
    }
  });

  it("takes ratings 1 to 5, rejects bad or fractional ones", async () => {
    const deps = setup();
    try {
      for (const rating of [1, 5]) {
        const res = await post(deps, { type: "review", rating, text: "rated" });
        assert.equal(res.status, 201);
        const [row] = deps.feedback.listByShop(res.pair.shop);
        assert.equal(row.rating, rating);
      }
      const res = await post(deps, { type: "review", text: "unrated" });
      assert.equal(res.status, 201);
      assert.equal(deps.feedback.listByShop(res.pair.shop)[0].rating, null);
      for (const rating of [0, 6, 2.5, "3", true]) {
        assertError(await post(deps, { type: "review", rating, text: "x" }), 400);
      }
    } finally {
      deps.db.close();
    }
  });

  it("trims text and enforces 1 to 1000 characters", async () => {
    const deps = setup();
    try {
      const res = await post(deps, { type: "suggestion", text: "  padded note  " });
      assert.equal(res.status, 201);
      assert.equal(deps.feedback.listByShop(res.pair.shop)[0].text, "padded note");
      const full = await post(deps, { type: "suggestion", text: "x".repeat(FEEDBACK_TEXT_MAX) });
      assert.equal(full.status, 201);
      for (const text of ["", "   ", "x".repeat(FEEDBACK_TEXT_MAX + 1), 42, ["x"]]) {
        assertError(await post(deps, { type: "suggestion", text }), 400);
      }
    } finally {
      deps.db.close();
    }
  });

  it("needs exactly one of text or audio", async () => {
    const deps = setup();
    try {
      const audio = { audioBase64: wav(1).toString("base64"), audioFormat: "wav" };
      assertError(await post(deps, { type: "suggestion", text: "x", audio }), 400);
      assertError(await post(deps, { type: "suggestion" }), 400);
      assertError(await post(deps, {}), 400);
      assertError(await post(deps, { type: "suggestion", text: null, audio: null }), 400);
      assertError(await post(deps, { type: "suggestion", text: "", audio }), 400);
    } finally {
      deps.db.close();
    }
  });

  it("rejects audio that is not a short wav or mp3", async () => {
    const deps = setup();
    try {
      const good = wav(1).toString("base64");
      for (const audio of [
        { audioBase64: good, audioFormat: "flac" },
        { audioBase64: good },
        { audioBase64: good, audioFormat: "WAVV" },
        { audioBase64: "!!!not-base64!!!", audioFormat: "wav" },
        { audioBase64: "  ", audioFormat: "wav" },
        { audioBase64: Buffer.from("not audio at all").toString("base64"), audioFormat: "wav" },
        { audioBase64: Buffer.from("not audio at all").toString("base64"), audioFormat: "mp3" },
        "just-a-string",
        null,
      ]) {
        assertError(await post(deps, { type: "problem", audio }), 400);
      }
      assertError(
        await post(deps, {
          type: "problem",
          audio: { audioBase64: wav(FEEDBACK_AUDIO_MAX_SECONDS + 1).toString("base64"), audioFormat: "wav" },
        }),
        400
      );
    } finally {
      deps.db.close();
    }
  });

  it("accepts wav and mp3 at the 45 second boundary, case-insensitive", async () => {
    const deps = setup();
    try {
      const atCap = await post(deps, {
        type: "problem",
        audio: { audioBase64: wav(FEEDBACK_AUDIO_MAX_SECONDS).toString("base64"), audioFormat: "WAV" },
      });
      assert.equal(atCap.status, 201);
      assert.deepEqual(atCap.json, { ok: true, text: TRANSCRIPT });
      const mp3 = Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "binary"), ...Array.from({ length: 50 }, mp3Frame)]);
      const mp3Res = await post(deps, {
        type: "problem",
        audio: { audioBase64: mp3.toString("base64"), audioFormat: "mp3" },
      });
      assert.equal(mp3Res.status, 201);
      assert.deepEqual(mp3Res.json, { ok: true, text: TRANSCRIPT });
    } finally {
      deps.db.close();
    }
  });

  it("transcribes audio with the voice-note model call and returns the transcript", async () => {
    const seen = [];
    const deps = setup({
      modelHandler: async (request) => {
        seen.push(request);
        return { heard: TRANSCRIPT, entries: [] };
      },
    });
    try {
      const bytes = wav(2);
      const res = await post(deps, {
        type: "problem",
        audio: { audioBase64: bytes.toString("base64"), audioFormat: "wav" },
      });
      assert.equal(res.status, 201);
      assert.deepEqual(res.json, { ok: true, text: TRANSCRIPT });
      assert.equal(seen.length, 1);
      assert.deepEqual(Object.keys(seen[0].audio).sort(), ["data", "format"]);
      assert.equal(seen[0].audio.format, "wav");
      assert.ok(Buffer.from(seen[0].audio.data, "base64").equals(bytes));
    } finally {
      deps.db.close();
    }
  });

  it("answers 400 when the voice note holds no speech", async () => {
    const deps = setup({ modelHandler: async () => ({ heard: "   ", entries: [] }) });
    try {
      assertError(
        await post(deps, {
          type: "problem",
          audio: { audioBase64: wav(1).toString("base64"), audioFormat: "wav" },
        }),
        400
      );
    } finally {
      deps.db.close();
    }
  });
});

describe("feedback rate limit (mock model)", () => {
  it("allows 5 per hour, then 429s the 6th on the same IP and shop", async () => {
    const deps = setup();
    try {
      const { shop, ip } = freshPair();
      const token = tokenFor(deps, shop);
      for (let i = 0; i < 5; i++) {
        const res = await post(deps, { type: "suggestion", text: `note ${i}` }, { shop, ip, token });
        assert.equal(res.status, 201, `message ${i + 1}`);
      }
      assertError(await post(deps, { type: "suggestion", text: "one too many" }, { shop, ip, token }), 429);
      assert.equal(deps.feedback.listByShop(shop).length, 5);
    } finally {
      deps.db.close();
    }
  });

  it("counts the per-shop bucket across IPs and the per-IP bucket across shops", async () => {
    const deps = setup();
    try {
      // Same shop, fresh IP each time: the shop bucket still fills at 5.
      const shop = freshPair().shop;
      const token = tokenFor(deps, shop);
      for (let i = 0; i < 5; i++) {
        const res = await post(deps, { type: "suggestion", text: `note ${i}` }, { shop, ip: `10.31.0.${i + 1}`, token });
        assert.equal(res.status, 201);
      }
      assertError(await post(deps, { type: "suggestion", text: "other ip" }, { shop, ip: "10.31.0.99", token }), 429);
      // Same IP, fresh shops: the IP bucket fills at 5.
      const ip = "10.32.0.7";
      for (let i = 0; i < 5; i++) {
        const s = `fb-ratelimit-${pairCount}-${i}`;
        const res = await post(deps, { type: "suggestion", text: `note ${i}` }, { shop: s, ip, token: tokenFor(deps, s) });
        assert.equal(res.status, 201);
      }
      const sixth = `fb-ratelimit-${pairCount}-5`;
      assertError(
        await post(deps, { type: "suggestion", text: "sixth shop" }, { shop: sixth, ip, token: tokenFor(deps, sixth) }),
        429
      );
      // A fresh IP and shop is unaffected.
      const res = await post(deps, { type: "suggestion", text: "fresh" });
      assert.equal(res.status, 201);
    } finally {
      deps.db.close();
    }
  });

  it("invalid bodies never consume quota", async () => {
    const deps = setup();
    try {
      const { shop, ip } = freshPair();
      const token = tokenFor(deps, shop);
      for (let i = 0; i < 5; i++) {
        assertError(await post(deps, { type: "nope", text: "x" }, { shop, ip, token }), 400);
      }
      const res = await post(deps, { type: "suggestion", text: "still welcome" }, { shop, ip, token });
      assert.equal(res.status, 201);
    } finally {
      deps.db.close();
    }
  });
});

describe("feedback audio privacy (mock model)", () => {
  it("stores the transcript only: no audio column, no base64 anywhere in the row", async () => {
    const deps = setup();
    try {
      const bytes = wav(3);
      const b64 = bytes.toString("base64");
      const res = await post(deps, {
        type: "problem",
        audio: { audioBase64: b64, audioFormat: "wav" },
      });
      assert.equal(res.status, 201);
      const rows = deps.feedback.listByShop(res.pair.shop);
      assert.equal(rows.length, 1);
      assert.deepEqual(Object.keys(rows[0]).sort(), ["created_at", "id", "ip", "rating", "shop_id", "text", "type"]);
      assert.equal(rows[0].text, TRANSCRIPT);
      assert.ok(!JSON.stringify(rows[0]).includes(b64.slice(0, 64)));
    } finally {
      deps.db.close();
    }
  });

  it("never writes the audio bytes to disk", async () => {
    const dir = join(scratch, "fb-disk");
    const dbPath = join(dir, "t.db");
    const deps = setup({ env: { ...FAKE_ENV, LEDGER_DB: dbPath } });
    try {
      const bytes = wav(2);
      const b64 = bytes.toString("base64");
      const pair = freshPair();
      const res = await post(
        deps,
        { type: "problem", audio: { audioBase64: b64, audioFormat: "wav" } },
        { shop: pair.shop, ip: pair.ip }
      );
      assert.equal(res.status, 201);
      // The database file holds the transcript row but not the audio bytes.
      const raw = readFileSync(dbPath);
      assert.ok(raw.includes(TRANSCRIPT));
      assert.ok(!raw.includes(b64));
      assert.ok(!raw.includes(bytes));
      // Nothing else was written beside the database.
      assert.deepEqual(readdirSync(dir).sort(), ["t.db"]);
    } finally {
      deps.db.close();
    }
  });

  it("never logs the audio bytes or the transcript", async () => {
    const lines = [];
    setLogSink((line) => lines.push(String(line)));
    const deps = setup();
    try {
      const b64 = wav(2).toString("base64");
      const res = await post(deps, {
        type: "problem",
        audio: { audioBase64: b64, audioFormat: "wav" },
      });
      assert.equal(res.status, 201);
      const combined = lines.join("\n");
      assert.ok(!combined.includes(b64.slice(0, 64)));
      assert.ok(!combined.includes(TRANSCRIPT));
    } finally {
      deps.db.close();
      setLogSink();
    }
  });
});

describe("feedback webhook (stubbed fetch)", () => {
  function capture() {
    const lines = [];
    setLogSink((line) => lines.push(String(line)));
    return { lines, restore: () => setLogSink() };
  }

  it("posts JSON { secret, type, rating, message, source } on success, silently", async () => {
    const { lines, restore } = capture();
    const calls = [];
    const deps = setup({
      env: WEBHOOK_ENV,
      fetchStub: async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, status: 200, text: async () => "stored" };
      },
    });
    try {
      const res = await post(deps, { type: "suggestion", rating: 4, text: "dark mode please" });
      assert.equal(res.status, 201);
      assert.deepEqual(res.json, { ok: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, WEBHOOK_ENV.FEEDBACK_WEBHOOK_URL);
      assert.equal(calls[0].opts.method, "POST");
      assert.equal(calls[0].opts.headers["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(calls[0].opts.body), {
        secret: WEBHOOK_ENV.FEEDBACK_WEBHOOK_SECRET,
        type: "suggestion",
        rating: 4,
        message: "dark mode please",
        source: "text",
      });
      assert.ok(!lines.join("\n").includes("feedback-webhook failed"));
    } finally {
      deps.db.close();
      restore();
    }
  });

  it("forwards voice notes as source voice with the transcript and null rating", async () => {
    const calls = [];
    const deps = setup({
      env: WEBHOOK_ENV,
      fetchStub: async (url, opts) => {
        calls.push(JSON.parse(opts.body));
        return { ok: true, status: 200, text: async () => "ok" };
      },
    });
    try {
      const res = await post(deps, {
        type: "problem",
        audio: { audioBase64: wav(1).toString("base64"), audioFormat: "wav" },
      });
      assert.equal(res.status, 201);
      assert.deepEqual(calls, [
        {
          secret: WEBHOOK_ENV.FEEDBACK_WEBHOOK_SECRET,
          type: "problem",
          rating: null,
          message: TRANSCRIPT,
          source: "voice",
        },
      ]);
    } finally {
      deps.db.close();
    }
  });

  it("answers 201 and logs only the status when the inbox fails", async () => {
    const { lines, restore } = capture();
    let calls = 0;
    const deps = setup({
      env: WEBHOOK_ENV,
      fetchStub: async () => {
        calls += 1;
        return { ok: false, status: 500, text: async () => "boom" };
      },
    });
    try {
      const res = await post(deps, { type: "problem", text: "inbox is down" });
      assert.equal(res.status, 201);
      assert.deepEqual(res.json, { ok: true });
      assert.equal(calls, 2);
      const combined = lines.join("\n");
      assert.ok(combined.includes("feedback-webhook failed status=500"), combined);
      assert.ok(!combined.includes(WEBHOOK_ENV.FEEDBACK_WEBHOOK_URL));
      assert.ok(!combined.includes(WEBHOOK_ENV.FEEDBACK_WEBHOOK_SECRET));
      assert.ok(!combined.includes("inbox is down"));
    } finally {
      deps.db.close();
      restore();
    }
  });

  it("retries once after a thrown error, then succeeds silently", async () => {
    const { lines, restore } = capture();
    let calls = 0;
    const deps = setup({
      env: WEBHOOK_ENV,
      fetchStub: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return { ok: true, status: 200, text: async () => "ok" };
      },
    });
    try {
      const res = await post(deps, { type: "review", rating: 5, text: "love it" });
      assert.equal(res.status, 201);
      assert.equal(calls, 2);
      assert.ok(!lines.join("\n").includes("feedback-webhook failed"));
    } finally {
      deps.db.close();
      restore();
    }
  });

  it("bounds each attempt by the 5 second timeout and logs timeout", async () => {
    assert.equal(FEEDBACK_WEBHOOK_TIMEOUT_MS, 5000);
    const lines = [];
    let calls = 0;
    const out = await notifyFeedbackWebhook({
      url: "https://owner.example/inbox",
      secret: "s",
      type: "problem",
      rating: null,
      message: "hangs",
      source: "text",
      fetchFn: (url, opts) =>
        new Promise((_, reject) => {
          calls += 1;
          opts.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
      timeoutMs: 40,
      log: (line) => lines.push(String(line)),
    });
    assert.deepEqual(out, { sent: false, status: "timeout" });
    assert.equal(calls, 2);
    assert.deepEqual(lines, ["feedback-webhook failed status=timeout"]);
  });

  it("answers 201 without calling out when the variables are missing", async () => {
    const { lines, restore } = capture();
    let calls = 0;
    const deps = setup({
      env: FAKE_ENV,
      fetchStub: async () => {
        calls += 1;
        return { ok: true, status: 200, text: async () => "ok" };
      },
    });
    try {
      const res = await post(deps, { type: "suggestion", text: "no inbox configured" });
      assert.equal(res.status, 201);
      assert.deepEqual(res.json, { ok: true });
      assert.equal(calls, 0);
      assert.ok(lines.join("\n").includes("feedback-webhook failed status=missing"));
    } finally {
      deps.db.close();
      restore();
    }
  });
});

describe("feedback isolation (mock model)", () => {
  function tableCounts(db) {
    const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    return {
      ledger: count("ledger_entries"),
      corrections: count("corrections_log"),
      proposals: count("proposals"),
      products: count("products"),
      customers: count("customers"),
      secondOpinions: count("second_opinions"),
    };
  }

  it("leaves the ledger, hash chain and every shop table untouched", async () => {
    const deps = setup();
    const shop = `fb-isolation-${Date.now() % 100000}`;
    const token = tokenFor(deps, shop);
    deps.ledger.append({ shopId: shop, type: "sale", amountKobo: 500000, customer: "Ada", item: "rice" });
    deps.ledger.append({ shopId: shop, type: "payment", amountKobo: 200000, customer: "Ada" });
    deps.products.ensure({ shopId: shop, name: "Rice", unit: "bag" });
    deps.customers.upsert({ shopId: shop, name: "Ada" });
    const before = tableCounts(deps.db);
    const verifyBefore = deps.ledger.verify(shop);
    assert.equal(verifyBefore.ok, true);
    assert.ok(verifyBefore.count >= 2);
    try {
      const typed = await post(deps, { type: "suggestion", rating: 3, text: "add reports" }, { shop, ip: "10.40.0.1", token });
      assert.equal(typed.status, 201);
      const voiced = await post(
        deps,
        { type: "problem", audio: { audioBase64: wav(1).toString("base64"), audioFormat: "wav" } },
        { shop, ip: "10.40.0.2", token }
      );
      assert.equal(voiced.status, 201);
      assert.deepEqual(tableCounts(deps.db), before);
      const verifyAfter = deps.ledger.verify(shop);
      assert.deepEqual(verifyAfter, verifyBefore);
      assert.equal(deps.feedback.listByShop(shop).length, 2);
    } finally {
      deps.db.close();
    }
  });
});

describe("feedback audio durations (no model)", () => {
  it("reads exact wav and mp3 lengths, null for anything else", () => {
    assert.equal(audioSeconds(wav(1), "wav"), 1);
    assert.equal(audioSeconds(wav(FEEDBACK_AUDIO_MAX_SECONDS), "wav"), FEEDBACK_AUDIO_MAX_SECONDS);
    assert.equal(audioSeconds(wav(FEEDBACK_AUDIO_MAX_SECONDS + 1), "wav"), FEEDBACK_AUDIO_MAX_SECONDS + 1);
    const mp3 = Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "binary"), ...Array.from({ length: 100 }, mp3Frame)]);
    const seconds = audioSeconds(mp3, "mp3");
    assert.ok(Math.abs(seconds - (100 * 1152) / 44100) < 1e-9);
    assert.equal(audioSeconds(Buffer.from([1, 2, 3, 4]), "wav"), null);
    assert.equal(audioSeconds(Buffer.from("hello, no frames here"), "mp3"), null);
    assert.equal(audioSeconds(Buffer.alloc(0), "wav"), null);
  });
});
