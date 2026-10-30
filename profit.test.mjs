// Expenses and profit. Fake data only; the clock is fixed at Wed 28 Oct
// 2026 13:00 Lagos unless a test says otherwise.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Ledger, computeEntryHash } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { ProductStore, stockLevels } from "./products.mjs";
import { propose, confirmProposal, ENTRY_TYPES } from "./voice.mjs";
import { createMockModelClient } from "./model.mjs";
import { customerDebts } from "./debts.mjs";
import { renderProposalCard, renderSavedReply, renderProfit, MAX_BODY_CHARS } from "./messages.mjs";
import { PROFIT_PERIODS, periodRange, profitForPeriod, expensesForPeriod, lagosHour } from "./profit.mjs";
import { handleVoiceRequest, handleWebhookOnlyRequest } from "./server.mjs";
import { AuthStore, DEMO_SHOP_ID } from "./auth.mjs";

const SHOP = "shop-a";
const OTHER_SHOP = "shop-b";
// Wed 28 Oct 2026 12:00 UTC = 13:00 in Lagos (UTC+1, no DST).
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

function setup() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    ledger: new Ledger(db),
    proposals: new ProposalStore(db),
    products: new ProductStore(db),
    auths: new AuthStore(db),
  };
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

// Tests log in transparently: the first request for a shop mints a session
// through the real issue+exchange path (the login flow itself is tested in
// auth.test.mjs). Explicit authorization headers always win.
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

async function dispatchOnly(deps, opts) {
  const res = fakeRes();
  await handleWebhookOnlyRequest(fakeReq(opts), res, deps);
  return { status: res.statusCode, json: JSON.parse(res.text) };
}

function expenseReading(over = {}, entryOver = {}) {
  return {
    heard: "Paid NEPA 5k for power.",
    entries: [
      {
        type: "expense",
        customer: "NEPA",
        item: "power",
        quantity: null,
        unit: null,
        amountNaira: 5000,
        amountPhrase: "5k",
        priceBasis: "total",
        ...entryOver,
      },
    ],
    totals: null,
    promise: null,
    question: null,
    ...over,
  };
}

async function proposeExpense(ctx, reading) {
  return propose(SHOP, "Paid NEPA 5k for power.", {
    proposals: ctx.proposals,
    model: createMockModelClient(async () => reading),
    ledger: ctx.ledger,
    now: NOW,
  });
}

describe("expense entries", () => {
  it("expense is a valid entry type with category, payee and kobo amount", async () => {
    assert.ok(ENTRY_TYPES.includes("expense"));
    const ctx = setup();
    try {
      const proposal = await proposeExpense(ctx, expenseReading());
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      assert.deepEqual(proposal.entries, [
        {
          type: "expense",
          customer: "NEPA",
          item: "power",
          quantity: null,
          unit: null,
          priceBasis: "total",
          amountNaira: 5000,
          amountKobo: 500000,
          amountPhrase: "5k",
          eachNaira: null,
          eachKobo: null,
        },
      ]);
    } finally {
      teardown(ctx);
    }
  });

  it("unknown categories become other; a missing payee becomes the shop", async () => {
    const ctx = setup();
    try {
      const repairs = await proposeExpense(ctx, expenseReading({}, { item: "repairs" }));
      assert.deepEqual(repairs.flags, []);
      assert.equal(repairs.entries[0].item, "other");

      for (const known of ["fuel", "data"]) {
        const kept = await proposeExpense(ctx, expenseReading({}, { item: known }));
        assert.deepEqual(kept.flags, []);
        assert.equal(kept.entries[0].item, known);
      }

      const capped = await proposeExpense(ctx, expenseReading({}, { item: "  Transport " }));
      assert.equal(capped.entries[0].item, "transport");

      const missing = await proposeExpense(ctx, expenseReading({}, { item: null, customer: null }));
      assert.deepEqual(missing.flags, []);
      assert.equal(missing.entries[0].item, "other");
      assert.equal(missing.entries[0].customer, SHOP);
    } finally {
      teardown(ctx);
    }
  });

  it("expense quantity and unit are dropped; an each-price is assumed a total, softly", async () => {
    const ctx = setup();
    try {
      const proposal = await proposeExpense(
        ctx,
        expenseReading({}, { quantity: 2, unit: "bag", priceBasis: "each" })
      );
      assert.equal(proposal.entries[0].quantity, null);
      assert.equal(proposal.entries[0].unit, null);
      assert.equal(proposal.entries[0].priceBasis, "total");
      assert.equal(proposal.entries[0].amountKobo, 500000);
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      assert.deepEqual(proposal.assumptions, ["Expense taken as a total."]);
    } finally {
      teardown(ctx);
    }
  });

  it("confirm records the expense and never touches the products catalog", async () => {
    const ctx = setup();
    try {
      const proposal = await proposeExpense(ctx, expenseReading());
      const out = confirmProposal(proposal.id, SHOP, {
        proposals: ctx.proposals,
        ledger: ctx.ledger,
        products: ctx.products,
      });
      assert.equal(out.alreadyConfirmed, false);
      const rows = ctx.ledger.list(SHOP);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].type, "expense");
      assert.equal(rows[0].item, "power");
      assert.equal(rows[0].customer, "NEPA");
      assert.equal(rows[0].amount_kobo, 500000);
      assert.equal(rows[0].quantity, null);
      assert.equal(rows[0].unit, null);
      assert.deepEqual(ctx.products.listByShop(SHOP), []);
      assert.equal(ctx.ledger.verify(SHOP).ok, true);
    } finally {
      teardown(ctx);
    }
  });

  it("the ledger rejects expenses with quantity, unit or no category", () => {
    const ctx = setup();
    try {
      assert.throws(
        () => ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 100, customer: SHOP, item: "power", quantity: 1 }),
        /quantity and unit/
      );
      assert.throws(
        () => ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 100, customer: SHOP, item: "power", unit: "bag" }),
        /quantity and unit/
      );
      assert.throws(
        () => ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 100, customer: SHOP, item: null }),
        /category/
      );
    } finally {
      teardown(ctx);
    }
  });

  it("a pre-expense database still verifies and accepts expenses", () => {
    // Schema exactly as before the expense type existed (no type whitelist,
    // no new columns); rows hashed the old way.
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE ledger_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        prev_hash TEXT,
        entry_hash TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        amount_kobo INTEGER NOT NULL CHECK (typeof(amount_kobo) = 'integer' AND amount_kobo >= 0),
        customer TEXT NOT NULL,
        item TEXT CHECK (item IS NULL OR length(item) > 0),
        quantity INTEGER CHECK (quantity IS NULL OR (typeof(quantity) = 'integer' AND quantity > 0)),
        unit TEXT CHECK (unit IS NULL OR length(unit) > 0),
        corrects_id INTEGER REFERENCES ledger_entries(id),
        created_at TEXT NOT NULL,
        UNIQUE (shop_id, seq)
      )`);
      const stamp = "2026-10-27T10:00:00.000Z";
      const hash = computeEntryHash({
        shopId: SHOP, seq: 1, type: "sale", amountKobo: 2000000,
        customer: "Ada", item: "rice", quantity: 2, unit: "bag",
        correctsId: null, createdAt: stamp, prevHash: null,
      });
      db.prepare(
        "INSERT INTO ledger_entries (shop_id, seq, prev_hash, entry_hash, type, amount_kobo, customer, item, quantity, unit, corrects_id, created_at) VALUES (?, 1, NULL, ?, 'sale', 2000000, 'Ada', 'rice', 2, 'bag', NULL, ?)"
      ).run(SHOP, hash, stamp);

      const ledger = new Ledger(db);
      assert.deepEqual(ledger.verify(SHOP), { ok: true, count: 1, shopId: SHOP });
      const expense = ledger.append({ shopId: SHOP, type: "expense", amountKobo: 500000, customer: "NEPA", item: "power" });
      assert.equal(expense.seq, 2);
      assert.equal(ledger.verify(SHOP).ok, true);
    } finally {
      db.close();
    }
  });

  it("expenses never affect debts, stock or products", () => {
    const ctx = setup();
    try {
      ctx.ledger.append({ shopId: SHOP, type: "restock", amountKobo: 6000000, customer: SHOP, item: "rice", quantity: 10, unit: "bag" });
      ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: 3000000, customer: "Ada", item: "rice", quantity: 4, unit: "bag" });
      ctx.ledger.append({ shopId: SHOP, type: "payment", amountKobo: 1000000, customer: "Ada" });
      const debtsFor = (name) => customerDebts(ctx.ledger.list(SHOP), { now: NOW }).find((d) => d.customer === name);
      const adaBefore = debtsFor("Ada");
      const beforeStock = [...stockLevels(ctx.ledger.list(SHOP)).entries()];

      const expense = ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 500000, customer: "NEPA", item: "power" });
      ctx.ledger.appendCorrection(expense.id, { amountKobo: 450000 });
      // Same customer name as a debtor: still no effect on what Ada owes.
      ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 999900, customer: "Ada", item: "transport" });

      assert.deepEqual(debtsFor("Ada"), adaBefore);
      assert.deepEqual(debtsFor("NEPA"), { customer: "NEPA", owedKobo: 0, salesKobo: 0, paidKobo: 0, oldestUnpaidAgeDays: null, oldestUnpaidAt: null, lastPaymentAt: null });
      assert.deepEqual([...stockLevels(ctx.ledger.list(SHOP)).entries()], beforeStock);
    } finally {
      teardown(ctx);
    }
  });

  it("corrections work on expenses as on other entries", () => {
    const ctx = setup();
    try {
      const expense = ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 500000, customer: "NEPA", item: "power" });
      const fix = ctx.ledger.appendCorrection(expense.id, { amountKobo: 450000 });
      assert.equal(fix.corrects_id, expense.id);
      assert.equal(fix.item, "power");
      assert.equal(ctx.ledger.get(expense.id).amount_kobo, 500000);
      assert.equal(ctx.ledger.verify(SHOP).ok, true);
    } finally {
      teardown(ctx);
    }
  });

});

describe("profit periods in Lagos time", () => {
  it("exposes the four periods and rejects anything else", () => {
    assert.deepEqual([...PROFIT_PERIODS], ["today", "week", "month", "year"]);
    assert.throws(() => periodRange("fortnight", NOW), /unknown period/);
    assert.throws(() => periodRange("", NOW), /unknown period/);
  });

  it("lagosHour reads the Lagos clock hour, midnight included", () => {
    assert.equal(lagosHour(NOW), "13");
    // 23:00 UTC is 00:00 in Lagos, never "24".
    assert.equal(lagosHour(Date.UTC(2026, 9, 27, 23, 0, 0)), "00");
    assert.equal(lagosHour(Date.UTC(2026, 9, 28, 22, 59, 59)), "23");
  });

  it("period boundaries follow the Lagos calendar", () => {
    assert.deepEqual(periodRange("today", NOW), { from: "2026-10-28", to: "2026-10-28" });
    assert.deepEqual(periodRange("week", NOW), { from: "2026-10-26", to: "2026-11-01" });
    assert.deepEqual(periodRange("month", NOW), { from: "2026-10-01", to: "2026-10-31" });
    assert.deepEqual(periodRange("year", NOW), { from: "2026-01-01", to: "2026-12-31" });
    // Sunday evening still belongs to the Monday-start week.
    assert.deepEqual(periodRange("week", Date.UTC(2026, 10, 1, 20, 0, 0)), { from: "2026-10-26", to: "2026-11-01" });
    // Monday just after midnight starts the same week.
    assert.deepEqual(periodRange("week", Date.UTC(2026, 9, 25, 23, 30, 0)), { from: "2026-10-26", to: "2026-11-01" });
    // A November clock reads November.
    assert.deepEqual(periodRange("month", Date.UTC(2026, 10, 2, 12, 0, 0)), { from: "2026-11-01", to: "2026-11-30" });
  });

  it("entries count by Lagos day inside from and to, edges included", () => {
    const ctx = setup();
    try {
      const sale = (amountKobo, createdAt) =>
        ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo, customer: "Ada", createdAt });
      // Today (Lagos 28 Oct): midnight, midday, last second.
      sale(1000, "2026-10-27T23:00:00.000Z");
      sale(2000, "2026-10-28T12:00:00.000Z");
      sale(3000, "2026-10-28T22:59:59.000Z");
      // Neighbouring Lagos days: in week and month, out of today.
      sale(4000, "2026-10-27T22:59:59.000Z");
      sale(5000, "2026-10-28T23:00:00.000Z");
      // Outside the week (Sun 25 Oct, Mon 2 Nov in Lagos).
      sale(6000, "2026-10-25T22:59:59.000Z");
      sale(7000, "2026-11-01T23:00:00.000Z");
      // Month edges: Sep 30 out, Oct 1 in, Oct 31 in, Nov 1 out.
      sale(8000, "2026-09-30T22:59:59.000Z");
      sale(9000, "2026-09-30T23:00:00.000Z");
      sale(10000, "2026-10-31T22:59:59.000Z");
      sale(11000, "2026-11-01T22:59:59.000Z");
      // Year edges: Dec 31 2025 out, Jan 1 2026 in.
      sale(12000, "2025-12-31T22:59:59.000Z");
      sale(13000, "2025-12-31T23:00:00.000Z");

      const rows = ctx.ledger.list(SHOP);
      assert.equal(profitForPeriod(rows, "today", { now: NOW }).salesKobo, 6000);
      assert.equal(profitForPeriod(rows, "week", { now: NOW }).salesKobo, 36000);
      assert.equal(profitForPeriod(rows, "month", { now: NOW }).salesKobo, 40000);
      assert.equal(profitForPeriod(rows, "year", { now: NOW }).salesKobo, 79000);
    } finally {
      teardown(ctx);
    }
  });
});

describe("profit maths", () => {
  function seedTrading(ctx) {
    // Restock history in September still prices October sales.
    ctx.ledger.append({ shopId: SHOP, type: "restock", amountKobo: 6000000, customer: SHOP, item: "rice", quantity: 10, unit: "bag", createdAt: "2026-09-05T10:00:00.000Z" });
    ctx.ledger.append({ shopId: SHOP, type: "restock", amountKobo: 8000000, customer: SHOP, item: "Rice", quantity: 10, unit: "Bag", createdAt: "2026-10-01T10:00:00.000Z" });
    // 4 bags sold today at 40k; avg cost 7000/bag -> cogs 2.8m.
    ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: 4000000, customer: "Ada", item: "rice", quantity: 4, unit: "bag", createdAt: "2026-10-28T09:30:00.000Z" });
    // Beans have sales but no restock history: skipped and counted once.
    ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: 1000000, customer: "Bola", item: "beans", quantity: 2, unit: "tin", createdAt: "2026-10-28T08:00:00.000Z" });
    ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: 500000, customer: "Bola", item: "beans", quantity: 1, unit: "tin", createdAt: "2026-10-28T08:30:00.000Z" });
    // No quantity: sales count, no cogs, not an item without cost.
    ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: 700000, customer: "Ada", createdAt: "2026-10-28T07:00:00.000Z" });
    // Yesterday's sale stays out of today.
    ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: 9000000, customer: "Ada", item: "rice", quantity: 9, unit: "bag", createdAt: "2026-10-27T10:00:00.000Z" });
    ctx.ledger.append({ shopId: SHOP, type: "payment", amountKobo: 2000000, customer: "Ada", createdAt: "2026-10-28T11:00:00.000Z" });
    ctx.ledger.append({ shopId: SHOP, type: "payment", amountKobo: 8000000, customer: "Ada", createdAt: "2026-10-20T11:00:00.000Z" });
    ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 500000, customer: "NEPA", item: "power", createdAt: "2026-10-28T06:00:00.000Z" });
    ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 300000, customer: SHOP, item: "transport", createdAt: "2026-10-27T06:00:00.000Z" });
  }

  it("sales, collected, cogs, expenses and profit stay separate figures", () => {
    const ctx = setup();
    try {
      seedTrading(ctx);
      const out = profitForPeriod(ctx.ledger.list(SHOP), "today", { now: NOW });
      assert.equal(out.period, "today");
      assert.equal(out.from, "2026-10-28");
      assert.equal(out.to, "2026-10-28");
      assert.equal(out.salesKobo, 6200000);
      assert.equal(out.collectedKobo, 2000000);
      assert.equal(out.cogsKobo, 2800000);
      assert.equal(out.expensesKobo, 500000);
      assert.equal(out.estimatedProfitKobo, 6200000 - 2800000 - 500000);
      assert.equal(out.itemsWithoutCost, 1);
    } finally {
      teardown(ctx);
    }
  });

  it("series buckets are hours for today, days for week and month, months for year", () => {
    const ctx = setup();
    try {
      seedTrading(ctx);
      const rows = ctx.ledger.list(SHOP);

      const today = profitForPeriod(rows, "today", { now: NOW }).series;
      assert.equal(today.length, 24);
      assert.deepEqual(
        today.map((b) => b.label),
        Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"))
      );
      // The 4-bag rice sale landed at 10:30 Lagos.
      assert.deepEqual(today[10], { label: "10", salesKobo: 4000000, cogsKobo: 2800000, expensesKobo: 0, profitKobo: 1200000 });
      assert.deepEqual(today[0], { label: "00", salesKobo: 0, cogsKobo: 0, expensesKobo: 0, profitKobo: 0 });

      const week = profitForPeriod(rows, "week", { now: NOW }).series;
      assert.deepEqual(
        week.map((b) => b.label),
        ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]
      );

      const month = profitForPeriod(rows, "month", { now: NOW }).series;
      assert.equal(month.length, 31);
      assert.equal(month[0].label, "2026-10-01");
      assert.equal(month[30].label, "2026-10-31");

      const year = profitForPeriod(rows, "year", { now: NOW }).series;
      assert.deepEqual(
        year.map((b) => b.label),
        ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]
      );
      // September holds the first restock but no sales.
      assert.deepEqual(year[8], { label: "2026-09", salesKobo: 0, cogsKobo: 0, expensesKobo: 0, profitKobo: 0 });
    } finally {
      teardown(ctx);
    }
  });

  it("corrections move sales, cogs and expenses together", () => {
    const ctx = setup();
    try {
      const restock = ctx.ledger.append({ shopId: SHOP, type: "restock", amountKobo: 6000000, customer: SHOP, item: "rice", quantity: 10, unit: "bag", createdAt: "2026-10-01T10:00:00.000Z" });
      const sale = ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: 4000000, customer: "Ada", item: "rice", quantity: 4, unit: "bag", createdAt: "2026-10-28T09:30:00.000Z" });
      const expense = ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 500000, customer: "NEPA", item: "power", createdAt: "2026-10-28T06:00:00.000Z" });

      const before = profitForPeriod(ctx.ledger.list(SHOP), "today", { now: NOW });
      assert.deepEqual([before.salesKobo, before.cogsKobo, before.expensesKobo], [4000000, 2400000, 500000]);

      ctx.ledger.appendCorrection(sale.id, { amountKobo: 3000000, createdAt: "2026-10-28T10:00:00.000Z" });
      ctx.ledger.appendCorrection(restock.id, { amountKobo: 6000000, quantity: 5, createdAt: "2026-10-28T10:05:00.000Z" });
      ctx.ledger.appendCorrection(expense.id, { amountKobo: 450000, createdAt: "2026-10-28T10:10:00.000Z" });

      const after = profitForPeriod(ctx.ledger.list(SHOP), "today", { now: NOW });
      assert.deepEqual([after.salesKobo, after.cogsKobo, after.expensesKobo], [3000000, 4800000, 450000]);
      assert.equal(after.estimatedProfitKobo, 3000000 - 4800000 - 450000);
    } finally {
      teardown(ctx);
    }
  });
});

describe("profit and loss results", () => {
  const DAY = "2026-10-28T09:30:00.000Z"; // Lagos morning, "today" at NOW

  function seed(ctx, rows) {
    for (const r of rows) ctx.ledger.append({ shopId: SHOP, createdAt: DAY, ...r });
    return profitForPeriod(ctx.ledger.list(SHOP), "today", { now: NOW });
  }

  function assertIntegers(out) {
    for (const key of ["salesKobo", "collectedKobo", "cogsKobo", "expensesKobo", "estimatedProfitKobo", "resultKobo", "owedKobo", "missing_cost_items"]) {
      assert.equal(Number.isInteger(out[key]), true, key);
    }
  }

  it("a loss stays negative and names itself", () => {
    const ctx = setup();
    try {
      const out = seed(ctx, [
        { type: "restock", amountKobo: 1200000, customer: SHOP, item: "rice", quantity: 2, unit: "bag", createdAt: "2026-10-01T10:00:00.000Z" },
        { type: "sale", amountKobo: 1000000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" },
        { type: "expense", amountKobo: 100000, customer: "NEPA", item: "power" },
      ]);
      assert.equal(out.estimatedProfitKobo, -300000);
      assert.ok(out.estimatedProfitKobo < 0, "never clamped to zero");
      assert.equal(out.result, "loss");
      assert.equal(out.resultKobo, 300000);
      assertIntegers(out);
    } finally {
      teardown(ctx);
    }
  });

  it("an exact break-even names itself with a zero amount", () => {
    const ctx = setup();
    try {
      const out = seed(ctx, [
        { type: "restock", amountKobo: 1200000, customer: SHOP, item: "rice", quantity: 2, unit: "bag", createdAt: "2026-10-01T10:00:00.000Z" },
        { type: "sale", amountKobo: 1200000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" },
      ]);
      assert.equal(out.estimatedProfitKobo, 0);
      assert.equal(out.result, "break_even");
      assert.equal(out.resultKobo, 0);
      assertIntegers(out);
    } finally {
      teardown(ctx);
    }
  });

  it("a profit names itself with a positive amount", () => {
    const ctx = setup();
    try {
      const out = seed(ctx, [
        { type: "restock", amountKobo: 1000000, customer: SHOP, item: "rice", quantity: 2, unit: "bag", createdAt: "2026-10-01T10:00:00.000Z" },
        { type: "sale", amountKobo: 1500000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" },
        { type: "expense", amountKobo: 100000, customer: "NEPA", item: "power" },
      ]);
      assert.equal(out.estimatedProfitKobo, 400000);
      assert.equal(out.result, "profit");
      assert.equal(out.resultKobo, 400000);
      assertIntegers(out);
    } finally {
      teardown(ctx);
    }
  });

  it("missing cost counts distinct products, not units", () => {
    const ctx = setup();
    try {
      const out = seed(ctx, [
        { type: "sale", amountKobo: 1000000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" },
        { type: "sale", amountKobo: 200000, customer: "Ada", item: "rice", quantity: 1, unit: "bag" },
        { type: "sale", amountKobo: 500000, customer: "Bola", item: "beans", quantity: 5, unit: "bag" },
      ]);
      assert.equal(out.missing_cost_items, 2);
      assert.equal(out.itemsWithoutCost, 2);
      assertIntegers(out);
    } finally {
      teardown(ctx);
    }
  });

  it("credit sales show as owed to you; over-collection floors at zero", () => {
    const ctx = setup();
    try {
      seed(ctx, [
        { type: "sale", amountKobo: 3000000, customer: "Ada" },
        { type: "payment", amountKobo: 1000000, customer: "Ada" },
      ]);
      assert.equal(profitForPeriod(ctx.ledger.list(SHOP), "today", { now: NOW }).owedKobo, 2000000);
      ctx.ledger.append({ shopId: SHOP, type: "payment", amountKobo: 5000000, customer: "Ada", createdAt: DAY });
      const out = profitForPeriod(ctx.ledger.list(SHOP), "today", { now: NOW });
      assert.equal(out.collectedKobo, 6000000);
      assert.equal(out.owedKobo, 0);
      assertIntegers(out);
    } finally {
      teardown(ctx);
    }
  });
});

describe("profit edge cases", () => {
  it("an empty shop reports zeros for every figure in every period", () => {
    for (const period of PROFIT_PERIODS) {
      const out = profitForPeriod([], period, { now: NOW });
      assert.deepEqual(
        [out.salesKobo, out.collectedKobo, out.cogsKobo, out.expensesKobo, out.estimatedProfitKobo, out.itemsWithoutCost],
        [0, 0, 0, 0, 0, 0]
      );
      for (const key of ["salesKobo", "collectedKobo", "cogsKobo", "expensesKobo", "estimatedProfitKobo"]) {
        assert.equal(Number.isInteger(out[key]), true);
      }
      assert.equal(out.estimatedProfitKobo, out.salesKobo - out.cogsKobo - out.expensesKobo);
      assert.ok(out.series.length > 0);
      for (const bucket of out.series) {
        assert.deepEqual([bucket.salesKobo, bucket.cogsKobo, bucket.expensesKobo, bucket.profitKobo], [0, 0, 0, 0]);
      }
    }
    assert.deepEqual(expensesForPeriod([], "month", { now: NOW }), { expenses: [], byCategory: [] });
  });

  it("a refund-style correction removes the sale from profit without touching the original", () => {
    const ctx = setup();
    try {
      ctx.ledger.append({ shopId: SHOP, type: "restock", amountKobo: 6000000, customer: SHOP, item: "rice", quantity: 10, unit: "bag", createdAt: "2026-10-01T10:00:00.000Z" });
      const sale = ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: 4000000, customer: "Ada", item: "rice", quantity: 4, unit: "bag", createdAt: "2026-10-28T09:30:00.000Z" });
      assert.equal(profitForPeriod(ctx.ledger.list(SHOP), "today", { now: NOW }).salesKobo, 4000000);
      // Full refund: amount back to zero, quantity cleared so no cost lingers.
      ctx.ledger.appendCorrection(sale.id, { amountKobo: 0, quantity: null, createdAt: "2026-10-28T11:00:00.000Z" });
      const after = profitForPeriod(ctx.ledger.list(SHOP), "today", { now: NOW });
      assert.deepEqual([after.salesKobo, after.cogsKobo, after.estimatedProfitKobo], [0, 0, 0]);
      assert.equal(ctx.ledger.get(sale.id).amount_kobo, 4000000);
      assert.equal(ctx.ledger.verify(SHOP).ok, true);
    } finally {
      teardown(ctx);
    }
  });

  it("a Lagos midnight splits Sunday and Monday sales into different weeks", () => {
    const ctx = setup();
    try {
      // Lagos Sun 1 Nov 21:00 and Lagos Mon 2 Nov 00:30.
      ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: 1000000, customer: "Ada", createdAt: "2026-11-01T20:00:00.000Z" });
      ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: 2000000, customer: "Ada", createdAt: "2026-11-01T23:30:00.000Z" });
      const rows = ctx.ledger.list(SHOP);
      // Sunday 23:59 Lagos: this week holds Sunday's sale only.
      const sundayNight = profitForPeriod(rows, "week", { now: Date.UTC(2026, 10, 1, 22, 59, 0) });
      assert.deepEqual([sundayNight.from, sundayNight.to], ["2026-10-26", "2026-11-01"]);
      assert.equal(sundayNight.salesKobo, 1000000);
      // One minute later, Monday 00:00 Lagos: a new week holds Monday's sale only.
      const mondayMorning = profitForPeriod(rows, "week", { now: Date.UTC(2026, 10, 1, 23, 0, 0) });
      assert.deepEqual([mondayMorning.from, mondayMorning.to], ["2026-11-02", "2026-11-08"]);
      assert.equal(mondayMorning.salesKobo, 2000000);
    } finally {
      teardown(ctx);
    }
  });
});

describe("expenses listing", () => {
  it("lists effective expenses in the period with a category breakdown", () => {
    const ctx = setup();
    try {
      ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 500000, customer: "NEPA", item: "power", createdAt: "2026-10-28T06:00:00.000Z" });
      ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 200000, customer: "Danfo", item: "transport", createdAt: "2026-10-28T07:00:00.000Z" });
      ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 300000, customer: SHOP, item: "transport", createdAt: "2026-10-28T08:00:00.000Z" });
      const stale = ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 9000000, customer: "NEPA", item: "power", createdAt: "2026-10-28T05:00:00.000Z" });
      ctx.ledger.appendCorrection(stale.id, { amountKobo: 100000, createdAt: "2026-10-28T05:30:00.000Z" });
      // Yesterday and another shop stay out.
      ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 8000000, customer: "NEPA", item: "power", createdAt: "2026-10-27T06:00:00.000Z" });
      ctx.ledger.append({ shopId: OTHER_SHOP, type: "expense", amountKobo: 7000000, customer: "NEPA", item: "power", createdAt: "2026-10-28T06:00:00.000Z" });
      // Sales and payments are not expenses.
      ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: 6000000, customer: "Ada", createdAt: "2026-10-28T09:00:00.000Z" });

      const out = expensesForPeriod(ctx.ledger.list(SHOP), "today", { now: NOW });
      assert.deepEqual(
        out.expenses.map((e) => [e.category, e.payee, e.amountKobo]),
        [
          ["power", "NEPA", 100000],
          ["power", "NEPA", 500000],
          ["transport", "Danfo", 200000],
          ["transport", SHOP, 300000],
        ]
      );
      assert.ok(out.expenses.every((e) => Number.isInteger(e.id) && typeof e.createdAt === "string"));
      assert.deepEqual(out.byCategory, [
        { category: "power", amountKobo: 600000 },
        { category: "transport", amountKobo: 500000 },
      ]);
    } finally {
      teardown(ctx);
    }
  });
});

describe("expense messages", () => {
  it("the confirm card and saved reply show the expense", async () => {
    const ctx = setup();
    try {
      const proposal = await proposeExpense(ctx, expenseReading());
      const card = renderProposalCard(proposal, { existing: [], shopId: SHOP });
      assert.match(card.text, /🧾 Power: \*₦5,000\*/);
      const out = confirmProposal(proposal.id, SHOP, { proposals: ctx.proposals, ledger: ctx.ledger });
      const saved = renderSavedReply({ recorded: ctx.ledger.list(SHOP).filter((r) => out.recordedIds.includes(r.id)), existing: [] });
      assert.match(saved, /\*NEPA\*: expense power \*₦5,000\*/);
    } finally {
      teardown(ctx);
    }
  });
});

describe("profit and expenses routes", () => {
  // Seeds against the wall clock so period=today always matches.
  function seedToday(ctx) {
    const stamp = new Date().toISOString();
    ctx.ledger.append({ shopId: SHOP, type: "restock", amountKobo: 6000000, customer: SHOP, item: "rice", quantity: 10, unit: "bag", createdAt: stamp });
    ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: 4000000, customer: "Ada", item: "rice", quantity: 4, unit: "bag", createdAt: stamp });
    ctx.ledger.append({ shopId: SHOP, type: "payment", amountKobo: 1000000, customer: "Ada", createdAt: stamp });
    ctx.ledger.append({ shopId: SHOP, type: "expense", amountKobo: 500000, customer: "NEPA", item: "power", createdAt: stamp });
    ctx.ledger.append({ shopId: OTHER_SHOP, type: "sale", amountKobo: 99000000, customer: "Zed", createdAt: stamp });
    ctx.ledger.append({ shopId: OTHER_SHOP, type: "expense", amountKobo: 88000000, customer: "Zed", item: "rent", createdAt: stamp });
  }

  it("GET /profit returns exactly the specified shape, this shop only", async () => {
    const ctx = setup();
    try {
      seedToday(ctx);
      const deps = { ledger: ctx.ledger, auths: ctx.auths };
      const out = await dispatch(deps, { url: "/profit?period=today", headers: { "x-shop-id": SHOP } });
      assert.equal(out.status, 200);
      assert.deepEqual(
        Object.keys(out.json).sort(),
        ["cogsKobo", "collectedKobo", "estimatedProfitKobo", "expensesKobo", "from", "itemsWithoutCost", "missing_cost_items", "owedKobo", "period", "result", "resultKobo", "salesKobo", "series", "to"]
      );
      assert.equal(out.json.period, "today");
      assert.equal(out.json.salesKobo, 4000000);
      assert.equal(out.json.collectedKobo, 1000000);
      assert.equal(out.json.cogsKobo, 2400000);
      assert.equal(out.json.expensesKobo, 500000);
      assert.equal(out.json.estimatedProfitKobo, 1100000);
      assert.equal(out.json.result, "profit");
      assert.equal(out.json.resultKobo, 1100000);
      assert.equal(out.json.owedKobo, 3000000);
      assert.equal(out.json.itemsWithoutCost, 0);
      assert.equal(out.json.missing_cost_items, 0);
      assert.equal(out.json.series.length, 24);
      assert.deepEqual(Object.keys(out.json.series[0]).sort(), ["cogsKobo", "expensesKobo", "label", "profitKobo", "salesKobo"]);

      const other = await dispatch(deps, { url: "/profit?period=today", headers: { "x-shop-id": OTHER_SHOP } });
      assert.equal(other.json.salesKobo, 99000000);
      assert.equal(other.json.expensesKobo, 88000000);
    } finally {
      teardown(ctx);
    }
  });

  it("GET /profit defaults a missing period to today and rejects bad ones", async () => {
    const ctx = setup();
    try {
      seedToday(ctx);
      const deps = { ledger: ctx.ledger, auths: ctx.auths };
      const bare = await dispatch(deps, { url: "/profit", headers: { "x-shop-id": SHOP } });
      assert.equal(bare.status, 200);
      assert.equal(bare.json.period, "today");
      const bad = await dispatch(deps, { url: "/profit?period=fortnight", headers: { "x-shop-id": SHOP } });
      assert.equal(bad.status, 400);
      assert.match(bad.json.error, /unknown period/);
    } finally {
      teardown(ctx);
    }
  });

  it("GET /expenses returns exactly the specified shape, this shop only", async () => {
    const ctx = setup();
    try {
      seedToday(ctx);
      const deps = { ledger: ctx.ledger, auths: ctx.auths };
      const out = await dispatch(deps, { url: "/expenses?period=today", headers: { "x-shop-id": SHOP } });
      assert.equal(out.status, 200);
      assert.deepEqual(Object.keys(out.json).sort(), ["byCategory", "expenses"]);
      assert.deepEqual(out.json.expenses, [
        { id: out.json.expenses[0].id, createdAt: out.json.expenses[0].createdAt, category: "power", payee: "NEPA", amountKobo: 500000 },
      ]);
      assert.deepEqual(Object.keys(out.json.expenses[0]).sort(), ["amountKobo", "category", "createdAt", "id", "payee"]);
      assert.deepEqual(out.json.byCategory, [{ category: "power", amountKobo: 500000 }]);

      const other = await dispatch(deps, { url: "/expenses?period=today", headers: { "x-shop-id": OTHER_SHOP } });
      assert.deepEqual(other.json.byCategory, [{ category: "rent", amountKobo: 88000000 }]);

      const bad = await dispatch(deps, { url: "/expenses?period=someday", headers: { "x-shop-id": SHOP } });
      assert.equal(bad.status, 400);
    } finally {
      teardown(ctx);
    }
  });

  it("the webhook port 404s both routes", async () => {
    const ctx = setup();
    try {
      const deps = { ledger: ctx.ledger, auths: ctx.auths };
      const headers = { "x-shop-id": SHOP };
      assert.equal((await dispatchOnly(deps, { url: "/profit?period=today", headers })).status, 404);
      assert.equal((await dispatchOnly(deps, { url: "/expenses?period=today", headers })).status, 404);
    } finally {
      teardown(ctx);
    }
  });
});

describe("profit card", () => {
  const RESULT = {
    period: "today",
    from: "2026-10-28",
    to: "2026-10-28",
    salesKobo: 6200000,
    collectedKobo: 2000000,
    cogsKobo: 2800000,
    expensesKobo: 500000,
    estimatedProfitKobo: 2900000,
    result: "profit",
    resultKobo: 2900000,
    owedKobo: 4200000,
    itemsWithoutCost: 1,
    missing_cost_items: 1,
    series: [],
  };

  it("renders every figure with Sales, Collected, Cost of goods, Expenses, Profit, Owed", () => {
    assert.equal(
      renderProfit(RESULT),
      "💵 *Profit today*\nSales *₦62,000*\nCollected *₦20,000*\nCost of goods *₦28,000*\nExpenses *₦5,000*\nProfit: *₦29,000*\nOwed to you: *₦42,000*\ncost missing for 1 items, so this may be too high"
    );
  });

  it("titles week and month cards and skips the cost line at zero", () => {
    const week = renderProfit({ ...RESULT, period: "week", itemsWithoutCost: 0, missing_cost_items: 0 });
    assert.match(week, /\*Profit this week\*/);
    assert.ok(!week.includes("cost missing"), week);
    assert.match(
      renderProfit({ ...RESULT, period: "month", itemsWithoutCost: 3, missing_cost_items: 3 }),
      /cost missing for 3 items, so this may be too high/
    );
  });

  it("a loss renders as Loss with a positive amount, never a negative profit", () => {
    const text = renderProfit({ ...RESULT, salesKobo: 100000000, collectedKobo: 0, cogsKobo: 90000000, expensesKobo: 20000000, estimatedProfitKobo: -10000000, result: "loss", resultKobo: 10000000, owedKobo: 100000000, itemsWithoutCost: 12, missing_cost_items: 12 });
    assert.match(text, /Loss: \*₦100,000\*/);
    assert.ok(!text.includes("-₦"), text);
    assert.ok(!/Profit:/.test(text), text);
    assert.ok(text.length <= MAX_BODY_CHARS, text.length);
  });

  it("break-even renders as zero profit", () => {
    const text = renderProfit({ ...RESULT, estimatedProfitKobo: 0, result: "break_even", resultKobo: 0 });
    assert.match(text, /Profit: \*₦0\*/);
    assert.ok(!text.includes("-₦"), text);
  });
});
