import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync, unlinkSync } from "node:fs";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { createMockModelClient } from "./model.mjs";
import { propose, confirmProposal, fixProposal, rejectProposal, getProposal } from "./voice.mjs";
import { createVoiceServer, handleVoiceRequest } from "./server.mjs";

// Fake fixtures only. No real customers, items, or amounts.
const SHOP_A = "shop-a";
const SHOP_B = "shop-b";

const PART_PAYMENT = {
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

const MISMATCH = {
  heard: "Ada buy rice 2 bags, na 15k. She pay 10k, remain 4k.",
  entries: [
    { type: "sale", customer: "Test Customer Ada", item: "fake-rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" },
    { type: "payment", customer: "Test Customer Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
  ],
  totals: {
    totalNaira: 15000,
    totalPhrase: "15k",
    paidNaira: 10000,
    paidPhrase: "10k",
    remainderNaira: 4000,
    remainderPhrase: "remain 4k",
  },
  question: null,
};

const EACH_PART_PAYMENT = {
  heard: "2 bags, 15k each, she pay 10k.",
  entries: [
    { type: "sale", customer: "Test Customer Ada", item: "fake-rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "each" },
    { type: "payment", customer: "Test Customer Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
  ],
  totals: {
    totalNaira: 30000,
    totalPhrase: null,
    paidNaira: 10000,
    paidPhrase: "10k",
    remainderNaira: 20000,
    remainderPhrase: null,
  },
  question: null,
};

function setup(handler) {
  const ledger = new Ledger(":memory:");
  const proposals = new ProposalStore(":memory:");
  const model = createMockModelClient(handler);
  return { ledger, proposals, model, deps: { ledger, proposals, model } };
}

function teardown({ ledger, proposals }) {
  ledger.close();
  proposals.close();
}

describe("voice loop (mock model, no API calls)", () => {
  it("records a sale with part payment only after confirm", async () => {
    const ctx = setup(async () => PART_PAYMENT);
    try {
      const p = await propose(SHOP_A, "Ada buy rice 2 bags, na 15k. She pay 10k, remain 5k.", ctx.deps);
      assert.equal(p.status, "pending");
      assert.deepEqual(p.flags, []);
      assert.equal(p.entries.length, 2);
      assert.deepEqual(ctx.ledger.list(SHOP_A), []); // nothing saved before confirm

      const out = confirmProposal(p.id, SHOP_A, ctx.deps);
      assert.equal(out.alreadyConfirmed, false);
      assert.equal(out.recordedIds.length, 2);

      const rows = ctx.ledger.list(SHOP_A);
      assert.equal(rows[0].type, "sale");
      assert.equal(rows[0].amount_kobo, 1500000);
      assert.equal(rows[0].customer, "Test Customer Ada");
      assert.equal(rows[0].item, "fake-rice");
      assert.equal(rows[0].quantity, 2);
      assert.equal(rows[0].unit, "bag");
      assert.equal(rows[1].type, "payment");
      assert.equal(rows[1].amount_kobo, 1000000);
      assert.equal(ctx.ledger.verify(SHOP_A).ok, true);
    } finally {
      teardown(ctx);
    }
  });

  it("confirming twice records once", async () => {
    const ctx = setup(async () => PART_PAYMENT);
    try {
      const p = await propose(SHOP_A, "fake note", ctx.deps);
      const first = confirmProposal(p.id, SHOP_A, ctx.deps);
      assert.equal(first.alreadyConfirmed, false);
      const second = confirmProposal(p.id, SHOP_A, ctx.deps);
      assert.equal(second.alreadyConfirmed, true);
      assert.deepEqual(second.recordedIds, first.recordedIds);
      assert.equal(ctx.ledger.list(SHOP_A).length, 2);
    } finally {
      teardown(ctx);
    }
  });

  it("flags numbers that do not add up, then confirms after fix", async () => {
    const ctx = setup(async (req) => (req.prior ? PART_PAYMENT : MISMATCH));
    try {
      const p = await propose(SHOP_A, "fake note", ctx.deps);
      assert.equal(p.status, "pending");
      assert.match(p.flags.join(";"), /do not add up/);
      assert.ok(p.question);
      assert.throws(() => confirmProposal(p.id, SHOP_A, ctx.deps), /cannot confirm/);
      assert.deepEqual(ctx.ledger.list(SHOP_A), []);

      const fixed = await fixProposal(p.id, SHOP_A, "remainder na 5k", ctx.deps);
      assert.equal(fixed.status, "pending");
      assert.deepEqual(fixed.flags, []);
      const out = confirmProposal(fixed.id, SHOP_A, ctx.deps);
      assert.equal(out.recordedIds.length, 2);
    } finally {
      teardown(ctx);
    }
  });

  it("flags model amounts that disagree with the original phrase", async () => {
    const ctx = setup(async () => ({
      heard: "fake",
      entries: [
        { type: "sale", customer: "Test Customer Ada", item: null, quantity: null, amountNaira: 15000, amountPhrase: "10k", priceBasis: "total" },
      ],
      totals: null,
      question: null,
    }));
    try {
      const p = await propose(SHOP_A, "fake note", ctx.deps);
      assert.match(p.flags.join(";"), /but "10k" means/);
      assert.throws(() => confirmProposal(p.id, SHOP_A, ctx.deps), /cannot confirm/);
    } finally {
      teardown(ctx);
    }
  });

  it("asks instead of guessing when details are missing", async () => {
    const ctx = setup(async () => ({
      heard: "fake",
      entries: [{ type: "sale", customer: null, item: null, quantity: null, amountNaira: 5000, amountPhrase: "5k", priceBasis: "total" }],
      totals: null,
      question: null,
    }));
    try {
      const p = await propose(SHOP_A, "fake note", ctx.deps);
      assert.match(p.flags.join(";"), /missing customer/);
      assert.ok(p.question);
      assert.throws(() => confirmProposal(p.id, SHOP_A, ctx.deps), /cannot confirm/);
    } finally {
      teardown(ctx);
    }
  });

  it("rejects bad quantities and amounts from the model", async () => {
    const cases = [
      [{ type: "sale", customer: "Test Customer Ada", item: "fake-rice", quantity: 0, amountNaira: 5000, amountPhrase: "5k", priceBasis: "total" }, /quantity/],
      [{ type: "sale", customer: "Test Customer Ada", item: null, quantity: null, amountNaira: 15.5, amountPhrase: "15k", priceBasis: "total" }, /whole naira/],
      [{ type: "sale", customer: "Test Customer Ada", item: null, quantity: null, amountNaira: -5, amountPhrase: "5k", priceBasis: "total" }, /negative/],
      [{ type: "debt", customer: "Test Customer Ada", item: null, quantity: null, amountNaira: 5, amountPhrase: "5", priceBasis: "total" }, /unknown type/],
    ];
    for (const [entry, want] of cases) {
      const one = setup(async () => ({ heard: "fake", entries: [entry], totals: null, question: null }));
      try {
        const p = await propose(SHOP_A, "fake note", one.deps);
        assert.match(p.flags.join(";"), want, JSON.stringify(entry));
      } finally {
        teardown(one);
      }
    }
  });

  it("multiplies each-prices by quantity: 2 bags at 15k each is 30k", async () => {
    const ctx = setup(async () => EACH_PART_PAYMENT);
    try {
      const p = await propose(SHOP_A, "fake note", ctx.deps);
      assert.deepEqual(p.flags, []);
      assert.equal(p.entries[0].priceBasis, "each");
      assert.equal(p.entries[0].amountNaira, 30000);
      assert.equal(p.entries[0].amountKobo, 3000000);
      assert.equal(p.entries[0].eachNaira, 15000);
      assert.equal(p.entries[0].eachKobo, 1500000);
      assert.equal(p.entries[0].item, "fake-rice");
      assert.equal(p.entries[0].unit, "bag");
      assert.equal(p.totals.remainderNaira, 20000); // 20,000 owed

      const out = confirmProposal(p.id, SHOP_A, ctx.deps);
      assert.equal(out.recordedIds.length, 2);
      const rows = ctx.ledger.list(SHOP_A);
      assert.equal(rows[0].amount_kobo, 3000000);
      assert.equal(rows[0].unit, "bag");
      assert.equal(rows[1].amount_kobo, 1000000);
      assert.equal(ctx.ledger.verify(SHOP_A).ok, true);
    } finally {
      teardown(ctx);
    }
  });

  it("each-price with number words: 2 crates at 8 thousand 5 hundred each is 17k", async () => {
    const ctx = setup(async () => ({
      heard: "2 crates egg, 8 thousand 5 hundred each.",
      entries: [
        { type: "sale", customer: "Test Customer Bola", item: "fake-egg", unit: "crate", quantity: 2, amountNaira: 8500, amountPhrase: "8 thousand 5 hundred", priceBasis: "each" },
      ],
      totals: null,
      question: null,
    }));
    try {
      const p = await propose(SHOP_A, "fake note", ctx.deps);
      assert.deepEqual(p.flags, []);
      assert.equal(p.entries[0].amountNaira, 17000);
      assert.equal(p.entries[0].amountKobo, 1700000);
      const out = confirmProposal(p.id, SHOP_A, ctx.deps);
      assert.equal(ctx.ledger.list(SHOP_A)[0].amount_kobo, 1700000);
      assert.equal(out.recordedIds.length, 1);
    } finally {
      teardown(ctx);
    }
  });

  it("flags a total-basis reading when the note says each", async () => {
    const ctx = setup(async () => ({
      heard: "2 bags rice, 15k each.",
      entries: [
        { type: "sale", customer: "Test Customer Ada", item: "fake-rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" },
      ],
      totals: null,
      question: null,
    }));
    try {
      const p = await propose(SHOP_A, "fake note", ctx.deps);
      assert.match(p.flags.join(";"), /read as a total/);
      assert.ok(p.question);
      assert.throws(() => confirmProposal(p.id, SHOP_A, ctx.deps), /cannot confirm/);
      assert.deepEqual(ctx.ledger.list(SHOP_A), []);
    } finally {
      teardown(ctx);
    }
  });

  it("asks instead of guessing when the basis is unclear for many items", async () => {
    const many = setup(async () => ({
      heard: "2 bags rice, 15k.",
      entries: [
        { type: "sale", customer: "Test Customer Ada", item: "fake-rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "unclear" },
      ],
      totals: null,
      question: null,
    }));
    try {
      const p = await propose(SHOP_A, "fake note", many.deps);
      assert.match(p.flags.join(";"), /each one or for all 2/);
      assert.ok(p.question);
      assert.throws(() => confirmProposal(p.id, SHOP_A, many.deps), /cannot confirm/);
    } finally {
      teardown(many);
    }
    // One item: each and total are the same, so unclear needs no question.
    const one = setup(async () => ({
      heard: "1 bag rice, 15k.",
      entries: [
        { type: "sale", customer: "Test Customer Ada", item: "fake-rice", unit: "bag", quantity: 1, amountNaira: 15000, amountPhrase: "15k", priceBasis: "unclear" },
      ],
      totals: null,
      question: null,
    }));
    try {
      const p = await propose(SHOP_A, "fake note", one.deps);
      assert.deepEqual(p.flags, []);
      assert.equal(confirmProposal(p.id, SHOP_A, one.deps).recordedIds.length, 1);
    } finally {
      teardown(one);
    }
  });

  it("payments store no item, quantity or unit", async () => {
    const ctx = setup(async () => ({
      heard: "fake",
      entries: [
        { type: "sale", customer: "Test Customer Ada", item: null, quantity: null, amountNaira: 5000, amountPhrase: "5k", priceBasis: "total" },
        { type: "payment", customer: "Test Customer Ada", item: "fake-garri", unit: "bag", quantity: 1, amountNaira: 5000, amountPhrase: "5k", priceBasis: "total" },
      ],
      totals: null,
      question: null,
    }));
    try {
      const p = await propose(SHOP_A, "fake note", ctx.deps);
      assert.deepEqual(p.flags, []);
      assert.match(p.notes.join(";"), /not stored/);
      assert.equal(p.entries[1].item, null);
      assert.equal(p.entries[1].quantity, null);
      assert.equal(p.entries[1].unit, null);
      confirmProposal(p.id, SHOP_A, ctx.deps);
      const payment = ctx.ledger.list(SHOP_A)[1];
      assert.equal(payment.item, null);
      assert.equal(payment.quantity, null);
      assert.equal(payment.unit, null);
    } finally {
      teardown(ctx);
    }
  });

  it("garbage model output becomes a flagged proposal, not a crash", async () => {
    const ctx = setup(async () => "not json at all {{{");
    try {
      const p = await propose(SHOP_A, "fake note", ctx.deps);
      assert.equal(p.status, "pending");
      assert.ok(p.flags.length > 0);
      assert.ok(p.question);
      assert.throws(() => confirmProposal(p.id, SHOP_A, ctx.deps), /cannot confirm/);
    } finally {
      teardown(ctx);
    }
  });

  it("restock without a supplier is recorded for the shop", async () => {
    const ctx = setup(async () => ({
      heard: "fake",
      entries: [
        { type: "restock", customer: null, item: "fake-rice", unit: "bag", quantity: 10, amountNaira: 50000, amountPhrase: "50k", priceBasis: "total" },
      ],
      totals: null,
      question: null,
    }));
    try {
      const p = await propose(SHOP_A, "fake note", ctx.deps);
      assert.deepEqual(p.flags, []);
      const out = confirmProposal(p.id, SHOP_A, ctx.deps);
      assert.equal(out.recordedIds.length, 1);
      assert.equal(ctx.ledger.list(SHOP_A)[0].customer, SHOP_A);
      assert.equal(ctx.ledger.list(SHOP_A)[0].unit, "bag");
    } finally {
      teardown(ctx);
    }
  });

  it("cross-shop access is rejected", async () => {
    const ctx = setup(async () => PART_PAYMENT);
    try {
      const p = await propose(SHOP_A, "fake note", ctx.deps);
      assert.throws(() => confirmProposal(p.id, SHOP_B, ctx.deps), /another shop/);
      assert.throws(() => getProposal(p.id, SHOP_B, ctx.deps), /another shop/);
      assert.throws(() => rejectProposal(p.id, SHOP_B, ctx.deps), /another shop/);
      await assert.rejects(fixProposal(p.id, SHOP_B, "x", ctx.deps), /another shop/);
      try {
        confirmProposal(p.id, SHOP_B, ctx.deps);
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.status, 403);
      }
    } finally {
      teardown(ctx);
    }
  });

  it("rejected proposals stay out of the ledger", async () => {
    const ctx = setup(async () => PART_PAYMENT);
    try {
      const p = await propose(SHOP_A, "fake note", ctx.deps);
      const r = rejectProposal(p.id, SHOP_A, ctx.deps);
      assert.equal(r.status, "rejected");
      assert.throws(() => confirmProposal(p.id, SHOP_A, ctx.deps), /rejected/);
      assert.deepEqual(ctx.ledger.list(SHOP_A), []);
    } finally {
      teardown(ctx);
    }
  });

  it("expired proposals cannot confirm", async () => {
    const ctx = setup(async () => PART_PAYMENT);
    try {
      const old = ctx.proposals.create({
        shopId: SHOP_A,
        envelope: {
          version: 1,
          entries: [
            { type: "sale", customer: "Test Customer Ada", item: null, quantity: null, amountNaira: 100, amountKobo: 10000, amountPhrase: "100" },
          ],
          totals: null,
          flags: [],
          notes: [],
        },
        heard: "old note",
        createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      });
      assert.equal(getProposal(old.id, SHOP_A, ctx.deps).status, "expired");
      assert.throws(() => confirmProposal(old.id, SHOP_A, ctx.deps), /expired/);
    } finally {
      teardown(ctx);
    }
  });

  it("audio input reaches the model as base64 wav", async () => {
    // Workspace-local fixture (sandboxed temp dirs may forbid writes).
    const path = `test-audio-${process.pid}.wav`;
    writeFileSync(path, Buffer.from("RIFFfake-wav-bytes"));
    const ctx = setup(async (req) => {
      assert.equal(req.audio.format, "wav");
      assert.equal(Buffer.from(req.audio.data, "base64").toString(), "RIFFfake-wav-bytes");
      return PART_PAYMENT;
    });
    try {
      const p = await propose(SHOP_A, { audioPath: path }, ctx.deps);
      assert.equal(p.status, "pending");
      await assert.rejects(propose(SHOP_A, { audioPath: "note.xyz" }, ctx.deps), /unsupported audio/);
      await assert.rejects(propose(SHOP_A, { audioPath: "missing-file.wav" }, ctx.deps), /cannot read/);
    } finally {
      unlinkSync(path);
      teardown(ctx);
    }
  });

  it("model transport errors propagate and store nothing", async () => {
    const ctx = setup(async () => {
      throw new Error("boom");
    });
    try {
      await assert.rejects(propose(SHOP_A, "fake note", ctx.deps), /boom/);
      assert.deepEqual(ctx.proposals.listByShop(SHOP_A), []);
    } finally {
      teardown(ctx);
    }
  });
});

describe("voice HTTP server", () => {
  // In-process dispatch: exercises routing, methods, status codes and the
  // per-shop check without opening sockets (works sandboxed too).
  // createVoiceServer wires this same handler to real sockets.
  function fakeRequest({ method, url, headers, body, raw }) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = headers;
    req.destroy = () => {};
    process.nextTick(() => {
      if (body !== undefined) req.emit("data", Buffer.from(raw ? body : JSON.stringify(body)));
      req.emit("end");
    });
    return req;
  }

  function fakeResponse() {
    const res = new EventEmitter();
    res.statusCode = null;
    res.headersSent = false;
    res.chunks = "";
    res.writeHead = (status) => {
      res.statusCode = status;
      res.headersSent = true;
    };
    res.end = (chunk) => {
      if (chunk) res.chunks += chunk;
    };
    return res;
  }

  async function dispatch(deps, { method, url, shop, body, raw, headers: extraHeaders }) {
    const headers = { ...extraHeaders };
    if (shop) headers["x-shop-id"] = shop;
    const req = fakeRequest({ method, url, headers, body, raw });
    const res = fakeResponse();
    try {
      await handleVoiceRequest(req, res, deps);
    } catch (err) {
      // Same mapping as createVoiceServer's catch.
      if (!res.headersSent) {
        res.writeHead(err.status ?? 500);
        res.end(JSON.stringify({ error: err.message ?? "internal error" }));
      }
    }
    let json = null;
    try {
      json = JSON.parse(res.chunks);
    } catch {
      // Plain-text bodies, e.g. the webhook verification challenge.
    }
    return { status: res.statusCode, json, text: res.chunks };
  }

  async function withServer(handler, fn) {
    const ctx = setup(handler);
    try {
      await fn(ctx.deps, ctx);
    } finally {
      teardown(ctx);
    }
  }

  async function post(deps, path, shop, body, raw = false, headers) {
    return dispatch(deps, { method: "POST", url: path, shop, body, raw, headers });
  }

  async function get(deps, path, shop, headers) {
    return dispatch(deps, { method: "GET", url: path, shop, headers });
  }

  it("builds an HTTP server around the handler", async () => {
    const ctx = setup(async () => PART_PAYMENT);
    try {
      const server = createVoiceServer(ctx.deps);
      assert.equal(typeof server.listen, "function");
      assert.equal(typeof server.close, "function");
    } finally {
      teardown(ctx);
    }
  });

  it("proposes and confirms over HTTP; second confirm is idempotent", async () => {
    await withServer(async () => PART_PAYMENT, async (base, ctx) => {
      const created = await post(base, "/propose", SHOP_A, { text: "fake note" });
      assert.equal(created.status, 201);
      assert.equal(created.json.proposal.status, "pending");
      assert.deepEqual(ctx.ledger.list(SHOP_A), []);

      const id = created.json.proposal.id;
      const first = await post(base, `/confirm/${id}`, SHOP_A, {});
      assert.equal(first.status, 200);
      assert.equal(first.json.alreadyConfirmed, false);
      assert.equal(first.json.recordedIds.length, 2);

      const second = await post(base, `/confirm/${id}`, SHOP_A, {});
      assert.equal(second.status, 200);
      assert.equal(second.json.alreadyConfirmed, true);
      assert.equal(ctx.ledger.list(SHOP_A).length, 2);
    });
  });

  it("two simultaneous confirms record one set of entries", async () => {
    await withServer(async () => PART_PAYMENT, async (base, ctx) => {
      const created = await post(base, "/propose", SHOP_A, { text: "fake note" });
      const id = created.json.proposal.id;
      const [first, second] = await Promise.all([
        post(base, `/confirm/${id}`, SHOP_A, {}),
        post(base, `/confirm/${id}`, SHOP_A, {}),
      ]);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      const flags = [first.json.alreadyConfirmed, second.json.alreadyConfirmed].sort();
      assert.deepEqual(flags, [false, true]); // exactly one call did the write
      assert.deepEqual(first.json.recordedIds, second.json.recordedIds);
      assert.equal(ctx.ledger.list(SHOP_A).length, 2); // one set, not two
      assert.equal(ctx.ledger.verify(SHOP_A).ok, true);
    });
  });

  it("GET /ledger returns the shop's entries and verification, per shop", async () => {
    await withServer(async () => PART_PAYMENT, async (base) => {
      const a = await post(base, "/propose", SHOP_A, { text: "fake note" });
      await post(base, `/confirm/${a.json.proposal.id}`, SHOP_A, {});
      const b = await post(base, "/propose", SHOP_B, { text: "fake note" });
      await post(base, `/confirm/${b.json.proposal.id}`, SHOP_B, {});

      const mine = await get(base, "/ledger", SHOP_A);
      assert.equal(mine.status, 200);
      assert.equal(mine.json.entries.length, 2);
      assert.ok(mine.json.entries.every((e) => e.shop_id === SHOP_A));
      assert.deepEqual(mine.json.verify, { ok: true, count: 2, shopId: SHOP_A });

      const other = await get(base, "/ledger", SHOP_B);
      assert.equal(other.status, 200);
      assert.equal(other.json.entries.length, 2);
      assert.ok(other.json.entries.every((e) => e.shop_id === SHOP_B));

      assert.equal((await get(base, "/ledger", null)).status, 400);
    });
  });

  it("wrong shop gets 403 and missing shop gets 400", async () => {
    await withServer(async () => PART_PAYMENT, async (base) => {
      const created = await post(base, "/propose", SHOP_A, { text: "fake note" });
      const id = created.json.proposal.id;
      assert.equal((await get(base, `/proposals/${id}`, SHOP_B)).status, 403);
      assert.equal((await post(base, `/confirm/${id}`, SHOP_B, {})).status, 403);
      assert.equal((await post(base, `/fix/${id}`, SHOP_B, { correctionText: "x" })).status, 403);
      assert.equal((await post(base, `/reject/${id}`, SHOP_B, {})).status, 403);
      assert.equal((await get(base, `/proposals/${id}`, null)).status, 400);
      assert.equal((await post(base, "/propose", null, { text: "x" })).status, 400);
      const own = await get(base, `/proposals/${id}`, SHOP_A);
      assert.equal(own.status, 200);
      assert.equal(own.json.proposal.id, id);
    });
  });

  it("fix and reject endpoints work; confirmed proposals are final", async () => {
    await withServer(async (req) => (req.prior ? PART_PAYMENT : MISMATCH), async (base) => {
      const created = await post(base, "/propose", SHOP_A, { text: "fake note" });
      const id = created.json.proposal.id;
      assert.equal((await post(base, `/confirm/${id}`, SHOP_A, {})).status, 400);
      const fixed = await post(base, `/fix/${id}`, SHOP_A, { correctionText: "remainder na 5k" });
      assert.equal(fixed.status, 200);
      assert.deepEqual(fixed.json.proposal.flags, []);
      assert.equal((await post(base, `/confirm/${id}`, SHOP_A, {})).status, 200);
      assert.equal((await post(base, `/reject/${id}`, SHOP_A, {})).status, 409);
      assert.equal((await post(base, `/fix/${id}`, SHOP_A, { correctionText: "x" })).status, 409);

      const second = await post(base, "/propose", SHOP_A, { text: "fake note" });
      const id2 = second.json.proposal.id;
      assert.equal((await post(base, `/reject/${id2}`, SHOP_A, {})).status, 200);
      assert.equal((await post(base, `/confirm/${id2}`, SHOP_A, {})).status, 409);
    });
  });

  it("WEBHOOK_PUBLIC_ONLY hides non-webhook routes from tunnelled requests", async () => {
    await withServer(async () => PART_PAYMENT, async (base, ctx) => {
      base.env = { WEBHOOK_PUBLIC_ONLY: "1", WHATSAPP_VERIFY_TOKEN: "test-verify" };
      const viaCf = { "cf-connecting-ip": "203.0.113.9" };
      const viaFwd = { "x-forwarded-for": "203.0.113.9" };

      assert.equal((await get(base, "/ledger", SHOP_A, viaCf)).status, 404);
      assert.equal((await get(base, "/ledger", SHOP_A, viaFwd)).status, 404);
      assert.equal((await post(base, "/propose", SHOP_A, { text: "fake note" }, false, viaCf)).status, 404);
      assert.equal((await post(base, "/propose", SHOP_A, { text: "fake note" }, false, viaFwd)).status, 404);
      // Processed no further: the blocked propose stored nothing.
      assert.deepEqual(ctx.proposals.listByShop(SHOP_A), []);

      // The webhook itself still answers through the tunnel.
      const hook = await get(
        base,
        "/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=C",
        null,
        viaCf
      );
      assert.equal(hook.status, 200);
      assert.equal(hook.text, "C");
      // POST /webhook reaches signature verification (403), not the guard's 404.
      assert.equal((await post(base, "/webhook", null, {}, false, viaCf)).status, 403);
    });
  });

  it("WEBHOOK_PUBLIC_ONLY changes nothing without tunnel headers", async () => {
    await withServer(async () => PART_PAYMENT, async (base) => {
      base.env = { WEBHOOK_PUBLIC_ONLY: "1" };
      const created = await post(base, "/propose", SHOP_A, { text: "fake note" });
      assert.equal(created.status, 201);
      assert.equal((await get(base, "/ledger", SHOP_A)).status, 200);
    });
  });

  it("unknown routes and bad bodies are 404/400", async () => {
    await withServer(async () => PART_PAYMENT, async (base) => {
      assert.equal((await get(base, "/nope", SHOP_A)).status, 404);
      assert.equal((await post(base, "/propose", SHOP_A, {})).status, 400);
      assert.equal((await post(base, "/propose", SHOP_A, "{", true)).status, 400);
      assert.equal((await get(base, "/proposals/9999", SHOP_A)).status, 404);
    });
  });
});
