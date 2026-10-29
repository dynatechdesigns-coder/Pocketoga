// Products catalog: auto-created from confirmed restocks and sales, prices
// set by the trader only (never the model), stock computed from the ledger.
// Fake data only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { ProductStore, LOW_STOCK_AT, stockLevels, withStock } from "./products.mjs";
import { confirmProposal } from "./voice.mjs";
import { renderProposalCard, renderStock, MAX_BODY_CHARS } from "./messages.mjs";
import { parseCommand } from "./whatsapp.mjs";
import { handleVoiceRequest, handleWebhookOnlyRequest } from "./server.mjs";

const SHOP_A = "shop-a";
const SHOP_B = "shop-b";

function setup() {
  const db = new DatabaseSync(":memory:");
  return { db, ledger: new Ledger(db), proposals: new ProposalStore(db), products: new ProductStore(db) };
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

async function dispatch(deps, opts) {
  const res = fakeRes();
  try {
    await handleVoiceRequest(fakeReq(opts), res, deps);
  } catch (err) {
    res.writeHead(err.status ?? 500);
    res.end(JSON.stringify({ error: err.message ?? "internal error" }));
  }
  return { status: res.statusCode, json: JSON.parse(res.text) };
}

async function dispatchOnly(deps, opts) {
  const res = fakeRes();
  await handleWebhookOnlyRequest(fakeReq(opts), res, deps);
  return { status: res.statusCode, json: JSON.parse(res.text) };
}

function seedProposal(ctx, shopId, entries) {
  const row = ctx.proposals.create({
    shopId,
    envelope: { version: 1, entries, totals: {}, flags: [], notes: [] },
    heard: "fake note",
  });
  return row.id;
}

describe("ProductStore", () => {
  it("auto-creates once per shop, lowercased name and unit; prices start empty", () => {
    const ctx = setup();
    try {
      const first = ctx.products.ensure({ shopId: SHOP_A, name: "Rice", unit: "bag" });
      assert.equal(first.shop_id, SHOP_A);
      assert.equal(first.name, "Rice");
      assert.equal(first.unit, "bag");
      assert.equal(first.sell_price_kobo, null);
      assert.equal(first.cost_price_kobo, null);

      // Same key (case-insensitive name) returns the same row, no duplicate.
      const again = ctx.products.ensure({ shopId: SHOP_A, name: "  rice ", unit: "bag" });
      assert.equal(again.id, first.id);
      assert.equal(ctx.products.listByShop(SHOP_A).length, 1);

      // Same name in another shop is a different product.
      const other = ctx.products.ensure({ shopId: SHOP_B, name: "rice", unit: "bag" });
      assert.notEqual(other.id, first.id);
    } finally {
      teardown(ctx);
    }
  });

  it("units distinguish products; a null unit is its own key", () => {
    const ctx = setup();
    try {
      const bag = ctx.products.ensure({ shopId: SHOP_A, name: "rice", unit: "bag" });
      const crate = ctx.products.ensure({ shopId: SHOP_A, name: "rice", unit: "crate" });
      const nounit = ctx.products.ensure({ shopId: SHOP_A, name: "rice", unit: null });
      assert.notEqual(bag.id, crate.id);
      assert.notEqual(bag.id, nounit.id);
      // Repeating the null-unit key returns the same row.
      assert.equal(ctx.products.ensure({ shopId: SHOP_A, name: "rice", unit: null }).id, nounit.id);
      assert.equal(ctx.products.listByShop(SHOP_A).length, 3);
    } finally {
      teardown(ctx);
    }
  });

  it("setPrices takes whole non-negative kobo and refreshes updated_at", () => {
    const ctx = setup();
    try {
      const p = ctx.products.ensure({ shopId: SHOP_A, name: "rice", unit: "bag", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
      const updated = ctx.products.setPrices(p.id, { sellPriceKobo: 1500000, costPriceKobo: 1200000 });
      assert.equal(updated.sell_price_kobo, 1500000);
      assert.equal(updated.cost_price_kobo, 1200000);
      assert.ok(Date.parse(updated.updated_at) > Date.parse("2026-01-01T00:00:00.000Z"));

      // Partial update keeps the other price.
      const partial = ctx.products.setPrices(p.id, { sellPriceKobo: 1600000 });
      assert.equal(partial.sell_price_kobo, 1600000);
      assert.equal(partial.cost_price_kobo, 1200000);
    } finally {
      teardown(ctx);
    }
  });

  it("setPrices rejects non-integers, negatives and unknown products", () => {
    const ctx = setup();
    try {
      const p = ctx.products.ensure({ shopId: SHOP_A, name: "rice", unit: "bag" });
      for (const bad of [10.5, "1500", -1, null, NaN, true]) {
        assert.throws(() => ctx.products.setPrices(p.id, { sellPriceKobo: bad }), /integer/, `sell ${String(bad)}`);
        assert.throws(() => ctx.products.setPrices(p.id, { costPriceKobo: bad }), /integer/, `cost ${String(bad)}`);
      }
      assert.throws(() => ctx.products.setPrices(9999, { sellPriceKobo: 100 }), /not found/);
    } finally {
      teardown(ctx);
    }
  });

  it("listByShop isolates shops and sorts by name", () => {
    const ctx = setup();
    try {
      ctx.products.ensure({ shopId: SHOP_A, name: "yam", unit: "tuber" });
      ctx.products.ensure({ shopId: SHOP_A, name: "beans", unit: "tin" });
      ctx.products.ensure({ shopId: SHOP_B, name: "rice", unit: "bag" });
      assert.deepEqual(
        ctx.products.listByShop(SHOP_A).map((p) => p.name),
        ["beans", "yam"]
      );
      assert.deepEqual(
        ctx.products.listByShop(SHOP_B).map((p) => p.name),
        ["rice"]
      );
    } finally {
      teardown(ctx);
    }
  });
});

describe("product stock from the ledger", () => {
  it("nets restocks minus sales per item and unit; null quantities ignored", () => {
    const ctx = setup();
    try {
      ctx.ledger.append({ shopId: SHOP_A, type: "restock", amountKobo: 6000000, customer: SHOP_A, item: "Rice", quantity: 10, unit: "bag" });
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 3000000, customer: "Ada", item: "rice", quantity: 4, unit: "bag" });
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 3000000, customer: "Ada", item: "rice", quantity: null, unit: "bag" });
      ctx.ledger.append({ shopId: SHOP_B, type: "sale", amountKobo: 9000000, customer: "Zed", item: "rice", quantity: 9, unit: "bag" });
      const levels = stockLevels(ctx.ledger.list(SHOP_A));
      assert.equal(levels.get("rice|bag"), 6);
      assert.equal(levels.has("rice|"), false);
    } finally {
      teardown(ctx);
    }
  });

  it("corrections to restock and sale quantities move stock", () => {
    const ctx = setup();
    try {
      const restock = ctx.ledger.append({ shopId: SHOP_A, type: "restock", amountKobo: 6000000, customer: SHOP_A, item: "rice", quantity: 10, unit: "bag" });
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 3000000, customer: "Ada", item: "rice", quantity: 4, unit: "bag" });
      assert.equal(stockLevels(ctx.ledger.list(SHOP_A)).get("rice|bag"), 6);
      ctx.ledger.appendCorrection(restock.id, { amountKobo: 6000000, quantity: 8 });
      ctx.ledger.appendCorrection(sale.id, { amountKobo: 3000000, quantity: 5 });
      assert.equal(stockLevels(ctx.ledger.list(SHOP_A)).get("rice|bag"), 3);
    } finally {
      teardown(ctx);
    }
  });

  it("lowStock is true at 3 units or fewer", () => {
    assert.equal(LOW_STOCK_AT, 3);
    const ctx = setup();
    try {
      ctx.products.ensure({ shopId: SHOP_A, name: "plenty", unit: "bag" });
      ctx.products.ensure({ shopId: SHOP_A, name: "low", unit: "bag" });
      ctx.products.ensure({ shopId: SHOP_A, name: "empty", unit: "bag" });
      ctx.ledger.append({ shopId: SHOP_A, type: "restock", amountKobo: 1000000, customer: SHOP_A, item: "plenty", quantity: 10, unit: "bag" });
      ctx.ledger.append({ shopId: SHOP_A, type: "restock", amountKobo: 300000, customer: SHOP_A, item: "low", quantity: 3, unit: "bag" });
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 100000, customer: "Ada", item: "low", quantity: 1, unit: "bag" });
      const rows = withStock(ctx.products.listByShop(SHOP_A), ctx.ledger.list(SHOP_A));
      const byName = new Map(rows.map((r) => [r.name, r]));
      assert.deepEqual(
        [byName.get("plenty").stockOnHand, byName.get("plenty").lowStock],
        [10, false]
      );
      assert.deepEqual([byName.get("low").stockOnHand, byName.get("low").lowStock], [2, true]);
      // No movement at all: 0 on hand is low.
      assert.deepEqual([byName.get("empty").stockOnHand, byName.get("empty").lowStock], [0, true]);
    } finally {
      teardown(ctx);
    }
  });
});

describe("products routes", () => {
  function routeCtx() {
    const ctx = setup();
    return { ...ctx, deps: { ledger: ctx.ledger, proposals: ctx.proposals, products: ctx.products } };
  }

  it("GET /products returns the catalog shape with computed stock, per shop", async () => {
    const ctx = routeCtx();
    try {
      const rice = ctx.products.ensure({ shopId: SHOP_A, name: "rice", unit: "bag" });
      ctx.products.setPrices(rice.id, { sellPriceKobo: 1500000, costPriceKobo: 1200000 });
      ctx.ledger.append({ shopId: SHOP_A, type: "restock", amountKobo: 6000000, customer: SHOP_A, item: "rice", quantity: 10, unit: "bag" });
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 3000000, customer: "Ada", item: "rice", quantity: 4, unit: "bag" });
      ctx.products.ensure({ shopId: SHOP_B, name: "yam", unit: "tuber" });

      const out = await dispatch(ctx.deps, { url: "/products", headers: { "x-shop-id": SHOP_A } });
      assert.equal(out.status, 200);
      assert.deepEqual(out.json, {
        products: [
          { id: rice.id, name: "rice", unit: "bag", sellPriceKobo: 1500000, costPriceKobo: 1200000, stockOnHand: 6, lowStock: false },
        ],
      });

      const other = await dispatch(ctx.deps, { url: "/products", headers: { "x-shop-id": SHOP_B } });
      assert.equal(other.status, 200);
      assert.equal(other.json.products.length, 1);
      assert.equal(other.json.products[0].name, "yam");
    } finally {
      teardown(ctx);
    }
  });

  it("POST /products/:id sets prices and returns the product", async () => {
    const ctx = routeCtx();
    try {
      const rice = ctx.products.ensure({ shopId: SHOP_A, name: "rice", unit: "bag" });
      const out = await dispatch(ctx.deps, {
        method: "POST",
        url: `/products/${rice.id}`,
        headers: { "x-shop-id": SHOP_A },
        body: { sellPriceKobo: 1500000 },
      });
      assert.equal(out.status, 200);
      assert.equal(out.json.product.sellPriceKobo, 1500000);
      assert.equal(out.json.product.costPriceKobo, null);
      assert.equal(out.json.product.name, "rice");
    } finally {
      teardown(ctx);
    }
  });

  it("POST /products/:id refuses another shop's product, missing ids and bad money", async () => {
    const ctx = routeCtx();
    try {
      const rice = ctx.products.ensure({ shopId: SHOP_A, name: "rice", unit: "bag" });
      const headers = { "x-shop-id": SHOP_B };

      const cross = await dispatch(ctx.deps, { method: "POST", url: `/products/${rice.id}`, headers, body: { sellPriceKobo: 100 } });
      assert.equal(cross.status, 403);

      const missing = await dispatch(ctx.deps, { method: "POST", url: "/products/9999", headers: { "x-shop-id": SHOP_A }, body: { sellPriceKobo: 100 } });
      assert.equal(missing.status, 404);

      for (const body of [{ sellPriceKobo: 10.5 }, { sellPriceKobo: -5 }, { sellPriceKobo: "100" }, { costPriceKobo: null }, {}]) {
        const bad = await dispatch(ctx.deps, { method: "POST", url: `/products/${rice.id}`, headers: { "x-shop-id": SHOP_A }, body });
        assert.equal(bad.status, 400, JSON.stringify(body));
      }

      const noShop = await dispatch(ctx.deps, { method: "POST", url: `/products/${rice.id}`, body: { sellPriceKobo: 100 } });
      assert.equal(noShop.status, 400);
    } finally {
      teardown(ctx);
    }
  });

  it("the webhook port 404s every products route", async () => {
    const ctx = routeCtx();
    try {
      const rice = ctx.products.ensure({ shopId: SHOP_A, name: "rice", unit: "bag" });
      assert.equal((await dispatchOnly(ctx.deps, { url: "/products", headers: { "x-shop-id": SHOP_A } })).status, 404);
      assert.equal(
        (await dispatchOnly(ctx.deps, { method: "POST", url: `/products/${rice.id}`, headers: { "x-shop-id": SHOP_A }, body: { sellPriceKobo: 1 } })).status,
        404
      );
    } finally {
      teardown(ctx);
    }
  });
});

describe("confirm auto-creates products", () => {
  it("a confirmed restock and sale enter the catalog with empty prices", () => {
    const ctx = setup();
    try {
      const id = seedProposal(ctx, SHOP_A, [
        { type: "restock", customer: SHOP_A, item: "Rice", quantity: 10, unit: "bag", amountKobo: 6000000 },
        { type: "sale", customer: "Ada", item: "rice", quantity: 2, unit: "bag", amountKobo: 3000000 },
        { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountKobo: 1000000 },
      ]);
      const out = confirmProposal(id, SHOP_A, { proposals: ctx.proposals, ledger: ctx.ledger, products: ctx.products });
      assert.equal(out.alreadyConfirmed, false);
      const catalog = ctx.products.listByShop(SHOP_A);
      assert.equal(catalog.length, 1);
      assert.equal(catalog[0].name, "Rice");
      assert.equal(catalog[0].unit, "bag");
      assert.equal(catalog[0].sell_price_kobo, null);
      // Stock follows the confirmed entries.
      assert.equal(withStock(catalog, ctx.ledger.list(SHOP_A))[0].stockOnHand, 8);
    } finally {
      teardown(ctx);
    }
  });

  it("confirming without a products store still works and writes nothing", () => {
    const ctx = setup();
    try {
      const id = seedProposal(ctx, SHOP_A, [
        { type: "sale", customer: "Ada", item: "rice", quantity: 1, unit: "bag", amountKobo: 1500000 },
      ]);
      const out = confirmProposal(id, SHOP_A, { proposals: ctx.proposals, ledger: ctx.ledger });
      assert.equal(out.alreadyConfirmed, false);
      assert.equal(ctx.products.listByShop(SHOP_A).length, 0);
    } finally {
      teardown(ctx);
    }
  });
});

describe("usual-price note", () => {
  const saleProposal = (over = {}) => ({
    id: 7,
    shop_id: SHOP_A,
    status: "pending",
    heard: "Ada buy rice 2 bags 30k",
    question: null,
    created_at: "2026-10-28T10:00:00.000Z",
    entries: [
      { type: "sale", customer: "Ada", item: "rice", quantity: 2, unit: "bag", amountKobo: 3000000, ...over },
    ],
    totals: {},
    flags: [],
    notes: [],
    recorded_ids: null,
    name_checked: null,
    promise: null,
  });
  const priced = [{ id: 1, shop_id: SHOP_A, name: "rice", unit: "bag", sell_price_kobo: 1400000, cost_price_kobo: null }];

  it("shows the gentle line when the unit price differs from the known sell price", () => {
    const { text, buttons } = renderProposalCard(saleProposal(), { existing: [], shopId: SHOP_A, products: priced });
    assert.match(text, /usual price ₦14,000/);
    // Gentle: the card keeps its Save button.
    assert.ok(buttons.some((b) => b.reply.id === "confirm:7"));
  });

  it("stays silent on a matching price, a missing price and unknown items", () => {
    const match = renderProposalCard(saleProposal(), {
      existing: [],
      shopId: SHOP_A,
      products: [{ ...priced[0], sell_price_kobo: 1500000 }],
    }).text;
    assert.ok(!match.includes("usual price"), match);

    const unpriced = renderProposalCard(saleProposal(), {
      existing: [],
      shopId: SHOP_A,
      products: [{ ...priced[0], sell_price_kobo: null }],
    }).text;
    assert.ok(!unpriced.includes("usual price"), unpriced);

    const noCatalog = renderProposalCard(saleProposal(), { existing: [], shopId: SHOP_A }).text;
    assert.ok(!noCatalog.includes("usual price"), noCatalog);
  });

  it("uses eachKobo when present and needs a quantity otherwise", () => {
    const each = renderProposalCard(saleProposal({ eachKobo: 1300000 }), { existing: [], shopId: SHOP_A, products: priced }).text;
    assert.match(each, /usual price ₦14,000/);

    const noQty = renderProposalCard(saleProposal({ quantity: null }), { existing: [], shopId: SHOP_A, products: priced }).text;
    assert.ok(!noQty.includes("usual price"), noQty);
  });

  it("shows once on needs-checking cards too, without changing the buttons", () => {
    const blocked = {
      ...saleProposal(),
      flags: ["something to check"],
      question: "Which one na correct?",
    };
    const { text, buttons } = renderProposalCard(blocked, { existing: [], shopId: SHOP_A, products: priced });
    assert.equal(text.match(/usual price ₦14,000/g).length, 1);
    assert.deepEqual(
      buttons.map((b) => b.reply.id),
      ["fix:7", "reject:7"]
    );
  });
});

describe("stock command", () => {
  it("parses stock before any model call; stock with words stays a note", () => {
    assert.deepEqual(parseCommand("stock"), { name: "stock" });
    assert.deepEqual(parseCommand("  STOCK! "), { name: "stock" });
    assert.equal(parseCommand("stock rice"), null);
    assert.equal(parseCommand("restock"), null);
  });

  it("renders the 5 lowest items with a more-line", () => {
    const text = renderStock([
      { name: "rice", unit: "bag", stockOnHand: 2 },
      { name: "yam", unit: "tuber", stockOnHand: 0 },
      { name: "beans", unit: "tin", stockOnHand: 10 },
      { name: "garri", unit: null, stockOnHand: -1 },
      { name: "oil", unit: "litre", stockOnHand: 3 },
      { name: "salt", unit: null, stockOnHand: 50 },
      { name: "pepper", unit: "bag", stockOnHand: 4 },
    ]);
    assert.equal(
      text,
      "📦 *Stock*\ngarri: -1 left\nyam (tuber): 0 left\nrice (bag): 2 left\noil (litre): 3 left\npepper (bag): 4 left\n+2 more"
    );
  });

  it("empty catalog gets a quiet line; long lists stay under the cap", () => {
    assert.equal(renderStock([]), "📦 *Stock*\nNothing in the catalog yet.");
    const many = Array.from({ length: 200 }, (_, i) => ({ name: `item-${i}-with-a-long-name`, unit: "bag", stockOnHand: i }));
    assert.ok(renderStock(many).length <= MAX_BODY_CHARS);
  });
});
