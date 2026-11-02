// Unnamed customers, shorthand amounts and explicit debt fields. Fake data
// only; the model is always the mock client.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { PromiseStore } from "./promises.mjs";
import { ProductStore } from "./products.mjs";
import { CustomerStore } from "./customers.mjs";
import { AuthStore, DEMO_SHOP_ID } from "./auth.mjs";
import { createMockModelClient } from "./model.mjs";
import { SecondOpinionStore } from "./secondopinion.mjs";
import {
  propose,
  confirmProposal,
  fixProposal,
  proposeManual,
} from "./voice.mjs";
import { renderProposalCard } from "./messages.mjs";
import { handleVoiceRequest } from "./server.mjs";

const SHOP_A = "shop-a";
const SHOP_B = "shop-b";

function setup(modelHandler = async () => ({ heard: "fake", entries: [], totals: null })) {
  const db = new DatabaseSync(":memory:");
  const ctx = {
    db,
    ledger: new Ledger(db),
    proposals: new ProposalStore(db),
    promises: new PromiseStore(db),
    products: new ProductStore(db),
    customers: new CustomerStore(db),
    auths: new AuthStore(db),
    model: createMockModelClient(modelHandler),
  };
  ctx.deps = {
    db,
    ledger: ctx.ledger,
    proposals: ctx.proposals,
    promises: ctx.promises,
    products: ctx.products,
    customers: ctx.customers,
    auths: ctx.auths,
    model: ctx.model,
  };
  return ctx;
}

function teardown(ctx) {
  ctx.db.close();
}

function fakeReq({ method = "GET", url = "/", headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
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

async function dispatch(deps, opts) {
  const headers = { ...(opts.headers ?? {}) };
  const shop = headers["x-shop-id"];
  if (shop && shop !== DEMO_SHOP_ID && !headers.authorization && !headers.Authorization && deps.auths) {
    headers.authorization = `Bearer ${tokenFor(deps, shop)}`;
  }
  const res = fakeRes();
  try {
    await handleVoiceRequest(fakeReq({ ...opts, headers }), res, deps);
  } catch (err) {
    res.writeHead(err.status ?? 500);
    res.end(JSON.stringify({ error: err.message ?? "internal error" }));
  }
  return { status: res.statusCode, json: JSON.parse(res.text) };
}

const reading = (heard, entries, over = {}) => ({ heard, entries, totals: null, promise: null, question: null, ...over });
const noNameSale = (over = {}) => ({
  type: "sale", customer: null, item: "rice", unit: null, quantity: null,
  amountNaira: 30000, amountPhrase: "30k", priceBasis: "total", ...over,
});

function voiceDeps(ctx) {
  return { proposals: ctx.proposals, model: ctx.model, ledger: ctx.ledger, products: ctx.products };
}

function confirm(ctx, shop, id) {
  return confirmProposal(id, shop, { proposals: ctx.proposals, ledger: ctx.ledger, promises: ctx.promises, products: ctx.products });
}

describe("unnamed customers get automatic labels", () => {
  it("a no-name sale gets Customer 1, the next unnamed one gets Customer 2", async () => {
    const ctx = setup();
    try {
      const p1 = await propose(SHOP_A, "sold rice 30k", { ...voiceDeps(ctx), model: createMockModelClient(async () => reading("sold rice 30k", [noNameSale()])) });
      assert.deepEqual(p1.flags, []);
      assert.equal(p1.question, null);
      assert.equal(p1.entries[0].customer, "Customer 1");
      assert.ok(p1.assumptions.some((a) => a.includes("No name given; saved as Customer 1.")), p1.assumptions.join("; "));
      confirm(ctx, SHOP_A, p1.id);
      assert.equal(ctx.ledger.list(SHOP_A)[0].customer, "Customer 1");

      const p2 = await propose(SHOP_A, "sold beans 20k", { ...voiceDeps(ctx), model: createMockModelClient(async () => reading("sold beans 20k", [noNameSale({ item: "beans", amountNaira: 20000, amountPhrase: "20k" })])) });
      assert.equal(p2.entries[0].customer, "Customer 2");
      confirm(ctx, SHOP_A, p2.id);
      assert.deepEqual(ctx.ledger.list(SHOP_A).map((r) => r.customer), ["Customer 1", "Customer 2"]);
    } finally {
      teardown(ctx);
    }
  });

  it("a named sale does not use up a number", async () => {
    const ctx = setup();
    try {
      const mk = (r) => createMockModelClient(async () => r);
      const p1 = await propose(SHOP_A, "sold rice 30k", { ...voiceDeps(ctx), model: mk(reading("sold rice 30k", [noNameSale()])) });
      assert.equal(p1.entries[0].customer, "Customer 1");
      confirm(ctx, SHOP_A, p1.id);
      const named = await propose(SHOP_A, "Ada bought rice 30k", { ...voiceDeps(ctx), model: mk(reading("Ada bought rice 30k", [noNameSale({ customer: "Ada" })])) });
      assert.equal(named.entries[0].customer, "Ada");
      confirm(ctx, SHOP_A, named.id);
      const p2 = await propose(SHOP_A, "sold beans 20k", { ...voiceDeps(ctx), model: mk(reading("sold beans 20k", [noNameSale({ item: "beans", amountNaira: 20000, amountPhrase: "20k" })])) });
      assert.equal(p2.entries[0].customer, "Customer 2");
    } finally {
      teardown(ctx);
    }
  });

  it("two shops have separate counters", async () => {
    const ctx = setup();
    try {
      const mk = (r) => createMockModelClient(async () => r);
      const a1 = await propose(SHOP_A, "sold rice 30k", { ...voiceDeps(ctx), model: mk(reading("sold rice 30k", [noNameSale()])) });
      assert.equal(a1.entries[0].customer, "Customer 1");
      confirm(ctx, SHOP_A, a1.id);
      const b1 = await propose(SHOP_B, "sold rice 30k", { ...voiceDeps(ctx), model: mk(reading("sold rice 30k", [noNameSale()])) });
      assert.equal(b1.entries[0].customer, "Customer 1");
      confirm(ctx, SHOP_B, b1.id);
      const a2 = await propose(SHOP_A, "sold beans 20k", { ...voiceDeps(ctx), model: mk(reading("sold beans 20k", [noNameSale({ item: "beans", amountNaira: 20000, amountPhrase: "20k" })])) });
      assert.equal(a2.entries[0].customer, "Customer 2");
    } finally {
      teardown(ctx);
    }
  });

  it("a spoken description of the customer is ignored, never stored", async () => {
    const ctx = setup();
    try {
      const p = await propose(SHOP_A, "the woman in blue bought rice 30k", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("the woman in blue bought rice 30k", [noNameSale({ customer: "the woman in blue" })])),
      });
      assert.deepEqual(p.flags, []);
      assert.equal(p.question, null);
      assert.equal(p.entries[0].customer, "Customer 1");
      confirm(ctx, SHOP_A, p.id);
      const rows = ctx.ledger.list(SHOP_A);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].customer, "Customer 1");
      assert.ok(!JSON.stringify(rows).toLowerCase().includes("woman in blue"));
    } finally {
      teardown(ctx);
    }
  });

  it("WhatsApp never asks for a name: no question, Save enabled, no Who-line", async () => {
    const ctx = setup();
    try {
      const p = await propose(SHOP_A, "sold rice 30k", { ...voiceDeps(ctx), model: createMockModelClient(async () => reading("sold rice 30k", [noNameSale()])) });
      assert.equal(p.question, null);
      const card = renderProposalCard(p, { existing: ctx.ledger.list(SHOP_A), shopId: SHOP_A, products: [] });
      assert.ok(!/Who .*?\?/.test(card.text), card.text);
      assert.ok(!/customer is required/i.test(card.text), card.text);
      assert.ok(/Customer 1/.test(card.text), card.text);
      assert.deepEqual(card.buttons.map((b) => b.reply.title), ["Save", "Fix", "Reject"]);
    } finally {
      teardown(ctx);
    }
  });

  it("POST /proposals/manual accepts a missing name for sales, payments and part-paid sales", async () => {
    const ctx = setup();
    try {
      const full = await dispatch(ctx.deps, { method: "POST", url: "/proposals/manual", headers: { "x-shop-id": SHOP_A }, body: { kind: "sale", item: "rice", amount_naira: 30000 } });
      assert.equal(full.status, 201, JSON.stringify(full.json));
      assert.equal(full.json.proposal.entries[0].customer, "Customer 1");

      const pay = await dispatch(ctx.deps, { method: "POST", url: "/proposals/manual", headers: { "x-shop-id": SHOP_A }, body: { kind: "payment", amount_naira: 10000 } });
      assert.equal(pay.status, 201, JSON.stringify(pay.json));
      assert.equal(pay.json.proposal.entries[0].customer, "Customer 2");

      const part = await dispatch(ctx.deps, {
        method: "POST", url: "/proposals/manual", headers: { "x-shop-id": SHOP_A },
        body: { kind: "sale", item: "rice", amount_naira: 45000, paid_naira: 25000 },
      });
      assert.equal(part.status, 201, JSON.stringify(part.json));
      assert.equal(part.json.proposal.entries[0].customer, "Customer 3");
      assert.equal(part.json.proposal.entries[1].customer, "Customer 3");
      assert.deepEqual(part.json.proposal.partPaid, { customer: "Customer 3", totalKobo: 4500000, paidKobo: 2500000, owedKobo: 2000000 });
    } finally {
      teardown(ctx);
    }
  });

  it("POST /customers accepts a missing name with the next Customer N label", async () => {
    const ctx = setup();
    try {
      const first = await dispatch(ctx.deps, { method: "POST", url: "/customers", headers: { "x-shop-id": SHOP_A }, body: {} });
      assert.equal(first.status, 200);
      assert.equal(first.json.customer.name, "Customer 1");
      const second = await dispatch(ctx.deps, { method: "POST", url: "/customers", headers: { "x-shop-id": SHOP_A }, body: {} });
      assert.equal(second.json.customer.name, "Customer 2");
      const named = await dispatch(ctx.deps, { method: "POST", url: "/customers", headers: { "x-shop-id": SHOP_A }, body: { name: "Ada" } });
      assert.equal(named.json.customer.name, "Ada");
      const third = await dispatch(ctx.deps, { method: "POST", url: "/customers", headers: { "x-shop-id": SHOP_A }, body: { name: null } });
      assert.equal(third.json.customer.name, "Customer 3");
    } finally {
      teardown(ctx);
    }
  });

  it("POST /customers/rename corrects the label and is limited to the owner shop", async () => {
    const ctx = setup();
    try {
      const mk = (r) => createMockModelClient(async () => r);
      const p = await propose(SHOP_A, "sold rice 30k", { ...voiceDeps(ctx), model: mk(reading("sold rice 30k", [noNameSale()])) });
      const recorded = confirm(ctx, SHOP_A, p.id);
      const originalId = recorded.recordedIds[0];

      const renamed = await dispatch(ctx.deps, { method: "POST", url: "/customers/rename", headers: { "x-shop-id": SHOP_A }, body: { from: "Customer 1", to: "Ada" } });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
      assert.equal(renamed.json.renamed, 1);
      const rows = ctx.ledger.list(SHOP_A);
      // Append-only: the original row keeps its label; a correction row
      // carries the new name and points at the original.
      assert.ok(rows.some((r) => r.id === originalId && r.customer === "Customer 1"));
      assert.ok(rows.some((r) => r.type === "correction" && r.customer === "Ada" && r.corrects_id === originalId),
        JSON.stringify(rows.map((r) => [r.type, r.customer, r.corrects_id])));
      assert.equal(ctx.ledger.verify(SHOP_A).ok, true);

      const foreign = await dispatch(ctx.deps, { method: "POST", url: "/customers/rename", headers: { "x-shop-id": SHOP_B }, body: { from: "Customer 1", to: "Ada" } });
      assert.equal(foreign.status, 404);
      assert.equal(ctx.ledger.list(SHOP_B).length, 0);

      const missing = await dispatch(ctx.deps, { method: "POST", url: "/customers/rename", headers: { "x-shop-id": SHOP_A }, body: { from: "Nobody", to: "Ada" } });
      assert.equal(missing.status, 404);
    } finally {
      teardown(ctx);
    }
  });
});

describe("shorthand amounts", () => {
  it("63 gives a two-amount check proposal and saves nothing", async () => {
    const ctx = setup();
    try {
      const p = await propose(SHOP_A, "sold rice 63", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("sold rice 63", [{ type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 63, amountPhrase: "63", priceBasis: "total" }])),
      });
      assert.deepEqual(p.entries[0].amountOptions, [6300, 630000]);
      assert.ok(p.flags.length > 0);
      assert.match(p.question, /Reply 1 for .*₦63.*2 for .*₦6,300/);
      assert.throws(() => confirm(ctx, SHOP_A, p.id), /cannot confirm/);
      assert.equal(ctx.ledger.list(SHOP_A).length, 0);
    } finally {
      teardown(ctx);
    }
  });

  it("choosing 1 or 2 saves the right kobo", async () => {
    const ctx = setup();
    try {
      const shorthand = [{ type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 63, amountPhrase: "63", priceBasis: "total" }];
      const p1 = await propose(SHOP_A, "sold rice 63", { ...voiceDeps(ctx), model: createMockModelClient(async () => reading("sold rice 63", shorthand)) });
      const fixed1 = await fixProposal(p1.id, SHOP_A, "1", { ...voiceDeps(ctx), model: createMockModelClient(async () => { throw new Error("model must not be called for a 1/2 pick"); }) });
      assert.equal(fixed1.question, null);
      assert.deepEqual(fixed1.flags, []);
      assert.equal(fixed1.entries[0].amountKobo, 6300);
      confirm(ctx, SHOP_A, fixed1.id);
      assert.equal(ctx.ledger.list(SHOP_A)[0].amount_kobo, 6300);

      const p2 = await propose(SHOP_A, "sold rice 63", { ...voiceDeps(ctx), model: createMockModelClient(async () => reading("sold rice 63", shorthand)) });
      const fixed2 = await fixProposal(p2.id, SHOP_A, "2", { ...voiceDeps(ctx), model: createMockModelClient(async () => { throw new Error("model must not be called for a 1/2 pick"); }) });
      assert.equal(fixed2.entries[0].amountKobo, 630000);
      confirm(ctx, SHOP_A, fixed2.id);
      assert.equal(ctx.ledger.list(SHOP_A)[1].amount_kobo, 630000);
    } finally {
      teardown(ctx);
    }
  });

  it("'6 3' joins into 63 and gives the same two-amount choice", async () => {
    const ctx = setup();
    try {
      const mk = (heard, phrase) => createMockModelClient(async () => reading(heard, [{ type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 63, amountPhrase: phrase, priceBasis: "total" }]));
      const spaced = await propose(SHOP_A, "Somebody buy rice 6 3 he never pay", { ...voiceDeps(ctx), model: mk("Somebody buy rice 6 3 he never pay", "6 3") });
      const plain = await propose(SHOP_A, "Somebody buy rice 63 he never pay", { ...voiceDeps(ctx), model: mk("Somebody buy rice 63 he never pay", "63") });
      assert.deepEqual(spaced.entries[0].amountOptions, [6300, 630000]);
      assert.equal(spaced.question, plain.question);
      assert.match(spaced.question, /Reply 1 for .*₦63.*2 for .*₦6,300/);
      assert.equal(spaced.heard, "Somebody buy rice 63 he never pay");
      assert.throws(() => confirm(ctx, SHOP_A, spaced.id), /cannot confirm/);
      assert.equal(ctx.ledger.list(SHOP_A).length, 0);
    } finally {
      teardown(ctx);
    }
  });

  it("'2 bags of rice' keeps its 2: no merge, no block", async () => {
    const ctx = setup();
    try {
      const p = await propose(SHOP_A, "Somebody buy 2 bags of rice for 9k", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("Somebody buy 2 bags of rice for 9k", [{ type: "sale", customer: "Ada", item: "rice", quantity: 2, unit: "bag", amountNaira: 9000, amountPhrase: "9k", priceBasis: "total" }])),
      });
      assert.equal(p.heard, "Somebody buy 2 bags of rice for 9k");
      assert.ok(!p.heard.includes("23"));
      assert.deepEqual(p.flags, []);
      assert.equal(p.question, null);
    } finally {
      teardown(ctx);
    }
  });

  it("'15k' and '6,300' pass through unchanged", async () => {
    const ctx = setup();
    try {
      const k = await propose(SHOP_A, "sold rice 15k", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("sold rice 15k", [{ type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" }])),
      });
      assert.equal(k.entries[0].amountOptions, null);
      assert.deepEqual(k.flags, []);
      assert.equal(k.question, null);
      assert.equal(k.heard, "sold rice 15k");

      const grouped = await propose(SHOP_A, "sold rice 6,300", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("sold rice 6,300", [{ type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 6300, amountPhrase: "6,300", priceBasis: "total" }])),
      });
      assert.equal(grouped.entries[0].amountOptions, null);
      assert.deepEqual(grouped.flags, []);
      assert.equal(grouped.question, null);
      assert.equal(grouped.heard, "sold rice 6,300");
    } finally {
      teardown(ctx);
    }
  });

  it("the second-opinion re-read sees the joined digits too", async () => {
    const ctx = setup();
    try {
      const seen = [];
      const secondFetch = async (url, opts) => {
        seen.push(JSON.parse(opts.body).messages[1].content);
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: JSON.stringify({ heard: "Somebody buy rice 63 he never pay", entries: [{ type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 63, amountPhrase: "63", priceBasis: "total" }], totals: null, promise: null, question: null }) } }] }),
          text: async () => "",
        };
      };
      await propose(SHOP_A, "Somebody buy rice 6 3 he never pay", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("Somebody buy rice 6 3 he never pay", [{ type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 63, amountPhrase: "6 3", priceBasis: "total" }])),
        secondOpinions: new SecondOpinionStore(ctx.db),
        secondOpinionFetch: secondFetch,
        secondOpinionEnv: { BASETEN_API_KEY: "fake", BASETEN_MODEL: "fake-model" },
      });
      assert.ok(seen.length > 0);
      assert.ok(seen[0].includes("63") && !seen[0].includes("6 3"), seen[0]);
    } finally {
      teardown(ctx);
    }
  });

  it("a spoken known name survives a blank model customer", async () => {
    const ctx = setup();
    try {
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "John", item: "rice" });
      const p = await propose(SHOP_A, "John paid 15k", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("John paid 15k", [{ type: "payment", customer: null, item: null, quantity: null, unit: null, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" }])),
      });
      assert.equal(p.entries[0].customer, "John");
      assert.deepEqual(p.flags, []);
      assert.ok(!p.assumptions.some((a) => a.includes("New customer")), p.assumptions.join("; "));
    } finally {
      teardown(ctx);
    }
  });

  it("a spoken new name the second reading caught is adopted, not labelled", async () => {
    const ctx = setup();
    try {
      const seen = [];
      const secondFetch = async (url, opts) => {
        seen.push(JSON.parse(opts.body).messages[1].content);
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: JSON.stringify({ heard: "John paid 15k", entries: [{ type: "payment", customer: "John", item: null, quantity: null, unit: null, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" }], totals: null, promise: null, question: null }) } }] }),
          text: async () => "",
        };
      };
      const p = await propose(SHOP_A, "John paid 15k", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("John paid 15k", [{ type: "payment", customer: null, item: null, quantity: null, unit: null, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" }])),
        secondOpinions: new SecondOpinionStore(ctx.db),
        secondOpinionFetch: secondFetch,
        secondOpinionEnv: { BASETEN_API_KEY: "fake", BASETEN_MODEL: "fake-model" },
      });
      assert.ok(seen.length > 0);
      assert.equal(p.entries[0].customer, "John");
      assert.ok(p.assumptions.includes("New customer: John."), p.assumptions.join("; "));
      assert.ok(!p.assumptions.some((a) => a.includes("Two readings differ: customer")), p.assumptions.join("; "));
      assert.deepEqual(p.flags, []);
      assert.equal(p.ai.secondOpinion.result, "differs");
    } finally {
      teardown(ctx);
    }
  });

  it("two spoken names stay ambiguous and keep the automatic label", async () => {
    const ctx = setup();
    try {
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "John", item: "rice" });
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 1000000, customer: "Musa", item: "beans" });
      const p = await propose(SHOP_A, "John paid 5k for Musa", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("John paid 5k for Musa", [{ type: "payment", customer: null, item: null, quantity: null, unit: null, amountNaira: 5000, amountPhrase: "5k", priceBasis: "total" }])),
      });
      assert.equal(p.entries[0].customer, "Customer 1");
      assert.deepEqual(p.flags, []);
      assert.ok(!p.assumptions.some((a) => a.includes("taken as")), p.assumptions.join("; "));
    } finally {
      teardown(ctx);
    }
  });

  it("a voice transcript name survives a blank model customer", async () => {
    const ctx = setup();
    try {
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "John", item: "rice" });
      const p = await propose(SHOP_A, { audioBase64: "RkFLRS1BVURJTw==", audioFormat: "wav" }, {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("John paid 15k", [{ type: "payment", customer: null, item: null, quantity: null, unit: null, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" }])),
      });
      assert.equal(p.entries[0].customer, "John");
      assert.deepEqual(p.flags, []);
    } finally {
      teardown(ctx);
    }
  });

  it("6,300 and sixty-three naira do not trigger the choice", async () => {
    const ctx = setup();
    try {
      const mk = (entry) => createMockModelClient(async () => reading("sold rice", [entry]));
      const grouped = await propose(SHOP_A, "sold rice 6,300", {
        ...voiceDeps(ctx),
        model: mk({ type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 6300, amountPhrase: "6,300", priceBasis: "total" }),
      });
      assert.equal(grouped.entries[0].amountOptions, null);
      assert.deepEqual(grouped.flags, []);
      assert.equal(grouped.question, null);

      const words = await propose(SHOP_A, "sold rice sixty-three naira", {
        ...voiceDeps(ctx),
        model: mk({ type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 63, amountPhrase: "sixty-three naira", priceBasis: "total" }),
      });
      assert.equal(words.entries[0].amountOptions, null);
      assert.deepEqual(words.flags, []);
      assert.equal(words.question, null);
    } finally {
      teardown(ctx);
    }
  });

  it("200 naira or more never triggers the choice", async () => {
    const ctx = setup();
    try {
      const mk = (entry) => createMockModelClient(async () => reading("sold rice", [entry]));
      const atThreshold = await propose(SHOP_A, "sold rice 200", {
        ...voiceDeps(ctx),
        model: mk({ type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 200, amountPhrase: "200", priceBasis: "total" }),
      });
      assert.equal(atThreshold.entries[0].amountOptions, null);
      assert.deepEqual(atThreshold.flags, []);

      const above = await propose(SHOP_A, "sold rice 1500", {
        ...voiceDeps(ctx),
        model: mk({ type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 1500, amountPhrase: "1500", priceBasis: "total" }),
      });
      assert.equal(above.entries[0].amountOptions, null);
      assert.deepEqual(above.flags, []);
    } finally {
      teardown(ctx);
    }
  });

  it("WhatsApp shows the two choices as plain reply options", async () => {
    const ctx = setup();
    try {
      const p = await propose(SHOP_A, "sold rice 63", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("sold rice 63", [{ type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 63, amountPhrase: "63", priceBasis: "total" }])),
      });
      const card = renderProposalCard(p, { existing: [], shopId: SHOP_A, products: [] });
      assert.match(card.text, /1 for .*₦63.*2 for .*₦6,300/);
      assert.deepEqual(card.buttons.map((b) => b.reply.title), ["Fix", "Reject"]);
    } finally {
      teardown(ctx);
    }
  });
});

describe("debts on the confirm proposal", () => {
  it("a debt proposal carries who, how much and the direction", async () => {
    const ctx = setup();
    try {
      const p = await propose(SHOP_A, "Ada dey owe me 20k", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("Ada dey owe me 20k", [{ type: "sale", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 20000, amountPhrase: "20k", priceBasis: "total" }])),
      });
      assert.deepEqual(p.flags, []);
      assert.deepEqual(p.debts, [{ customer: "Ada", amountKobo: 2000000, direction: "customer_owes" }]);
      const card = renderProposalCard(p, { existing: [], shopId: SHOP_A, products: [] });
      assert.match(card.text, /Debt: Ada owes \*₦20,000\*/);
      confirm(ctx, SHOP_A, p.id);
      assert.equal(ctx.ledger.list(SHOP_A).length, 1);
    } finally {
      teardown(ctx);
    }
  });

  it("a part-paid sale carries the total, the paid amount and the debt left", async () => {
    const ctx = setup();
    try {
      const p = await propose(SHOP_A, "sold for 45,000, paid 25,000", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("sold for 45,000, paid 25,000", [
          { type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 45000, amountPhrase: "45,000", priceBasis: "total" },
          { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 25000, amountPhrase: "25,000", priceBasis: "total" },
        ])),
      });
      assert.deepEqual(p.flags, []);
      assert.deepEqual(p.partPaid, { customer: "Ada", totalKobo: 4500000, paidKobo: 2500000, owedKobo: 2000000 });
      assert.deepEqual(p.debts, [{ customer: "Ada", amountKobo: 2000000, direction: "customer_owes" }]);
      const card = renderProposalCard(p, { existing: [], shopId: SHOP_A, products: [] });
      assert.match(card.text, /Debt: Ada owes \*₦20,000\*/);
      confirm(ctx, SHOP_A, p.id);
      assert.equal(ctx.ledger.list(SHOP_A).length, 2);
    } finally {
      teardown(ctx);
    }
  });

  it("a bad total gives a check proposal and saves nothing", async () => {
    const ctx = setup();
    try {
      const p = await propose(SHOP_A, "sold for 20,000, paid 25,000", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("sold for 20,000, paid 25,000", [
          { type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 20000, amountPhrase: "20,000", priceBasis: "total" },
          { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 25000, amountPhrase: "25,000", priceBasis: "total" },
        ])),
      });
      assert.ok(p.flags.length > 0);
      assert.ok(p.question);
      assert.equal(p.partPaid, null);
      assert.throws(() => confirm(ctx, SHOP_A, p.id), /cannot confirm/);
      assert.equal(ctx.ledger.list(SHOP_A).length, 0);
    } finally {
      teardown(ctx);
    }
  });

  it("fixing the amount recomputes the debt fields", async () => {
    const ctx = setup();
    try {
      const p = await propose(SHOP_A, "sold for 45,000, paid 25,000", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("sold for 45,000, paid 25,000", [
          { type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 45000, amountPhrase: "45,000", priceBasis: "total" },
          { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 25000, amountPhrase: "25,000", priceBasis: "total" },
        ])),
      });
      const fixed = await fixProposal(p.id, SHOP_A, "paid 30,000", {
        ...voiceDeps(ctx),
        model: createMockModelClient(async () => reading("paid 30,000", [
          { type: "sale", customer: "Ada", item: "rice", quantity: null, unit: null, amountNaira: 45000, amountPhrase: "45,000", priceBasis: "total" },
          { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 30000, amountPhrase: "30,000", priceBasis: "total" },
        ])),
      });
      assert.deepEqual(fixed.flags, []);
      assert.deepEqual(fixed.partPaid, { customer: "Ada", totalKobo: 4500000, paidKobo: 3000000, owedKobo: 1500000 });
      assert.deepEqual(fixed.debts, [{ customer: "Ada", amountKobo: 1500000, direction: "customer_owes" }]);
    } finally {
      teardown(ctx);
    }
  });
});
