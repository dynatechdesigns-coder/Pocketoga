import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { PromiseStore } from "./promises.mjs";
import { ProductStore } from "./products.mjs";
import { SecondOpinionStore } from "./secondopinion.mjs";
import { WhatsAppStore, drainWhatsAppJobs, parseCommand } from "./whatsapp.mjs";
import { PhotoCheckStore } from "./photos.mjs";
import { createMockModelClient } from "./model.mjs";
import { handleVoiceRequest, handleWebhookOnlyRequest, createWebhookServer } from "./server.mjs";
import { AuthStore, DEMO_SHOP_ID } from "./auth.mjs";

// All fixtures are fake: fake numbers, fake secrets, fake shop data. No real
// network: fetch, ffmpeg and the clock-facing bits are all mocked.
const ENV = {
  WHATSAPP_TOKEN: "test-token-abcdef123456",
  WHATSAPP_PHONE_NUMBER_ID: "15550001111",
  WHATSAPP_APP_SECRET: "test-app-secret-xyz",
  WHATSAPP_VERIFY_TOKEN: "test-verify-token",
  WHATSAPP_ALLOWED_NUMBERS: "2348012345678, 2348098765432",
};
const FROM_A = "2348012345678";
const FROM_B = "2348098765432";
const STRANGER = "2348000000000";
const TMP_BASE = "test-wa-tmp";

const WA_PART = {
  heard: "Ada buy rice 2 bags, na 15k. She pay 10k, remain 5k.",
  entries: [
    { type: "sale", customer: "Test Customer Ada", item: "fake-rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" },
    { type: "payment", customer: "Test Customer Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
  ],
  totals: {
    totalNaira: 15000,
    totalPhrase: "15k",
    paidNaira: 10000,
    paidPhrase: "10k",
    remainderNaira: 5000,
    remainderPhrase: "remain 5k",
  },
  question: null,
};

const WA_MISMATCH = {
  ...WA_PART,
  heard: "Ada buy rice 2 bags, na 15k. She pay 10k, remain 4k.",
  totals: { ...WA_PART.totals, remainderNaira: 4000, remainderPhrase: "remain 4k" },
};

let nextMsg = 1;
const mid = () => `wamid-test-${nextMsg++}`;

function waText(from, id, body) {
  return { from, id, type: "text", text: { body } };
}
function waAudio(from, id, mediaId = "media-1") {
  return { from, id, type: "audio", audio: { id: mediaId, mime_type: "audio/ogg; codecs=opus", voice: true } };
}
function waImage(from, id, mediaId = "media-2", mime = "image/jpeg") {
  return { from, id, type: "image", image: { id: mediaId, mime_type: mime } };
}
// Realistic Meta shape: reply-button taps arrive as type "interactive"
// with the tapped id in interactive.button_reply.id.
function waButton(from, id, payload) {
  return {
    from,
    id,
    timestamp: "1780000000",
    type: "interactive",
    interactive: {
      type: "button_reply",
      button_reply: { id: payload, title: String(payload).split(":")[0] },
    },
  };
}
function wrap(messages) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "entry-1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages } }] }],
  };
}

function makeFetch() {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.endsWith("/messages")) {
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid-reply" }] }), text: async () => "{}" };
    }
    if (url.startsWith("https://fake.cdn/")) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode("fake-ogg-bytes").buffer,
        text: async () => "",
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ url: "https://fake.cdn/audio-1.ogg", mime_type: "audio/ogg; codecs=opus" }),
      text: async () => "{}",
    };
  };
  fn.calls = calls;
  return fn;
}

function makeExecFile(impl) {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push({ cmd, args });
    return impl(cmd, args);
  };
  fn.calls = calls;
  return fn;
}

function writeFakeWav(cmd, args) {
  writeFileSync(args[args.length - 1], "RIFFfake-wav-bytes");
  return { stdout: "", stderr: "" };
}

function setup(modelHandler, opts = {}) {
  const db = new DatabaseSync(":memory:");
  const ledger = new Ledger(db);
  const proposals = new ProposalStore(db);
  const promises = new PromiseStore(db);
  const products = new ProductStore(db);
  const secondOpinions = new SecondOpinionStore(db);
  const whatsapp = new WhatsAppStore(db);
  const model = createMockModelClient(modelHandler);
  const fetch = makeFetch();
  const logs = [];
  const execFile = makeExecFile(opts.execImpl ?? writeFakeWav);
  mkdirSync(TMP_BASE, { recursive: true });
  const auths = new AuthStore(db);
  const deps = {
    ledger,
    proposals,
    promises,
    products,
    secondOpinions,
    auths,
    model,
    whatsapp,
    fetch,
    log: (line) => logs.push(String(line)),
    execFile,
    waTmpDir: TMP_BASE,
    env: ENV,
    nowMs: opts.nowMs ?? null,
  };
  return { db, ledger, proposals, promises, products, auths, model, whatsapp, fetch, logs, execFile, deps };
}

async function teardown(ctx) {
  await drainWhatsAppJobs();
  ctx.db.close();
  rmSync(TMP_BASE, { recursive: true, force: true });
}

function fakeRequest({ method, url, headers, rawBody }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = () => {};
  process.nextTick(() => {
    if (rawBody !== undefined) req.emit("data", Buffer.from(rawBody));
    req.emit("end");
  });
  return req;
}

function fakeResponse() {
  const res = new EventEmitter();
  res.statusCode = null;
  res.headersSent = false;
  res.headers = {};
  res.chunks = "";
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headersSent = true;
    res.headers = headers ?? {};
  };
  res.end = (chunk) => {
    if (chunk) res.chunks += chunk;
  };
  return res;
}

// Test-only login: mint a real session through the real store, same as prod.
// Cached per shop: uncapped minting would trip the 5-issues-per-hour limit.
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

function hasAuth(headers) {
  return Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
}

async function dispatch(deps, { method, url, headers = {}, rawBody }) {
  headers = { ...headers };
  const shop = headers["x-shop-id"] ?? headers["X-Shop-Id"];
  if (shop && shop !== DEMO_SHOP_ID && deps.auths && !hasAuth(headers)) {
    headers.authorization = `Bearer ${tokenFor(deps, shop)}`;
  }
  const req = fakeRequest({ method, url, headers, rawBody });
  const res = fakeResponse();
  try {
    await handleVoiceRequest(req, res, deps);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(err.status ?? 500);
      res.end(JSON.stringify({ error: err.message ?? "internal error" }));
    }
  }
  return { status: res.statusCode, headers: res.headers, text: res.chunks };
}

// Same shape as dispatch, but through the webhook-only listener handler.
async function dispatchOnly(deps, { method, url, headers = {}, rawBody }) {
  const req = fakeRequest({ method, url, headers, rawBody });
  const res = fakeResponse();
  try {
    await handleWebhookOnlyRequest(req, res, deps);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(err.status ?? 500);
      res.end(JSON.stringify({ error: err.message ?? "internal error" }));
    }
  }
  return { status: res.statusCode, headers: res.headers, text: res.chunks };
}

function sign(raw, secret = ENV.WHATSAPP_APP_SECRET) {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

async function postWebhook(ctx, payload, opts = {}) {
  const raw = JSON.stringify(payload);
  const headers = {};
  if (!opts.noSig) headers["x-hub-signature-256"] = sign(raw, opts.secret);
  const out = await dispatch(ctx.deps, {
    method: "POST",
    url: "/webhook",
    headers,
    rawBody: opts.tamper ? `${raw} ` : raw,
  });
  await drainWhatsAppJobs();
  return out;
}

function sends(ctx) {
  return ctx.fetch.calls
    .filter((c) => c.url.endsWith("/messages"))
    .map((c) => ({ to: JSON.parse(c.opts.body).to, body: JSON.parse(c.opts.body) }));
}

function proposalCount(ctx) {
  return ctx.db.prepare("SELECT COUNT(*) AS c FROM proposals").get().c;
}

describe("whatsapp webhook (mocked fetch, no network)", () => {
  it("answers the verification handshake, rejects wrong tokens", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      const ok = await dispatch(ctx.deps, {
        method: "GET",
        url: "/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=CHALLENGE-123",
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers["Content-Type"], "text/plain");
      assert.equal(ok.text, "CHALLENGE-123");

      const wrong = await dispatch(ctx.deps, {
        method: "GET",
        url: "/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=CHALLENGE-123",
      });
      assert.equal(wrong.status, 403);
      const badMode = await dispatch(ctx.deps, {
        method: "GET",
        url: "/webhook?hub.mode=unsubscribe&hub.verify_token=test-verify-token&hub.challenge=CHALLENGE-123",
      });
      assert.equal(badMode.status, 403);
    } finally {
      await teardown(ctx);
    }
  });

  it("rejects bad, wrong-secret or missing signatures and processes nothing", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      const payload = wrap([waText(FROM_A, mid(), "fake note")]);
      assert.equal((await postWebhook(ctx, payload, { tamper: true })).status, 403);
      assert.equal((await postWebhook(ctx, payload, { secret: "wrong-secret" })).status, 403);
      assert.equal((await postWebhook(ctx, payload, { noSig: true })).status, 403);
      assert.deepEqual(ctx.fetch.calls, []);
      assert.equal(proposalCount(ctx), 0);

      const good = await postWebhook(ctx, payload);
      assert.equal(good.status, 200);
      assert.equal(proposalCount(ctx), 1);
    } finally {
      await teardown(ctx);
    }
  });

  it("ignores status callbacks without replies", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      const payload = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "entry-1",
            changes: [
              { field: "messages", value: { messaging_product: "whatsapp", statuses: [{ id: "wamid-x", status: "delivered" }] } },
            ],
          },
        ],
      };
      assert.equal((await postWebhook(ctx, payload)).status, 200);
      assert.deepEqual(sends(ctx), []);
    } finally {
      await teardown(ctx);
    }
  });

  it("records a duplicate delivery once", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      const payload = wrap([waText(FROM_A, mid(), "fake note")]);
      assert.equal((await postWebhook(ctx, payload)).status, 200);
      assert.equal((await postWebhook(ctx, payload)).status, 200);
      assert.equal(proposalCount(ctx), 1);
      assert.equal(sends(ctx).length, 1);
    } finally {
      await teardown(ctx);
    }
  });

  it("unknown senders get one polite reply and nothing else", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      const payload = wrap([waText(STRANGER, mid(), "fake note")]);
      assert.equal((await postWebhook(ctx, payload)).status, 200);
      const first = sends(ctx);
      assert.equal(first.length, 1);
      assert.equal(first[0].body.type, "text");
      assert.match(first[0].body.text.body, /not registered/);
      assert.equal(proposalCount(ctx), 0);
      // Meta retry of the same message: still just the one reply.
      assert.equal((await postWebhook(ctx, payload)).status, 200);
      assert.equal(sends(ctx).length, 1);
    } finally {
      await teardown(ctx);
    }
  });

  it("text message gets a card with Save, Fix and Reject buttons", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      assert.equal((await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fake note")]))).status, 200);
      const sent = sends(ctx);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, FROM_A);
      assert.equal(sent[0].body.type, "interactive");
      const card = sent[0].body.interactive;
      assert.match(card.body.text, /Ada buy rice/);
      assert.match(card.body.text, /₦15,000/);
      const buttons = card.action.buttons;
      assert.equal(buttons.length, 3);
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      const id = ctx.proposals.listByShop(shop)[0].id;
      assert.deepEqual(
        buttons.map((b) => b.reply.id),
        [`confirm:${id}`, `fix:${id}`, `reject:${id}`]
      );
      for (const b of buttons) assert.ok(b.reply.title.length < 20, `title too long: ${b.reply.title}`);
      assert.deepEqual(
        buttons.map((b) => b.reply.title),
        ["Save", "Fix", "Reject"]
      );
    } finally {
      await teardown(ctx);
    }
  });

  it("flagged proposals get no Save button", async () => {
    const ctx = setup(async () => WA_MISMATCH);
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fake note")]));
      const buttons = sends(ctx)[0].body.interactive.action.buttons;
      assert.equal(buttons.length, 2);
      assert.ok(buttons.every((b) => !b.reply.id.startsWith("confirm:")));
      assert.match(sends(ctx)[0].body.interactive.body.text, /₦15,000 − ₦10,000 = ₦5,000, but you said ₦4,000 remain\. Which one na correct\?/);
    } finally {
      await teardown(ctx);
    }
  });

  it("Save confirms and reports what was recorded", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fake note")]));
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      const id = ctx.proposals.listByShop(shop)[0].id;
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `confirm:${id}`)]));
      assert.equal(ctx.ledger.list(shop).length, 2);
      const reply = sends(ctx).at(-1).body;
      assert.equal(reply.type, "text");
      assert.match(reply.text.body, /✅ \*Saved\*/);
      assert.match(reply.text.body, /₦15,000/);
      assert.match(reply.text.body, /owes \*₦5,000\*/);
    } finally {
      await teardown(ctx);
    }
  });

  it("Save pressed twice records once", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fake note")]));
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      const id = ctx.proposals.listByShop(shop)[0].id;
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `confirm:${id}`)]));
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `confirm:${id}`)]));
      assert.equal(ctx.ledger.list(shop).length, 2);
      assert.match(sends(ctx).at(-1).body.text.body, /Already saved/);
      assert.equal(ctx.ledger.verify(shop).ok, true);
    } finally {
      await teardown(ctx);
    }
  });

  it("Reject discards without touching the ledger", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fake note")]));
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      const id = ctx.proposals.listByShop(shop)[0].id;
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `reject:${id}`)]));
      assert.equal(ctx.proposals.get(id).status, "rejected");
      assert.deepEqual(ctx.ledger.list(shop), []);
      assert.match(sends(ctx).at(-1).body.text.body, /Not saved/);
    } finally {
      await teardown(ctx);
    }
  });

  it("Fix asks for a correction, then applies the next text through fixProposal", async () => {
    const ctx = setup(async (req) => (req.prior ? WA_PART : WA_MISMATCH));
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fake note")]));
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      const id = ctx.proposals.listByShop(shop)[0].id;
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `fix:${id}`)]));
      assert.match(sends(ctx).at(-1).body.text.body, /correction/);

      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "remainder na 5k")]));
      const revised = sends(ctx).at(-1).body;
      assert.equal(revised.type, "interactive");
      assert.equal(revised.interactive.action.buttons.length, 3); // Save is back
      // Fix state cleared: the next note proposes anew instead of correcting.
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "another fake note")]));
      assert.equal(ctx.proposals.listByShop(shop).length, 2);
    } finally {
      await teardown(ctx);
    }
  });

  it("buttons for another shop's proposal are refused", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fake note")]));
      const shopA = ctx.whatsapp.getOrCreateShop(FROM_A);
      const id = ctx.proposals.listByShop(shopA)[0].id;
      await postWebhook(ctx, wrap([waButton(FROM_B, mid(), `confirm:${id}`)]));
      assert.match(sends(ctx).at(-1).body.text.body, /another shop/);
      assert.deepEqual(ctx.ledger.list(), []);
      assert.equal(ctx.proposals.get(id).status, "pending");
    } finally {
      await teardown(ctx);
    }
  });

  it("Save tap with a raw Meta button_reply payload saves and reports", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fake note")]));
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      const id = ctx.proposals.listByShop(shop)[0].id;
      // Raw Meta shape, as delivered: context, timestamp, button_reply id.
      const tap = {
        from: FROM_A,
        id: mid(),
        timestamp: "1780000001",
        type: "interactive",
        context: { from: FROM_A, id: "wamid-test-context" },
        interactive: { type: "button_reply", button_reply: { id: `confirm:${id}`, title: "Save" } },
      };
      assert.equal((await postWebhook(ctx, wrap([tap]))).status, 200);
      assert.equal(ctx.ledger.list(shop).length, 2);
      const reply = sends(ctx).at(-1).body;
      assert.equal(reply.type, "text");
      assert.match(reply.text.body, /✅ \*Saved\*/);
      assert.match(reply.text.body, /₦15,000/);
      assert.match(reply.text.body, /owes \*₦5,000\*/);
    } finally {
      await teardown(ctx);
    }
  });

  it("repeated Save taps record once", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fake note")]));
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      const id = ctx.proposals.listByShop(shop)[0].id;
      // Two distinct taps (separate message ids), not a Meta redelivery.
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `confirm:${id}`)]));
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `confirm:${id}`)]));
      assert.equal(ctx.ledger.list(shop).length, 2);
      assert.match(sends(ctx).at(-1).body.text.body, /Already saved/);
      assert.equal(ctx.ledger.verify(shop).ok, true);
    } finally {
      await teardown(ctx);
    }
  });

  it("unknown button ids and list replies get a polite reply, nothing saved", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fake note")]));
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      const id = ctx.proposals.listByShop(shop)[0].id;
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), "nonsense")])); // no action:id shape
      assert.match(sends(ctx).at(-1).body.text.body, /didn't understand that button/);
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `confirm:${id + 999}`)])); // no such proposal
      assert.match(sends(ctx).at(-1).body.text.body, /can't find that proposal/);
      const listTap = {
        from: FROM_A,
        id: mid(),
        timestamp: "1780000002",
        type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "row-1", title: "Row", description: "fake row" } },
      };
      await postWebhook(ctx, wrap([listTap]));
      assert.match(sends(ctx).at(-1).body.text.body, /can only read text, voice notes and photos/);
      assert.deepEqual(ctx.ledger.list(shop), []);
      assert.equal(ctx.proposals.get(id).status, "pending");
    } finally {
      await teardown(ctx);
    }
  });

  it("audio downloads, converts with ffmpeg, then proposes", async () => {
    const seen = [];
    const ctx = setup(async (req) => {
      seen.push(req);
      return WA_PART;
    });
    try {
      await postWebhook(ctx, wrap([waAudio(FROM_A, mid())]));
      // Media info lookup then immediate authenticated download.
      const info = ctx.fetch.calls.find((c) => c.url === "https://graph.facebook.com/v25.0/media-1");
      assert.ok(info, "media url lookup");
      assert.equal(info.opts.headers.Authorization, `Bearer ${ENV.WHATSAPP_TOKEN}`);
      const cdn = ctx.fetch.calls.find((c) => c.url.startsWith("https://fake.cdn/"));
      assert.ok(cdn, "media download");
      assert.equal(cdn.opts.headers.Authorization, `Bearer ${ENV.WHATSAPP_TOKEN}`);
      // One ffmpeg call: ogg in, 16 kHz mono wav out.
      assert.equal(ctx.execFile.calls.length, 1);
      const { cmd, args } = ctx.execFile.calls[0];
      assert.equal(cmd, "ffmpeg");
      assert.ok(args.includes("16000") && args.includes("-ar"));
      assert.ok(args.includes("1") && args.includes("-ac"));
      assert.ok(args.some((a) => a.endsWith("note.ogg")));
      assert.ok(args.some((a) => a.endsWith("note.wav")));
      // The model got wav audio and the trader got an ack plus a card.
      assert.equal(seen.length, 1);
      assert.equal(seen[0].audio.format, "wav");
      assert.equal(sends(ctx).length, 2);
      assert.equal(sends(ctx)[0].body.type, "text");
      assert.equal(sends(ctx)[0].body.text.body, "Got it, checking…");
      assert.equal(sends(ctx)[1].body.type, "interactive");
      assert.equal(proposalCount(ctx), 1);
      // Temp audio cleaned up.
      assert.deepEqual(readdirSync(TMP_BASE), []);
    } finally {
      await teardown(ctx);
    }
  });

  it("missing ffmpeg gets a send-it-as-text reply and no proposal", async () => {
    const missing = async () => {
      throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    };
    const ctx = setup(async () => WA_PART, { execImpl: missing });
    try {
      await postWebhook(ctx, wrap([waAudio(FROM_A, mid())]));
      assert.equal(sends(ctx).length, 1);
      assert.match(sends(ctx)[0].body.text.body, /send it as text/);
      assert.equal(proposalCount(ctx), 0);
    } finally {
      await teardown(ctx);
    }
  });

  it("voice corrections go through fixProposal", async () => {
    const ctx = setup(async (req) => {
      if (req.audio) return { heard: "remainder na 5k" };
      if (req.prior) return WA_PART;
      return WA_MISMATCH;
    });
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fake note")]));
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      const id = ctx.proposals.listByShop(shop)[0].id;
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `fix:${id}`)]));
      await postWebhook(ctx, wrap([waAudio(FROM_A, mid())]));
      const revised = sends(ctx).at(-1).body;
      assert.equal(revised.type, "interactive");
      assert.equal(revised.interactive.action.buttons.length, 3);
      assert.equal(ctx.execFile.calls.length, 1);
    } finally {
      await teardown(ctx);
    }
  });

  it("logs mask numbers and never include secrets", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fake note")]));
      await postWebhook(ctx, wrap([waText(STRANGER, mid(), "fake note")]));
      assert.ok(ctx.logs.length > 0, "expected some log lines");
      for (const line of ctx.logs) {
        assert.ok(!line.includes(ENV.WHATSAPP_TOKEN), `token in log: ${line}`);
        assert.ok(!line.includes(ENV.WHATSAPP_APP_SECRET), `secret in log: ${line}`);
        assert.ok(!line.includes(ENV.WHATSAPP_VERIFY_TOKEN), `verify token in log: ${line}`);
        assert.ok(!line.includes(FROM_A), `full number in log: ${line}`);
        assert.ok(!line.includes(STRANGER), `full number in log: ${line}`);
      }
      assert.ok(ctx.logs.some((l) => l.includes("***78")), `masked sender missing: ${ctx.logs.join(" | ")}`);
    } finally {
      await teardown(ctx);
    }
  });
});

describe("debt commands (fake data, clock fixed at Wed 28 Oct 2026 Lagos)", () => {
  const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
  const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
  function seedSale(ctx, shop, customer, kobo, ago) {
    return ctx.ledger.append({ shopId: shop, type: "sale", amountKobo: kobo, customer, createdAt: daysAgo(ago) });
  }
  function seedPayment(ctx, shop, customer, kobo, ago) {
    return ctx.ledger.append({ shopId: shop, type: "payment", amountKobo: kobo, customer, createdAt: daysAgo(ago) });
  }
  function shopOf(ctx, from = FROM_A) {
    return ctx.whatsapp.getOrCreateShop(from);
  }

  it("who owes answers from the ledger without calling the model", async () => {
    const calls = [];
    const ctx = setup(
      async (req) => {
        calls.push(req);
        return WA_PART;
      },
      { nowMs: NOW }
    );
    try {
      const shop = shopOf(ctx);
      seedSale(ctx, shop, "Ada", 2000000, 12);
      seedPayment(ctx, shop, "Ada", 500000, 2);
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "who owes")]));
      assert.equal(calls.length, 0);
      const reply = sends(ctx).at(-1).body;
      assert.equal(reply.type, "text");
      assert.match(reply.text.body, /Who owes/);
      assert.match(reply.text.body, /Ada owes \*₦15,000\* \(12 days old\)/);
    } finally {
      await teardown(ctx);
    }
  });

  it("chase ranks and drafts the top customer in three tones", async () => {
    const calls = [];
    const ctx = setup(
      async (req) => {
        calls.push(req);
        return WA_PART;
      },
      { nowMs: NOW }
    );
    try {
      const shop = shopOf(ctx);
      seedSale(ctx, shop, "Ada", 2000000, 12);
      seedSale(ctx, shop, "Bola", 500000, 3);
      ctx.promises.create({ shopId: shop, customer: "Ada", amountKobo: 2000000, dueDate: "2026-10-20" });
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "chase")]));
      assert.equal(calls.length, 0);
      const reply = sends(ctx).at(-1).body;
      assert.equal(reply.type, "text");
      assert.match(reply.text.body, /Chase list/);
      assert.match(reply.text.body, /1\. Ada: \*₦20,000\* \(12 days old, 1 broken promise\)/);
      assert.match(reply.text.body, / Friendly: .*Ada.*₦20,000.*12 days old/);
      assert.match(reply.text.body, / Firm: /);
      assert.match(reply.text.body, / Final: /);
    } finally {
      await teardown(ctx);
    }
  });

  it("balance shows debt, age and kept-rate; unknown names get a polite reply", async () => {
    const calls = [];
    const ctx = setup(
      async (req) => {
        calls.push(req);
        return WA_PART;
      },
      { nowMs: NOW }
    );
    try {
      const shop = shopOf(ctx);
      seedSale(ctx, shop, "Ada", 2000000, 12);
      seedPayment(ctx, shop, "Ada", 500000, 2);
      const kept = ctx.promises.create({ shopId: shop, customer: "Ada", amountKobo: 500000, dueDate: "2026-10-25" });
      ctx.promises.resolve(kept.id, { status: "kept" });
      ctx.promises.create({ shopId: shop, customer: "Ada", amountKobo: 2000000, dueDate: "2026-10-20" });
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "balance Ada")]));
      assert.equal(calls.length, 0);
      const reply = sends(ctx).at(-1).body;
      assert.match(reply.text.body, /Ada owes \*₦15,000\* \(12 days old\)/);
      assert.match(reply.text.body, /Promises kept: 1 of 2 \(50%\)/);

      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "balance Nobody")]));
      assert.equal(calls.length, 0);
      assert.match(sends(ctx).at(-1).body.text.body, /no record for "Nobody"/);
    } finally {
      await teardown(ctx);
    }
  });

  it("commands are case-insensitive; bare balance is a note", async () => {
    const calls = [];
    const ctx = setup(
      async (req) => {
        calls.push(req);
        return WA_PART;
      },
      { nowMs: NOW }
    );
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "WHO OWES?")]));
      assert.equal(calls.length, 0);
      assert.match(sends(ctx).at(-1).body.text.body, /Who owes/);

      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "balance")]));
      assert.equal(calls.length, 1);
      assert.equal(sends(ctx).at(-1).body.type, "interactive");
    } finally {
      await teardown(ctx);
    }
  });

  it("promises due today ride on text replies and cards", async () => {
    const ctx = setup(async () => WA_PART, { nowMs: NOW });
    try {
      const shop = shopOf(ctx);
      ctx.promises.create({ shopId: shop, customer: "Ada", amountKobo: 2000000, dueDate: "2026-10-28" });
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "who owes")]));
      assert.match(sends(ctx).at(-1).body.text.body, /Due today: Ada promised ₦20,000/);

      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fake note")]));
      const card = sends(ctx).at(-1).body;
      assert.equal(card.type, "interactive");
      assert.match(card.interactive.body.text, /Due today: Ada promised ₦20,000/);
    } finally {
      await teardown(ctx);
    }
  });

  it("report answers without calling the model", async () => {
    const calls = [];
    const ctx = setup(
      async (req) => {
        calls.push(req);
        return WA_PART;
      },
      { nowMs: NOW }
    );
    try {
      const shop = shopOf(ctx);
      seedSale(ctx, shop, "Ada", 2000000, 40);
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "report")]));
      assert.equal(calls.length, 0);
      const reply = sends(ctx).at(-1).body;
      assert.equal(reply.type, "text");
      assert.match(reply.text.body, /Money check/);
      assert.match(reply.text.body, /Owed \*₦20,000\* \(1 customer\), \*₦20,000\* over 30 days/);
    } finally {
      await teardown(ctx);
    }
  });

  it("stock lists the lowest-stock items without calling the model", async () => {
    const calls = [];
    const ctx = setup(
      async (req) => {
        calls.push(req);
        return WA_PART;
      },
      { nowMs: NOW }
    );
    try {
      const shop = shopOf(ctx);
      ctx.ledger.append({ shopId: shop, type: "restock", amountKobo: 10000000, customer: shop, item: "rice", quantity: 10, unit: "bag" });
      ctx.ledger.append({ shopId: shop, type: "sale", amountKobo: 9000000, customer: "Ada", item: "rice", quantity: 9, unit: "bag" });
      ctx.products.ensure({ shopId: shop, name: "rice", unit: "bag" });
      ctx.products.ensure({ shopId: shop, name: "yam", unit: "tuber" });
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "stock")]));
      assert.equal(calls.length, 0);
      const reply = sends(ctx).at(-1).body;
      assert.equal(reply.type, "text");
      assert.match(reply.text.body, /Stock/);
      assert.match(reply.text.body, /yam \(tuber\): 0 left/);
      assert.match(reply.text.body, /rice \(bag\): 1 left/);
      assert.ok(reply.text.body.length <= 1024);
    } finally {
      await teardown(ctx);
    }
  });

  it("parses expenses exactly", () => {
    assert.deepEqual(parseCommand("expenses"), { name: "expenses", period: "today" });
    assert.deepEqual(parseCommand("  EXPENSES! "), { name: "expenses", period: "today" });
    assert.equal(parseCommand("expense"), null);
    assert.equal(parseCommand("my expenses"), null);
  });

  it("expenses answers today's totals by category without calling the model", async () => {
    const calls = [];
    const ctx = setup(
      async (req) => {
        calls.push(req);
        return WA_PART;
      },
      { nowMs: NOW }
    );
    try {
      const shop = shopOf(ctx);
      ctx.ledger.append({ shopId: shop, type: "expense", amountKobo: 500000, customer: "NEPA", item: "power", createdAt: daysAgo(0) });
      ctx.ledger.append({ shopId: shop, type: "expense", amountKobo: 200000, customer: shop, item: "fuel", createdAt: daysAgo(0) });
      ctx.ledger.append({ shopId: shop, type: "expense", amountKobo: 99999900, customer: shop, item: "rent", createdAt: daysAgo(1) });
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "expenses")]));
      assert.equal(calls.length, 0);
      const reply = sends(ctx).at(-1).body;
      assert.equal(reply.type, "text");
      assert.match(reply.text.body, /Expenses today/);
      assert.match(reply.text.body, /Total \*₦7,000\*/);
      assert.match(reply.text.body, /Power \*₦5,000\*/);
      assert.match(reply.text.body, /Fuel \*₦2,000\*/);
      assert.ok(!reply.text.body.includes("Rent"), reply.text.body);
      assert.ok(reply.text.body.length <= 1024);
    } finally {
      await teardown(ctx);
    }
  });

  it("profit answers today, week and month without calling the model", async () => {
    const calls = [];
    const ctx = setup(
      async (req) => {
        calls.push(req);
        return WA_PART;
      },
      { nowMs: NOW }
    );
    try {
      const shop = shopOf(ctx);
      const stamp = new Date(NOW).toISOString();
      ctx.ledger.append({ shopId: shop, type: "restock", amountKobo: 6000000, customer: shop, item: "rice", quantity: 10, unit: "bag", createdAt: "2026-10-01T10:00:00.000Z" });
      ctx.ledger.append({ shopId: shop, type: "sale", amountKobo: 4000000, customer: "Ada", item: "rice", quantity: 4, unit: "bag", createdAt: stamp });
      ctx.ledger.append({ shopId: shop, type: "payment", amountKobo: 1000000, customer: "Ada", createdAt: stamp });
      ctx.ledger.append({ shopId: shop, type: "expense", amountKobo: 500000, customer: "NEPA", item: "power", createdAt: stamp });

      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "profit")]));
      assert.equal(calls.length, 0);
      const reply = sends(ctx).at(-1).body;
      assert.equal(reply.type, "text");
      assert.match(reply.text.body, /\*Profit today\*/);
      assert.match(reply.text.body, /Sales \*₦40,000\*/);
      assert.match(reply.text.body, /Collected \*₦10,000\*/);
      assert.match(reply.text.body, /Cost of goods \*₦24,000\*/);
      assert.match(reply.text.body, /Expenses \*₦5,000\*/);
      assert.match(reply.text.body, /Profit: \*₦11,000\*/);
      assert.match(reply.text.body, /Owed to you: \*₦30,000\*/);
      assert.ok(!reply.text.body.includes("cost missing"), reply.text.body);
      assert.ok(reply.text.body.length <= 1024);

      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "profit week")]));
      assert.equal(calls.length, 0);
      assert.match(sends(ctx).at(-1).body.text.body, /\*Profit this week\*/);

      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "PROFIT MONTH!")]));
      assert.equal(calls.length, 0);
      assert.match(sends(ctx).at(-1).body.text.body, /\*Profit this month\*/);
    } finally {
      await teardown(ctx);
    }
  });

  it("profit week reports a loss as Loss with a positive amount", async () => {
    const calls = [];
    const ctx = setup(
      async (req) => {
        calls.push(req);
        return WA_PART;
      },
      { nowMs: NOW }
    );
    try {
      const shop = shopOf(ctx);
      const stamp = new Date(NOW).toISOString();
      ctx.ledger.append({ shopId: shop, type: "restock", amountKobo: 6000000, customer: shop, item: "rice", quantity: 10, unit: "bag", createdAt: "2026-10-01T10:00:00.000Z" });
      ctx.ledger.append({ shopId: shop, type: "sale", amountKobo: 4000000, customer: "Ada", item: "rice", quantity: 4, unit: "bag", createdAt: stamp });
      ctx.ledger.append({ shopId: shop, type: "expense", amountKobo: 2500000, customer: "NEPA", item: "power", createdAt: stamp });

      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "profit week")]));
      assert.equal(calls.length, 0);
      const body = sends(ctx).at(-1).body.text.body;
      assert.match(body, /Loss: \*₦9,000\*/);
      assert.ok(!body.includes("-₦"), body);
      assert.match(body, /Owed to you: \*₦40,000\*/);
      assert.ok(body.length <= 1024);
    } finally {
      await teardown(ctx);
    }
  });

  it("anything but the three profit commands is a note", async () => {
    const calls = [];
    const ctx = setup(
      async (req) => {
        calls.push(req);
        return WA_PART;
      },
      { nowMs: NOW }
    );
    try {
      shopOf(ctx);
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "profit year")]));
      assert.equal(calls.length, 1);
      assert.equal(sends(ctx).at(-1).body.type, "interactive");
    } finally {
      await teardown(ctx);
    }
  });

  it("GET /report serves the shop only, never on the webhook port", async () => {
    const ctx = setup(async () => WA_PART, { nowMs: NOW });
    try {
      const shop = shopOf(ctx);
      seedSale(ctx, shop, "Ada", 2000000, 40);
      seedSale(ctx, "other-shop", "Zed", 9000000, 9);
      const res = await dispatch(ctx.deps, { method: "GET", url: "/report", headers: { "x-shop-id": shop } });
      assert.equal(res.status, 200);
      const report = JSON.parse(res.text).report;
      assert.deepEqual(report.owed, { totalKobo: 2000000, customers: 1 });
      assert.deepEqual(report.overdue, { amountKobo: 2000000 });
      assert.deepEqual(report.broken, { count: 0, amountKobo: 0 });
      assert.deepEqual(report.shortfalls, []);
      assert.equal(report.noStockRecord, 0);
      assert.deepEqual(report.belowCost, { items: [], skippedItems: 0 });
      assert.ok(!("total" in report));
      assert.equal((await dispatchOnly(ctx.deps, { method: "GET", url: "/report", headers: { "x-shop-id": shop } })).status, 404);
    } finally {
      await teardown(ctx);
    }
  });

  it("GET /debts and /promises serve the shop only, never on the webhook port", async () => {
    const ctx = setup(async () => WA_PART, { nowMs: NOW });
    try {
      const shop = shopOf(ctx);
      seedSale(ctx, shop, "Ada", 2000000, 12);
      seedSale(ctx, "other-shop", "Zed", 9000000, 9);
      ctx.promises.create({ shopId: shop, customer: "Ada", amountKobo: 2000000, dueDate: "2026-10-30" });
      ctx.promises.create({ shopId: "other-shop", customer: "Zed", dueDate: "2026-10-30" });

      const debts = await dispatch(ctx.deps, { method: "GET", url: "/debts", headers: { "x-shop-id": shop } });
      assert.equal(debts.status, 200);
      const debtsJson = JSON.parse(debts.text);
      assert.deepEqual(
        debtsJson.debts.map((d) => d.customer),
        ["Ada"]
      );
      assert.equal(debtsJson.chase[0].customer, "Ada");
      assert.ok(debtsJson.chase[0].score > 0);

      const promises = await dispatch(ctx.deps, { method: "GET", url: "/promises", headers: { "x-shop-id": shop } });
      assert.equal(promises.status, 200);
      assert.equal(JSON.parse(promises.text).promises.length, 1);

      assert.equal((await dispatchOnly(ctx.deps, { method: "GET", url: "/debts", headers: { "x-shop-id": shop } })).status, 404);
      assert.equal((await dispatchOnly(ctx.deps, { method: "GET", url: "/promises", headers: { "x-shop-id": shop } })).status, 404);
    } finally {
      await teardown(ctx);
    }
  });
});

describe("webhook-only listener (WEBHOOK_PORT)", () => {
  it("builds an HTTP server around the webhook-only handler", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      const server = createWebhookServer(ctx.deps);
      assert.equal(typeof server.listen, "function");
      assert.equal(typeof server.close, "function");
    } finally {
      await teardown(ctx);
    }
  });

  it("returns 404 for /ledger, /propose, /confirm and /proposals", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      const shop = { "x-shop-id": "shop-a" };
      assert.equal((await dispatchOnly(ctx.deps, { method: "GET", url: "/ledger", headers: shop })).status, 404);
      assert.equal(
        (await dispatchOnly(ctx.deps, { method: "POST", url: "/propose", headers: shop, rawBody: JSON.stringify({ text: "fake note" }) })).status,
        404
      );
      assert.equal(
        (await dispatchOnly(ctx.deps, { method: "POST", url: "/confirm/1", headers: shop, rawBody: "{}" })).status,
        404
      );
      assert.equal((await dispatchOnly(ctx.deps, { method: "GET", url: "/proposals/1", headers: shop })).status, 404);
      // Nothing was processed: the blocked propose stored nothing.
      assert.equal(proposalCount(ctx), 0);
      assert.deepEqual(ctx.fetch.calls, []);
    } finally {
      await teardown(ctx);
    }
  });

  it("returns 404 for other methods and subpaths of /webhook", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      assert.equal((await dispatchOnly(ctx.deps, { method: "PUT", url: "/webhook" })).status, 404);
      assert.equal((await dispatchOnly(ctx.deps, { method: "DELETE", url: "/webhook" })).status, 404);
      assert.equal((await dispatchOnly(ctx.deps, { method: "GET", url: "/webhook/extra" })).status, 404);
      assert.equal((await dispatchOnly(ctx.deps, { method: "GET", url: "/" })).status, 404);
    } finally {
      await teardown(ctx);
    }
  });

  it("still verifies and processes /webhook", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      const ok = await dispatchOnly(ctx.deps, {
        method: "GET",
        url: "/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=CH-ONLY-1",
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.text, "CH-ONLY-1");

      const payload = wrap([waText(FROM_A, mid(), "fake note")]);
      const raw = JSON.stringify(payload);
      const out = await dispatchOnly(ctx.deps, {
        method: "POST",
        url: "/webhook",
        headers: { "x-hub-signature-256": sign(raw) },
        rawBody: raw,
      });
      assert.equal(out.status, 200);
      await drainWhatsAppJobs();
      assert.equal(proposalCount(ctx), 1);
      assert.equal(sends(ctx).length, 1);
      assert.equal(sends(ctx)[0].body.type, "interactive");

      // Signature check unchanged: tampered body is rejected, nothing stored.
      const bad = await dispatchOnly(ctx.deps, {
        method: "POST",
        url: "/webhook",
        headers: { "x-hub-signature-256": sign(raw) },
        rawBody: `${raw} `,
      });
      assert.equal(bad.status, 403);
      await drainWhatsAppJobs();
      assert.equal(proposalCount(ctx), 1);
    } finally {
      await teardown(ctx);
    }
  });
});

describe("fix last command", () => {
  const WA_FIX = {
    heard: "Ada buy rice, na 12k.",
    entries: [
      { type: "sale", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 12000, amountPhrase: "12k", priceBasis: "total" },
    ],
    totals: null,
    question: null,
  };

  it("parses fix last with and without text, nothing else", () => {
    assert.deepEqual(parseCommand("fix last"), { name: "fixlast" });
    assert.deepEqual(parseCommand("  FIX LAST! "), { name: "fixlast" });
    assert.deepEqual(parseCommand("fix last Ada paid 12k"), { name: "fixlast", arg: "Ada paid 12k" });
    assert.equal(parseCommand("fix"), null);
    assert.equal(parseCommand("fix lastly"), null);
  });

  it("fix last with text proposes a correction card with Save, Fix and Reject", async () => {
    const ctx = setup(async () => WA_FIX);
    try {
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      const sale = ctx.ledger.append({ shopId: shop, type: "sale", amountKobo: 1500000, customer: "Ada" });
      assert.equal((await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fix last Ada buy rice, na 12k")]))).status, 200);
      const sent = sends(ctx);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].body.type, "interactive");
      const card = sent[0].body.interactive;
      assert.match(card.body.text, /Fixes entry #\d+/);
      assert.match(card.body.text, /₦12,000/);
      assert.deepEqual(
        card.action.buttons.map((b) => b.reply.title),
        ["Save", "Fix", "Reject"]
      );
      const id = ctx.proposals.listByShop(shop)[0].id;
      assert.deepEqual(
        card.action.buttons.map((b) => b.reply.id),
        [`confirm:${id}`, `fix:${id}`, `reject:${id}`]
      );
      assert.equal(ctx.ledger.list(shop).length, 1);
      assert.equal(JSON.parse(ctx.proposals.listByShop(shop)[0].entries_json).correctionOf, sale.id);
    } finally {
      await teardown(ctx);
    }
  });

  it("bare fix last explains the usage and proposes nothing", async () => {
    const ctx = setup(async () => WA_FIX);
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fix last")]));
      assert.equal(sends(ctx).length, 1);
      assert.match(sends(ctx)[0].body.text.body, /fix last followed by/);
      assert.equal(proposalCount(ctx), 0);
    } finally {
      await teardown(ctx);
    }
  });

  it("fix last with no entries answers plainly", async () => {
    const ctx = setup(async () => WA_FIX);
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fix last Ada paid 1k")]));
      assert.match(sends(ctx)[0].body.text.body, /no entries yet/);
      assert.equal(proposalCount(ctx), 0);
    } finally {
      await teardown(ctx);
    }
  });

  it("a two-entry reading is refused one at a time", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      ctx.ledger.append({ shopId: shop, type: "sale", amountKobo: 1500000, customer: "Ada" });
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fix last Ada buy rice 2 bags, na 15k. She pay 10k")]));
      assert.match(sends(ctx)[0].body.text.body, /one entry at a time/);
      assert.equal(proposalCount(ctx), 0);
    } finally {
      await teardown(ctx);
    }
  });

  it("Save records the correction once; balance shows the corrected values", async () => {
    const ctx = setup(async () => WA_FIX);
    try {
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      const sale = ctx.ledger.append({ shopId: shop, type: "sale", amountKobo: 1500000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" });
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fix last Ada buy rice, na 12k")]));
      const id = ctx.proposals.listByShop(shop)[0].id;
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `confirm:${id}`)]));
      const rows = ctx.ledger.list(shop);
      assert.equal(rows.length, 2);
      const created = rows.find((r) => r.type === "correction");
      assert.equal(created.corrects_id, sale.id);
      assert.deepEqual([created.amount_kobo, created.item, created.quantity, created.unit], [1200000, "rice", 2, "bag"]);
      assert.match(sends(ctx).at(-1).body.text.body, /✅ \*Saved\*/);

      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `confirm:${id}`)]));
      assert.equal(ctx.ledger.list(shop).length, 2);
      assert.match(sends(ctx).at(-1).body.text.body, /Already saved/);

      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "balance Ada")]));
      assert.match(sends(ctx).at(-1).body.text.body, /owes \*₦12,000\*/);
      assert.equal(ctx.ledger.verify(shop).ok, true);
    } finally {
      await teardown(ctx);
    }
  });
});

describe("dashboard login command", () => {
  it("parses dashboard exactly, case-insensitive, punctuation ignored", () => {
    assert.deepEqual(parseCommand("dashboard"), { name: "dashboard" });
    assert.deepEqual(parseCommand("  DASHBOARD! "), { name: "dashboard" });
    assert.equal(parseCommand("dashboards"), null);
    assert.equal(parseCommand("my dashboard"), null);
  });

  it("dashboard replies with a code that logs this sender's shop in, model untouched", async () => {
    const calls = [];
    const ctx = setup(async (req) => {
      calls.push(req);
      return WA_PART;
    });
    try {
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      assert.equal((await postWebhook(ctx, wrap([waText(FROM_A, mid(), "dashboard")]))).status, 200);
      assert.equal(calls.length, 0);
      const sent = sends(ctx);
      assert.equal(sent.length, 1);
      const body = sent[0].body.text.body;
      const code = /Your PocketOga code is \*(\d{6})\*/.exec(body)?.[1];
      assert.ok(code, `no code in reply: ${body}`);
      assert.match(body, /expires in 10 minutes/);
      const out = ctx.auths.exchangeCode(shop, code, {});
      assert.equal(out.ok, true);
      assert.equal(ctx.auths.verifyToken(out.token, {}).shopId, shop);
    } finally {
      await teardown(ctx);
    }
  });

  it("the sixth dashboard in an hour is limited, and strangers get no code", async () => {
    const ctx = setup(async () => WA_PART);
    try {
      for (let i = 0; i < 5; i++) {
        await postWebhook(ctx, wrap([waText(FROM_A, mid(), "dashboard")]));
      }
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "dashboard")]));
      assert.match(sends(ctx).at(-1).body.text.body, /Too many codes/);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS c FROM login_codes").get().c, 5);

      await postWebhook(ctx, wrap([waText(STRANGER, mid(), "dashboard")]));
      assert.ok(!/\d{6}/.test(sends(ctx).at(-1).body.text.body));
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS c FROM login_codes").get().c, 5);
    } finally {
      await teardown(ctx);
    }
  });
});

describe("photo alerts", () => {
  const PHOTO_NOW = Date.UTC(2026, 9, 28, 12, 0, 0); // Wed 28 Oct 2026 13:00 Lagos
  const waAlert = (over = {}) => ({
    photoType: "payment_alert",
    status: "successful",
    date: "2026-10-28",
    amountNaira: 12000,
    amountPhrase: "12k",
    sender: "Ada",
    reference: "WA-1",
    ...over,
  });
  const checksOf = (ctx) => new PhotoCheckStore(ctx.db);

  it("a photo gets a result card with Save, Fix and Reject", async () => {
    const ctx = setup(async () => waAlert(), { nowMs: PHOTO_NOW });
    try {
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      ctx.ledger.append({ shopId: shop, type: "sale", amountKobo: 1200000, customer: "Ada" });
      assert.equal((await postWebhook(ctx, wrap([waImage(FROM_A, mid())]))).status, 200);
      const sent = sends(ctx);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].body.type, "interactive");
      const card = sent[0].body.interactive;
      assert.match(card.body.text, /Payment alert/);
      assert.match(card.body.text, /no warning signs found/);
      assert.match(card.body.text, /₦12,000/);
      assert.deepEqual(
        card.action.buttons.map((b) => b.reply.title),
        ["Save", "Fix", "Reject"]
      );
      assert.equal(ctx.ledger.list(shop).length, 1);
      const stored = ctx.proposals.listByShop(shop)[0];
      assert.equal(JSON.parse(stored.entries_json).photoCheck.photoType, "payment_alert");
    } finally {
      await teardown(ctx);
    }
  });

  it("a warned alert still offers Save", async () => {
    const ctx = setup(async () => waAlert({ amountNaira: 9999, amountPhrase: "9,999", reference: "WA-2" }), { nowMs: PHOTO_NOW });
    try {
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      ctx.ledger.append({ shopId: shop, type: "sale", amountKobo: 1200000, customer: "Ada" });
      await postWebhook(ctx, wrap([waImage(FROM_A, mid())]));
      const card = sends(ctx)[0].body.interactive;
      assert.match(card.body.text, /warning signs found/);
      assert.equal(card.action.buttons.length, 3);
      assert.ok(card.action.buttons.some((b) => b.reply.title === "Save"));
    } finally {
      await teardown(ctx);
    }
  });

  it("Save stores the check unconfirmed with a bank button; the bank tap confirms it", async () => {
    const ctx = setup(async () => waAlert(), { nowMs: PHOTO_NOW });
    try {
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      ctx.ledger.append({ shopId: shop, type: "sale", amountKobo: 1200000, customer: "Ada" });
      await postWebhook(ctx, wrap([waImage(FROM_A, mid())]));
      const id = ctx.proposals.listByShop(shop)[0].id;
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `confirm:${id}`)]));
      const saved = sends(ctx).at(-1).body;
      assert.equal(saved.type, "interactive");
      assert.match(saved.interactive.body.text, /Saved/);
      assert.match(saved.interactive.body.text, /unconfirmed/);
      assert.deepEqual(saved.interactive.action.buttons.map((b) => b.reply.id), [`bank:${id}`]);
      assert.deepEqual(saved.interactive.action.buttons.map((b) => b.reply.title), ["I saw it in my bank"]);
      for (const b of saved.interactive.action.buttons) assert.ok(b.reply.title.length < 20);
      assert.equal(ctx.ledger.list(shop).length, 1);
      assert.equal(checksOf(ctx).listByShop(shop)[0].check_status, "unconfirmed");

      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `bank:${id}`)]));
      assert.match(sends(ctx).at(-1).body.text.body, /marked as seen in your bank/);
      assert.equal(checksOf(ctx).listByShop(shop)[0].check_status, "confirmed");

      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `bank:${id}`)]));
      assert.match(sends(ctx).at(-1).body.text.body, /Already marked/);
    } finally {
      await teardown(ctx);
    }
  });

  it("bank taps with nothing to mark are refused", async () => {
    const ctx = setup(async () => WA_PART, { nowMs: PHOTO_NOW });
    try {
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "fake note")]));
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      const id = ctx.proposals.listByShop(shop)[0].id;
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `bank:${id}`)]));
      assert.match(sends(ctx).at(-1).body.text.body, /no transfer to mark/);
    } finally {
      await teardown(ctx);
    }
  });

  it("bank before Save is refused", async () => {
    const ctx = setup(async () => waAlert(), { nowMs: PHOTO_NOW });
    try {
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      ctx.ledger.append({ shopId: shop, type: "sale", amountKobo: 1200000, customer: "Ada" });
      await postWebhook(ctx, wrap([waImage(FROM_A, mid())]));
      const id = ctx.proposals.listByShop(shop)[0].id;
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `bank:${id}`)]));
      assert.match(sends(ctx).at(-1).body.text.body, /no transfer to mark/);
      assert.equal(checksOf(ctx).listByShop(shop).length, 0);
    } finally {
      await teardown(ctx);
    }
  });

  it("Fix on a photo card asks for the photo again and sets no fix state", async () => {
    const ctx = setup(async () => waAlert(), { nowMs: PHOTO_NOW });
    try {
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      ctx.ledger.append({ shopId: shop, type: "sale", amountKobo: 1200000, customer: "Ada" });
      await postWebhook(ctx, wrap([waImage(FROM_A, mid())]));
      const id = ctx.proposals.listByShop(shop)[0].id;
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `fix:${id}`)]));
      assert.match(sends(ctx).at(-1).body.text.body, /send it again/);
      assert.equal(ctx.whatsapp.getFixState(FROM_A), null);
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "another fake note")]));
      assert.equal(ctx.proposals.listByShop(shop).length, 2);
    } finally {
      await teardown(ctx);
    }
  });

  it("a failed download gets the photo-failed reply", async () => {
    const ctx = setup(async () => waAlert(), { nowMs: PHOTO_NOW });
    try {
      const realFetch = ctx.fetch;
      ctx.deps.fetch = async (url, opts) => (url.endsWith("/messages") ? realFetch(url, opts) : { ok: false, status: 500, text: async () => "nope" });
      await postWebhook(ctx, wrap([waImage(FROM_A, mid())]));
      assert.match(sends(ctx)[0].body.text.body, /couldn't read that photo/);
      assert.equal(proposalCount(ctx), 0);
    } finally {
      await teardown(ctx);
    }
  });

  it("a gif photo is refused without calling the model", async () => {
    let calls = 0;
    const ctx = setup(async () => {
      calls++;
      return waAlert();
    }, { nowMs: PHOTO_NOW });
    try {
      await postWebhook(ctx, wrap([waImage(FROM_A, mid(), "media-9", "image/gif")]));
      assert.match(sends(ctx)[0].body.text.body, /couldn't read that photo/);
      assert.equal(calls, 0);
      assert.equal(proposalCount(ctx), 0);
    } finally {
      await teardown(ctx);
    }
  });

  it("an unknown photo gets a check card without Save", async () => {
    const ctx = setup(async () => ({ photoType: "unknown" }), { nowMs: PHOTO_NOW });
    try {
      await postWebhook(ctx, wrap([waImage(FROM_A, mid())]));
      const card = sends(ctx)[0].body.interactive;
      assert.match(card.body.text, /don't recognise this photo/);
      assert.deepEqual(
        card.action.buttons.map((b) => b.reply.title),
        ["Fix", "Reject"]
      );
    } finally {
      await teardown(ctx);
    }
  });

  it("the report command lists the unconfirmed transfer", async () => {
    const ctx = setup(async () => waAlert(), { nowMs: PHOTO_NOW });
    try {
      const shop = ctx.whatsapp.getOrCreateShop(FROM_A);
      ctx.ledger.append({ shopId: shop, type: "sale", amountKobo: 1200000, customer: "Ada" });
      await postWebhook(ctx, wrap([waImage(FROM_A, mid())]));
      const id = ctx.proposals.listByShop(shop)[0].id;
      await postWebhook(ctx, wrap([waButton(FROM_A, mid(), `confirm:${id}`)]));
      await postWebhook(ctx, wrap([waText(FROM_A, mid(), "report")]));
      assert.match(sends(ctx).at(-1).body.text.body, /1 unconfirmed transfer \(/);
      assert.match(sends(ctx).at(-1).body.text.body, /₦12,000/);
    } finally {
      await teardown(ctx);
    }
  });
});
