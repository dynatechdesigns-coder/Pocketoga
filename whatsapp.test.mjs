import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { WhatsAppStore, drainWhatsAppJobs } from "./whatsapp.mjs";
import { createMockModelClient } from "./model.mjs";
import { handleVoiceRequest, handleWebhookOnlyRequest, createWebhookServer } from "./server.mjs";

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
  const whatsapp = new WhatsAppStore(db);
  const model = createMockModelClient(modelHandler);
  const fetch = makeFetch();
  const logs = [];
  const execFile = makeExecFile(opts.execImpl ?? writeFakeWav);
  mkdirSync(TMP_BASE, { recursive: true });
  const deps = {
    ledger,
    proposals,
    model,
    whatsapp,
    fetch,
    log: (line) => logs.push(String(line)),
    execFile,
    waTmpDir: TMP_BASE,
    env: ENV,
  };
  return { db, ledger, proposals, model, whatsapp, fetch, logs, execFile, deps };
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

async function dispatch(deps, { method, url, headers = {}, rawBody }) {
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
      assert.match(sends(ctx)[0].body.interactive.body.text, /do not add up/);
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
      assert.match(reply.text.body, /Saved:/);
      assert.match(reply.text.body, /₦15,000/);
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
      assert.match(sends(ctx).at(-1).body.text.body, /Discarded/);
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
      assert.match(reply.text.body, /Saved:/);
      assert.match(reply.text.body, /₦15,000/);
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
      assert.match(sends(ctx).at(-1).body.text.body, /can only read text and voice notes/);
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
      // The model got wav audio and the trader got a card.
      assert.equal(seen.length, 1);
      assert.equal(seen[0].audio.format, "wav");
      assert.equal(sends(ctx).length, 1);
      assert.equal(sends(ctx)[0].body.type, "interactive");
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
