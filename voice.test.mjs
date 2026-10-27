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
    { type: "sale", customer: "Test Customer Ada", item: "fake-rice", quantity: 2, amountNaira: 15000, amountPhrase: "15k" },
    { type: "payment", customer: "Test Customer Ada", item: null, quantity: null, amountNaira: 10000, amountPhrase: "10k" },
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
    { type: "sale", customer: "Test Customer Ada", item: "fake-rice", quantity: 2, amountNaira: 15000, amountPhrase: "15k" },
    { type: "payment", customer: "Test Customer Ada", item: null, quantity: null, amountNaira: 10000, amountPhrase: "10k" },
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
        { type: "sale", customer: "Test Customer Ada", item: null, quantity: null, amountNaira: 15000, amountPhrase: "10k" },
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
      entries: [{ type: "sale", customer: null, item: null, quantity: null, amountNaira: 5000, amountPhrase: "5k" }],
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
      [{ type: "sale", customer: "Test Customer Ada", item: "fake-rice", quantity: 0, amountNaira: 5000, amountPhrase: "5k" }, /quantity/],
      [{ type: "sale", customer: "Test Customer Ada", item: null, quantity: null, amountNaira: 15.5, amountPhrase: "15k" }, /whole naira/],
      [{ type: "sale", customer: "Test Customer Ada", item: null, quantity: null, amountNaira: -5, amountPhrase: "5k" }, /negative/],
      [{ type: "debt", customer: "Test Customer Ada", item: null, quantity: null, amountNaira: 5, amountPhrase: "5" }, /unknown type/],
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
        { type: "restock", customer: null, item: "fake-rice", quantity: 10, amountNaira: 50000, amountPhrase: "50k" },
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

  async function dispatch(deps, { method, url, shop, body, raw }) {
    const headers = {};
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
    return { status: res.statusCode, json: JSON.parse(res.chunks) };
  }

  async function withServer(handler, fn) {
    const ctx = setup(handler);
    try {
      await fn(ctx.deps, ctx);
    } finally {
      teardown(ctx);
    }
  }

  async function post(deps, path, shop, body, raw = false) {
    return dispatch(deps, { method: "POST", url: path, shop, body, raw });
  }

  async function get(deps, path, shop) {
    return dispatch(deps, { method: "GET", url: path, shop });
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

  it("unknown routes and bad bodies are 404/400", async () => {
    await withServer(async () => PART_PAYMENT, async (base) => {
      assert.equal((await get(base, "/nope", SHOP_A)).status, 404);
      assert.equal((await post(base, "/propose", SHOP_A, {})).status, 400);
      assert.equal((await post(base, "/propose", SHOP_A, "{", true)).status, 400);
      assert.equal((await get(base, "/proposals/9999", SHOP_A)).status, 404);
    });
  });
});
