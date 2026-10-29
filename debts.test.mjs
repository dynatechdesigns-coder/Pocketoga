import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { createMockModelClient } from "./model.mjs";
import { propose, fixProposal, confirmProposal } from "./voice.mjs";
import {
  lagosDay,
  addDays,
  daysBetween,
  effectiveEntries,
  customerDebts,
  owingDebts,
  chaseScore,
  rankChase,
} from "./debts.mjs";
import { PromiseStore, resolvePromiseDate, promiseStatus, promisePaidKobo, refreshPromises, keptRate } from "./promises.mjs";
import { moneyLeakReport } from "./leak.mjs";
import {
  MAX_BODY_CHARS,
  renderProposalCard,
  formatDueDay,
  promiseCardLine,
  renderWhoOwes,
  renderChase,
  draftReminder,
  renderBalance,
  unknownCustomer,
  dueTodayLines,
  renderReport,
} from "./messages.mjs";

// Fake fixtures only. Fixed clock: Wed 28 Oct 2026, 12:00 UTC (13:00 Lagos).
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

function seed(rows) {
  const ledger = new Ledger(":memory:");
  for (const r of rows) ledger.append(r);
  return ledger;
}

describe("debts core (fake data)", () => {
  it("lagos calendar helpers", () => {
    assert.equal(lagosDay(NOW), "2026-10-28");
    assert.equal(addDays("2026-10-28", 1), "2026-10-29");
    assert.equal(addDays("2026-10-28", -28), "2026-09-30");
    assert.equal(daysBetween("2026-10-18", "2026-10-28"), 10);
    assert.equal(daysBetween("2026-10-28", "2026-10-28"), 0);
  });

  it("balances with part payments, case-insensitive names and corrections", () => {
    const ledger = seed([
      { shopId: "shop-a", type: "sale", amountKobo: 1500000, customer: "Ada", item: "fake-rice", quantity: 2, unit: "bag", createdAt: daysAgo(10) },
      { shopId: "shop-a", type: "payment", amountKobo: 1000000, customer: "ada", createdAt: daysAgo(5) },
    ]);
    try {
      const original = ledger.append({
        shopId: "shop-a", type: "sale", amountKobo: 2000000, customer: "Bola",
        item: "fake-beans", quantity: 1, unit: "bag", createdAt: daysAgo(8),
      });
      ledger.appendCorrection(original.id, { amountKobo: 1200000 });
      ledger.append({ shopId: "shop-a", type: "payment", amountKobo: 1000000, customer: "Bola", createdAt: daysAgo(2) });

      const debts = customerDebts(ledger.list("shop-a"), { now: NOW });
      const ada = debts.find((d) => d.customer === "Ada");
      assert.equal(ada.owedKobo, 500000);
      assert.equal(ada.salesKobo, 1500000);
      assert.equal(ada.paidKobo, 1000000);
      assert.equal(ada.oldestUnpaidAgeDays, 10);
      assert.equal(ada.lastPaymentAt, daysAgo(5));

      // The corrected sale counts at 12k, not 20k.
      const bola = debts.find((d) => d.customer === "Bola");
      assert.equal(bola.owedKobo, 200000);
      assert.equal(bola.salesKobo, 1200000);
    } finally {
      ledger.close();
    }
  });

  it("payments apply to the oldest unpaid sale first", () => {
    const ledger = seed([
      { shopId: "shop-a", type: "sale", amountKobo: 1000000, customer: "Chidi", createdAt: daysAgo(20) },
      { shopId: "shop-a", type: "sale", amountKobo: 1000000, customer: "Chidi", createdAt: daysAgo(5) },
      { shopId: "shop-a", type: "payment", amountKobo: 1200000, customer: "Chidi", createdAt: daysAgo(1) },
      { shopId: "shop-a", type: "sale", amountKobo: 500000, customer: "Tunde", createdAt: daysAgo(3) },
      { shopId: "shop-a", type: "payment", amountKobo: 500000, customer: "Tunde", createdAt: daysAgo(1) },
    ]);
    try {
      const debts = customerDebts(ledger.list("shop-a"), { now: NOW });
      const chidi = debts.find((d) => d.customer === "Chidi");
      assert.equal(chidi.owedKobo, 800000);
      assert.equal(chidi.oldestUnpaidAgeDays, 5);
      assert.equal(chidi.oldestUnpaidAt, daysAgo(5));
      assert.equal(chidi.lastPaymentAt, daysAgo(1));

      // Settled in full: nothing unpaid, last payment still reported.
      const tunde = debts.find((d) => d.customer === "Tunde");
      assert.equal(tunde.owedKobo, 0);
      assert.equal(tunde.oldestUnpaidAgeDays, null);
      assert.equal(tunde.oldestUnpaidAt, null);
      assert.equal(tunde.lastPaymentAt, daysAgo(1));

      // owingDebts keeps debtors only, biggest first.
      assert.deepEqual(
        owingDebts(ledger.list("shop-a"), { now: NOW }).map((d) => d.customer),
        ["Chidi"]
      );
    } finally {
      ledger.close();
    }
  });

  it("corrections supersede the original and earlier sibling corrections", () => {
    const ledger = new Ledger(":memory:");
    try {
      const o = ledger.append({ shopId: "shop-a", type: "sale", amountKobo: 1000000, customer: "Ada", createdAt: daysAgo(9) });
      const c1 = ledger.appendCorrection(o.id, { amountKobo: 2000000 });
      assert.deepEqual(effectiveEntries(ledger.list("shop-a")).map((e) => e.amount_kobo), [2000000]);
      // A second correction of the same original wins; the first no longer counts.
      ledger.append({ shopId: "shop-a", type: "correction", amountKobo: 3000000, customer: "Ada", correctsId: o.id, createdAt: daysAgo(1) });
      assert.deepEqual(
        effectiveEntries(ledger.list("shop-a")).map((e) => e.amount_kobo),
        [3000000]
      );
      assert.equal(c1.corrects_id, o.id);
    } finally {
      ledger.close();
    }
  });

  it("chase ranking orders by score, then owed, then name", () => {
    assert.equal(chaseScore({ owedKobo: 2000000, ageDays: 5, broken: 1 }), 5 * 10 + 1 * 500 + 20);
    assert.equal(chaseScore({ owedKobo: 50000, ageDays: 0, broken: 0 }), 0);
    const ranked = rankChase([
      { customer: "Bola", owedKobo: 5000000, ageDays: 2, broken: 0 },
      { customer: "Ada", owedKobo: 2000000, ageDays: 5, broken: 1 },
      { customer: "Chidi", owedKobo: 500000, ageDays: 30, broken: 0 },
      { customer: "Settled", owedKobo: 0, ageDays: null, broken: 2 },
    ]);
    assert.deepEqual(
      ranked.map((r) => r.customer),
      ["Ada", "Chidi", "Bola"]
    );
    assert.ok(ranked[0].score > ranked[1].score && ranked[1].score > ranked[2].score);

    // Tie on score: bigger debt first, then name order.
    const tied = rankChase([
      { customer: "Zed", owedKobo: 1000000, ageDays: 1, broken: 0 },
      { customer: "Amy", owedKobo: 1000000, ageDays: 1, broken: 0 },
      { customer: "Big", owedKobo: 2000000, ageDays: 0, broken: 0 },
    ]);
    assert.deepEqual(
      tied.map((r) => r.customer),
      ["Big", "Amy", "Zed"]
    );
  });
});

describe("promises (fake data, clock fixed at Wed 28 Oct 2026 Lagos)", () => {
  it("stores, lists and resolves promises per shop", () => {
    const store = new PromiseStore(":memory:");
    try {
      const p = store.create({ shopId: "shop-a", customer: "Ada", amountKobo: 2000000, dueDate: "2026-10-30" });
      assert.equal(p.status, "open");
      assert.equal(p.resolved_at, null);
      assert.equal(store.get(p.id).customer, "Ada");
      store.create({ shopId: "shop-b", customer: "Ada", dueDate: "2026-10-30" });
      assert.equal(store.listByShop("shop-a").length, 1);
      assert.equal(store.listOpenByShop("shop-a").length, 1);
      const kept = store.resolve(p.id, { status: "kept", resolvedAt: "2026-10-29T00:00:00.000Z" });
      assert.equal(kept.status, "kept");
      assert.equal(store.listOpenByShop("shop-a").length, 0);
      assert.throws(() => store.resolve(p.id, { status: "open" }), /cannot resolve/);
      assert.throws(
        () => store.create({ shopId: "shop-a", customer: "Ada", dueDate: "2026-10-30", amountKobo: -5 }),
        /amount_kobo/
      );
      assert.throws(() => store.create({ shopId: "shop-a", customer: "Ada", dueDate: "tomorrow" }), /due_date/);
      assert.throws(() => store.create({ shopId: "shop-a", customer: "Ada", dueDate: "2026-02-30" }), /due_date/);
      assert.throws(() => store.create({ shopId: "shop-a", customer: "  ", dueDate: "2026-10-30" }), /customer/);
    } finally {
      store.close();
    }
  });

  it("migrates pre-paid_kobo databases", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE promises (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        customer TEXT NOT NULL,
        amount_kobo INTEGER,
        due_date TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      )`);
      db.prepare(
        "INSERT INTO promises (shop_id, customer, amount_kobo, due_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("shop-a", "Ada", 2000000, "2026-10-30", "open", "2026-10-28T00:00:00.000Z");
      const store = new PromiseStore(db);
      const columns = db.prepare("PRAGMA table_info(promises)").all().map((c) => c.name);
      assert.ok(columns.includes("paid_kobo"));
      assert.equal(store.listByShop("shop-a")[0].paid_kobo, null);
      store.close();
    } finally {
      db.close();
    }
  });

  it("resolves confident day-phrases in Lagos time", () => {
    assert.equal(resolvePromiseDate("today", NOW), "2026-10-28");
    assert.equal(resolvePromiseDate("Tomorrow", NOW), "2026-10-29");
    assert.equal(resolvePromiseDate("friday", NOW), "2026-10-30");
    assert.equal(resolvePromiseDate("Fri", NOW), "2026-10-30");
    assert.equal(resolvePromiseDate("monday", NOW), "2026-11-02");
    // A bare weekday never means today, even on that weekday.
    assert.equal(resolvePromiseDate("wednesday", NOW), "2026-11-04");
    assert.equal(resolvePromiseDate("on friday", NOW), "2026-10-30");
    assert.equal(resolvePromiseDate("by monday morning", NOW), "2026-11-02");
    assert.equal(resolvePromiseDate("next week", NOW), "2026-11-02");
    assert.equal(resolvePromiseDate("end of month", NOW), "2026-10-31");
    assert.equal(resolvePromiseDate("end of the month", NOW), "2026-10-31");
  });

  it("ambiguous phrases resolve to null so the trader is asked", () => {
    for (const phrase of ["next friday", "this friday", "someday", "", "31st", "end of week", "friday the 13th", "whenever"]) {
      assert.equal(resolvePromiseDate(phrase, NOW), null, JSON.stringify(phrase));
    }
  });

  it("marks promises kept, broken or still open from ledger payments", () => {
    const ledger = seed([
      { shopId: "shop-a", type: "payment", amountKobo: 2000000, customer: "Ada", createdAt: daysAgo(8) },
      { shopId: "shop-a", type: "payment", amountKobo: 500000, customer: "Bola", createdAt: daysAgo(8) },
    ]);
    const store = new PromiseStore(":memory:");
    try {
      const rows = ledger.list("shop-a");
      const today = lagosDay(NOW);
      // Promises created a day before the payments, so the payments count.
      const made = daysAgo(9);
      // Paid in full before the due date: kept.
      assert.equal(
        promiseStatus({ customer: "Ada", amount_kobo: 2000000, due_date: "2026-10-25", created_at: made }, rows, today),
        "kept"
      );
      // No amount promised: any payment before the due date keeps it.
      assert.equal(
        promiseStatus({ customer: "Bola", amount_kobo: null, due_date: "2026-10-25", created_at: made }, rows, today),
        "kept"
      );
      // Part-payment only with the date still ahead: still open.
      assert.equal(
        promiseStatus({ customer: "Bola", amount_kobo: 2000000, due_date: "2026-11-05", created_at: made }, rows, today),
        "open"
      );
      // Part-payment only with the date passed: broken, and the paid part recorded.
      assert.equal(
        promiseStatus({ customer: "Bola", amount_kobo: 2000000, due_date: "2026-10-25", created_at: made }, rows, today),
        "broken"
      );
      assert.equal(promisePaidKobo({ customer: "Bola", due_date: "2026-10-25", created_at: made }, rows), 500000);
      assert.equal(promisePaidKobo({ customer: "Nobody", due_date: "2026-10-25", created_at: made }, rows), 0);
      // Nothing paid and the date has passed: broken.
      assert.equal(
        promiseStatus({ customer: "Chidi", amount_kobo: 1000000, due_date: "2026-10-20", created_at: made }, rows, today),
        "broken"
      );
      // Due in the future: open.
      assert.equal(
        promiseStatus({ customer: "Chidi", amount_kobo: 1000000, due_date: "2026-11-05", created_at: made }, rows, today),
        "open"
      );

      // refreshPromises persists the transitions with resolved_at and the paid part.
      const keep = store.create({ shopId: "shop-a", customer: "Ada", amountKobo: 2000000, dueDate: "2026-10-25", createdAt: made });
      const broke = store.create({ shopId: "shop-a", customer: "Chidi", amountKobo: 1000000, dueDate: "2026-10-20", createdAt: made });
      const partial = store.create({ shopId: "shop-a", customer: "Bola", amountKobo: 2000000, dueDate: "2026-10-25", createdAt: made });
      const open = store.create({ shopId: "shop-a", customer: "Chidi", amountKobo: 1000000, dueDate: "2026-11-05", createdAt: made });
      const done = refreshPromises(store, ledger, "shop-a", { now: NOW });
      assert.deepEqual(done, [
        { id: keep.id, to: "kept" },
        { id: broke.id, to: "broken" },
        { id: partial.id, to: "broken" },
      ]);
      assert.equal(store.get(keep.id).status, "kept");
      assert.equal(store.get(keep.id).resolved_at, new Date(NOW).toISOString());
      assert.equal(store.get(keep.id).paid_kobo, 2000000);
      assert.equal(store.get(broke.id).status, "broken");
      assert.equal(store.get(broke.id).paid_kobo, 0);
      assert.equal(store.get(partial.id).status, "broken");
      assert.equal(store.get(partial.id).paid_kobo, 500000);
      assert.equal(store.get(open.id).status, "open");
      assert.equal(store.get(open.id).paid_kobo, null);
      // Second refresh changes nothing: resolved promises are never reprocessed.
      assert.deepEqual(refreshPromises(store, ledger, "shop-a", { now: NOW }), []);
    } finally {
      store.close();
      ledger.close();
    }
  });

  it("only payments after creation and on or before the due date count", () => {
    const ledger = seed([
      { shopId: "shop-a", type: "payment", amountKobo: 2000000, customer: "Ada", createdAt: "2026-10-18T12:00:00.000Z" },
      { shopId: "shop-a", type: "payment", amountKobo: 500000, customer: "Ada", createdAt: "2026-10-20T12:00:00.000Z" },
      { shopId: "shop-a", type: "payment", amountKobo: 2000000, customer: "Ada", createdAt: "2026-10-27T12:00:00.000Z" },
      { shopId: "shop-a", type: "payment", amountKobo: 2000000, customer: "Bola", createdAt: "2026-10-27T12:00:00.000Z" },
      { shopId: "shop-a", type: "payment", amountKobo: 500000, customer: "Chidi", createdAt: "2026-10-20T12:00:00.000Z" },
    ]);
    try {
      const rows = ledger.list("shop-a");
      const today = lagosDay(NOW);
      const made = "2026-10-19T12:00:00.000Z";
      // Only the middle payment falls inside the window.
      assert.equal(
        promisePaidKobo({ customer: "Ada", due_date: "2026-10-25", created_at: made }, rows),
        500000
      );
      // Part in the window, date passed: broken.
      assert.equal(
        promiseStatus({ customer: "Ada", amount_kobo: 2000000, due_date: "2026-10-25", created_at: made }, rows, today),
        "broken"
      );
      // Part in the window, date ahead: open.
      assert.equal(
        promiseStatus({ customer: "Chidi", amount_kobo: 2000000, due_date: "2026-11-05", created_at: made }, rows, today),
        "open"
      );
      // A full payment after the due date never makes it kept.
      assert.equal(
        promiseStatus({ customer: "Bola", amount_kobo: 2000000, due_date: "2026-10-20", created_at: made }, rows, today),
        "broken"
      );
      assert.equal(promisePaidKobo({ customer: "Bola", due_date: "2026-10-20", created_at: made }, rows), 0);
    } finally {
      ledger.close();
    }
  });

  it("kept-rate and the leak report follow resolution", () => {
    const ledger = seed([
      { shopId: "shop-a", type: "payment", amountKobo: 500000, customer: "Ada", createdAt: daysAgo(8) },
    ]);
    const store = new PromiseStore(":memory:");
    try {
      store.create({ shopId: "shop-a", customer: "Ada", amountKobo: 2000000, dueDate: "2026-10-25", createdAt: daysAgo(9) });
      refreshPromises(store, ledger, "shop-a", { now: NOW });
      const promises = store.listByShop("shop-a");
      assert.deepEqual(keptRate(promises, "Ada"), { kept: 0, total: 1, rate: 0 });
      assert.deepEqual(moneyLeakReport(ledger.list("shop-a"), promises, { now: NOW }).broken, {
        count: 1,
        amountKobo: 1500000,
      });
    } finally {
      store.close();
      ledger.close();
    }
  });

  it("kept-rate counts kept over resolved, per customer", () => {
    const promises = [
      { customer: "Ada", status: "kept" },
      { customer: "ada", status: "kept" },
      { customer: "Ada", status: "broken" },
      { customer: "Ada", status: "open" },
      { customer: "Ada", status: "cancelled" },
      { customer: "Bola", status: "broken" },
    ];
    assert.deepEqual(keptRate(promises, "Ada"), { kept: 2, total: 3, rate: 2 / 3 });
    assert.deepEqual(keptRate(promises, "Bola"), { kept: 0, total: 1, rate: 0 });
    assert.equal(keptRate(promises, "Nobody"), null);
  });
});

describe("money leak report (fake data, clock fixed at Wed 28 Oct 2026 Lagos)", () => {
  function reportOf(rows, promises = []) {
    const ledger = seed(rows);
    try {
      return moneyLeakReport(ledger.list("shop-a"), promises, { now: NOW });
    } finally {
      ledger.close();
    }
  }

  it("totals owed and isolates the 30+ day overdue part via oldest-first allocation", () => {
    const report = reportOf([
      // Old sale fully covered by the payment: nothing overdue here.
      { shopId: "shop-a", type: "sale", amountKobo: 1000000, customer: "Ada", createdAt: daysAgo(40) },
      { shopId: "shop-a", type: "sale", amountKobo: 1000000, customer: "Ada", createdAt: daysAgo(5) },
      { shopId: "shop-a", type: "payment", amountKobo: 1200000, customer: "Ada", createdAt: daysAgo(1) },
      // Old sale untouched: overdue.
      { shopId: "shop-a", type: "sale", amountKobo: 1000000, customer: "Bola", createdAt: daysAgo(40) },
      // Exactly 30 days is not overdue.
      { shopId: "shop-a", type: "sale", amountKobo: 1000000, customer: "Chidi", createdAt: daysAgo(30) },
    ]);
    assert.deepEqual(report.owed, { totalKobo: 2800000, customers: 3 });
    assert.deepEqual(report.overdue, { amountKobo: 1000000 });
  });

  it("counts broken promises with the outstanding amount", () => {
    const report = reportOf([], [
      { customer: "Ada", status: "broken", amount_kobo: 2000000, paid_kobo: 500000 },
      { customer: "Bola", status: "broken", amount_kobo: null, paid_kobo: 0 },
      { customer: "Chidi", status: "broken", amount_kobo: 1000000, paid_kobo: 1500000 },
      { customer: "Ada", status: "kept", amount_kobo: 500000, paid_kobo: 500000 },
      { customer: "Ada", status: "open", amount_kobo: 9000000, paid_kobo: null },
    ]);
    assert.deepEqual(report.broken, { count: 3, amountKobo: 1500000 });
  });

  it("lists items sold more than bought, grouped by lowercased item and unit", () => {
    const report = reportOf([
      { shopId: "shop-a", type: "restock", amountKobo: 1000000, customer: "shop-a", item: "Rice", unit: "Bag", quantity: 10, createdAt: daysAgo(9) },
      { shopId: "shop-a", type: "sale", amountKobo: 1200000, customer: "Ada", item: "rice", unit: "bag", quantity: 12, createdAt: daysAgo(8) },
      { shopId: "shop-a", type: "restock", amountKobo: 500000, customer: "shop-a", item: "Garri", quantity: 5, createdAt: daysAgo(9) },
      { shopId: "shop-a", type: "sale", amountKobo: 800000, customer: "Ada", item: "garri", quantity: 8, createdAt: daysAgo(8) },
      { shopId: "shop-a", type: "restock", amountKobo: 500000, customer: "shop-a", item: "oil", unit: "tin", quantity: 5, createdAt: daysAgo(9) },
      // Oil in bottles was never restocked: no shortfall line, counted instead.
      { shopId: "shop-a", type: "sale", amountKobo: 200000, customer: "Ada", item: "oil", unit: "bottle", quantity: 2, createdAt: daysAgo(8) },
      { shopId: "shop-a", type: "sale", amountKobo: 300000, customer: "Ada", createdAt: daysAgo(8) },
    ]);
    assert.deepEqual(report.shortfalls, [
      { display: "garri", item: "garri", unit: null, soldQty: 8, stockedQty: 5, shortfallQty: 3 },
      { display: "rice (bag)", item: "rice", unit: "bag", soldQty: 12, stockedQty: 10, shortfallQty: 2 },
    ]);
    assert.equal(report.noStockRecord, 1);
  });

  it("a new shop with sales and no restocks shows no shortfalls, only the count", () => {
    const report = reportOf([
      { shopId: "shop-a", type: "sale", amountKobo: 1200000, customer: "Ada", item: "rice", unit: "bag", quantity: 12, createdAt: daysAgo(8) },
      { shopId: "shop-a", type: "sale", amountKobo: 800000, customer: "Ada", item: "garri", quantity: 8, createdAt: daysAgo(8) },
    ]);
    assert.deepEqual(report.shortfalls, []);
    assert.equal(report.noStockRecord, 2);
  });

  it("flags below-cost sales with margin lost and counts items without history", () => {
    const report = reportOf([
      { shopId: "shop-a", type: "restock", amountKobo: 2000000, customer: "shop-a", item: "beans", unit: "tin", quantity: 10, createdAt: daysAgo(20) },
      { shopId: "shop-a", type: "restock", amountKobo: 3000000, customer: "shop-a", item: "beans", unit: "tin", quantity: 10, createdAt: daysAgo(10) },
      { shopId: "shop-a", type: "sale", amountKobo: 600000, customer: "Ada", item: "beans", unit: "tin", quantity: 4, createdAt: daysAgo(5) },
      { shopId: "shop-a", type: "sale", amountKobo: 600000, customer: "Ada", item: "beans", unit: "tin", quantity: 2, createdAt: daysAgo(4) },
      { shopId: "shop-a", type: "sale", amountKobo: 300000, customer: "Ada", item: "pepper", unit: "tin", quantity: 3, createdAt: daysAgo(5) },
      { shopId: "shop-a", type: "restock", amountKobo: 400000, customer: "shop-a", item: "salt", unit: "tin", quantity: 5, createdAt: daysAgo(5) },
    ]);
    // Weighted average cost is (2M + 3M) / 20 = 250k per tin; the 4-tin sale
    // at 150k each loses (250k - 150k) x 4 = 400k. Pepper has no restocks.
    assert.deepEqual(report.belowCost, {
      items: [{ display: "beans (tin)", item: "beans", unit: "tin", marginKobo: 400000 }],
      skippedItems: 1,
    });
  });

  it("corrections flow through the whole report", () => {
    const ledger = new Ledger(":memory:");
    try {
      const restock = ledger.append({ shopId: "shop-a", type: "restock", amountKobo: 500000, customer: "shop-a", item: "rice", unit: "bag", quantity: 5, createdAt: daysAgo(9) });
      ledger.appendCorrection(restock.id, { amountKobo: 1000000, quantity: 10 });
      ledger.append({ shopId: "shop-a", type: "sale", amountKobo: 800000, customer: "Ada", item: "rice", unit: "bag", quantity: 8, createdAt: daysAgo(8) });
      const sale = ledger.append({ shopId: "shop-a", type: "sale", amountKobo: 2000000, customer: "Ada", createdAt: daysAgo(8) });
      ledger.appendCorrection(sale.id, { amountKobo: 1200000 });
      ledger.append({ shopId: "shop-a", type: "payment", amountKobo: 1000000, customer: "Ada", createdAt: daysAgo(1) });
      const report = moneyLeakReport(ledger.list("shop-a"), [], { now: NOW });
      assert.deepEqual(report.shortfalls, []);
      assert.equal(report.owed.totalKobo, 1000000);
    } finally {
      ledger.close();
    }
  });

  it("renders the full report with top 3 lists", () => {
    const text = renderReport({
      owed: { totalKobo: 5000000, customers: 3 },
      overdue: { amountKobo: 1200000 },
      broken: { count: 2, amountKobo: 800000 },
      shortfalls: [
        { display: "rice (bag)", shortfallQty: 5 },
        { display: "yam (tuber)", shortfallQty: 3 },
        { display: "beans (tin)", shortfallQty: 2 },
        { display: "garri", shortfallQty: 1 },
      ],
      noStockRecord: 2,
      belowCost: { items: [{ display: "beans (tin)", marginKobo: 120000 }], skippedItems: 1 },
    });
    assert.equal(
      text,
      `⚠️ *Money check*\n⚖️ Owed *₦50,000* (3 customers), *₦12,000* over 30 days\n🤝 2 broken promises (*₦8,000* at risk)\n📦 Sold more than bought:\nrice (bag): short 5\nyam (tuber): short 3\nbeans (tin): short 2\n+1 more\nNo stock record for 2 items.\n💵 Margin lost on below-cost sales:\nbeans (tin): *₦1,200*`
    );
  });

  it("shows a quiet no-stock-record line only when the count is above zero", () => {
    const base = {
      owed: { totalKobo: 0, customers: 0 },
      overdue: { amountKobo: 0 },
      broken: { count: 0, amountKobo: 0 },
      shortfalls: [],
      belowCost: { items: [], skippedItems: 0 },
    };
    assert.ok(renderReport({ ...base, noStockRecord: 2 }).includes("No stock record for 2 items."));
    assert.ok(renderReport({ ...base, noStockRecord: 1 }).includes("No stock record for 1 item."));
    assert.ok(!renderReport({ ...base, noStockRecord: 0 }).includes("No stock record"));
  });

  it("report emojis: warning header only on attention, none repeated", () => {
    const attention = renderReport({
      owed: { totalKobo: 5000000, customers: 3 },
      overdue: { amountKobo: 1200000 },
      broken: { count: 2, amountKobo: 800000 },
      shortfalls: [{ display: "rice (bag)", shortfallQty: 5 }],
      noStockRecord: 1,
      belowCost: { items: [{ display: "beans (tin)", marginKobo: 120000 }], skippedItems: 0 },
    });
    for (const emoji of ["⚠️", "⚖️", "🤝", "📦", "💵"]) {
      assert.equal(attention.split(emoji).length - 1, 1, emoji);
    }
    const clear = renderReport({
      owed: { totalKobo: 0, customers: 0 },
      overdue: { amountKobo: 0 },
      broken: { count: 0, amountKobo: 0 },
      shortfalls: [],
      noStockRecord: 0,
      belowCost: { items: [], skippedItems: 0 },
    });
    assert.ok(!clear.includes("⚠️"));
    assert.ok(clear.includes("Nothing alarming yet."));
  });

  it("renders partial lines and the all-clear", () => {
    assert.equal(
      renderReport({
        owed: { totalKobo: 100000, customers: 1 },
        overdue: { amountKobo: 0 },
        broken: { count: 1, amountKobo: 0 },
        shortfalls: [],
        belowCost: { items: [], skippedItems: 0 },
      }),
      `⚠️ *Money check*\n⚖️ Owed *₦1,000* (1 customer)\n🤝 1 broken promise`
    );
    assert.equal(
      renderReport({
        owed: { totalKobo: 0, customers: 0 },
        overdue: { amountKobo: 0 },
        broken: { count: 0, amountKobo: 0 },
        shortfalls: [],
        belowCost: { items: [], skippedItems: 4 },
      }),
      `*Money check*\n\nNothing alarming yet.`
    );
  });

  it("report message never exceeds 1024 characters", () => {
    const long = "item-" + "x".repeat(120);
    const shortfalls = Array.from({ length: 30 }, (_, i) => ({ display: `${long}-${i} (bag)`, shortfallQty: i + 1 }));
    const items = Array.from({ length: 30 }, (_, i) => ({ display: `${long}-${i} (tin)`, marginKobo: (i + 1) * 100000 }));
    const text = renderReport({
      owed: { totalKobo: 999999900, customers: 99 },
      overdue: { amountKobo: 888888800 },
      broken: { count: 99, amountKobo: 777777700 },
      shortfalls,
      belowCost: { items, skippedItems: 9 },
    });
    assert.ok(text.length <= MAX_BODY_CHARS, `report is ${text.length} chars`);
    assert.ok(text.startsWith("⚠️ *Money check*"));
  });

  it("today's totals count only entries recorded today in Lagos time", () => {
    const report = reportOf([
      { shopId: "shop-a", type: "sale", amountKobo: 2000000, customer: "Ada", createdAt: new Date(NOW).toISOString() },
      { shopId: "shop-a", type: "sale", amountKobo: 999900, customer: "Ada", createdAt: daysAgo(1) },
      // 00:30 Lagos today, though still yesterday in UTC: included.
      { shopId: "shop-a", type: "sale", amountKobo: 100000, customer: "Ada", createdAt: "2026-10-28T00:30:00+01:00" },
      // 23:30 Lagos yesterday, though already today in UTC: excluded.
      { shopId: "shop-a", type: "sale", amountKobo: 100000, customer: "Ada", createdAt: "2026-10-27T23:30:00+01:00" },
      { shopId: "shop-a", type: "payment", amountKobo: 500000, customer: "Ada", createdAt: new Date(NOW).toISOString() },
      { shopId: "shop-a", type: "payment", amountKobo: 400000, customer: "Ada", createdAt: daysAgo(1) },
      { shopId: "shop-a", type: "restock", amountKobo: 700000, customer: "shop-a", createdAt: new Date(NOW).toISOString() },
    ]);
    assert.deepEqual(report.today, { soldTodayKobo: 2100000, collectedTodayKobo: 500000, entriesToday: 3 });
  });

  it("today's totals respect corrections", () => {
    const ledger = new Ledger(":memory:");
    try {
      const sale = ledger.append({ shopId: "shop-a", type: "sale", amountKobo: 2000000, customer: "Ada", createdAt: new Date(NOW).toISOString() });
      // Raw correction with a fixed stamp (appendCorrection always stamps now).
      ledger.append({ shopId: "shop-a", type: "correction", amountKobo: 1200000, customer: "Ada", correctsId: sale.id, createdAt: new Date(NOW).toISOString() });
      const payment = ledger.append({ shopId: "shop-a", type: "payment", amountKobo: 500000, customer: "Ada", createdAt: new Date(NOW).toISOString() });
      ledger.append({ shopId: "shop-a", type: "correction", amountKobo: 300000, customer: "Ada", correctsId: payment.id, createdAt: new Date(NOW).toISOString() });
      const report = moneyLeakReport(ledger.list("shop-a"), [], { now: NOW });
      assert.deepEqual(report.today, { soldTodayKobo: 1200000, collectedTodayKobo: 300000, entriesToday: 2 });
    } finally {
      ledger.close();
    }
  });

  it("another shop's entries never count toward today", () => {
    const ledger = new Ledger(":memory:");
    try {
      ledger.append({ shopId: "shop-b", type: "sale", amountKobo: 9000000, customer: "Zed", createdAt: new Date(NOW).toISOString() });
      ledger.append({ shopId: "shop-b", type: "payment", amountKobo: 8000000, customer: "Zed", createdAt: new Date(NOW).toISOString() });
      const report = moneyLeakReport(ledger.list("shop-a"), [], { now: NOW });
      assert.deepEqual(report.today, { soldTodayKobo: 0, collectedTodayKobo: 0, entriesToday: 0 });
    } finally {
      ledger.close();
    }
  });

  it("separates shops and keeps categories uncombined", () => {
    const ledger = new Ledger(":memory:");
    try {
      ledger.append({ shopId: "shop-a", type: "sale", amountKobo: 1000000, customer: "Ada", createdAt: daysAgo(40) });
      ledger.append({ shopId: "shop-b", type: "sale", amountKobo: 9000000, customer: "Zed", createdAt: daysAgo(40) });
      const report = moneyLeakReport(ledger.list("shop-a"), [], { now: NOW });
      assert.deepEqual(report.owed, { totalKobo: 1000000, customers: 1 });
      assert.deepEqual(report.overdue, { amountKobo: 1000000 });
      assert.ok(!("total" in report), "categories are never added into one number");
    } finally {
      ledger.close();
    }
  });
});

describe("proposal promises (fake data, clock fixed at Wed 28 Oct 2026 Lagos)", () => {
  const PROMISE_SALE = {
    type: "sale", customer: "Ada", item: "fake-rice", unit: "bag",
    quantity: 1, amountNaira: 20000, amountPhrase: "20k", priceBasis: "total",
  };
  const withPromise = (promise) => async () => ({
    heard: "Ada buy rice 1 bag na 20k. She go pay friday.",
    entries: [PROMISE_SALE],
    totals: null,
    question: null,
    promise,
  });

  function setup(modelHandler) {
    const ledger = new Ledger(":memory:");
    const proposals = new ProposalStore(":memory:");
    const promises = new PromiseStore(":memory:");
    const model = createMockModelClient(modelHandler);
    return { ledger, proposals, promises, model, deps: { ledger, proposals, promises, model } };
  }

  function teardown({ ledger, proposals, promises }) {
    ledger.close();
    proposals.close();
    promises.close();
  }

  it("a clear promise shows on the card and is created only on confirm", async () => {
    const ctx = setup(withPromise({ customer: "Ada", datePhrase: "friday", amountNaira: 20000 }));
    try {
      const p = await propose("shop-a", "fake note", { ...ctx.deps, now: NOW });
      assert.deepEqual(p.flags, []);
      assert.deepEqual(p.promise, {
        customer: "Ada",
        datePhrase: "friday",
        amountNaira: 20000,
        amountKobo: 2000000,
        dueDate: "2026-10-30",
      });
      const card = renderProposalCard(p);
      assert.ok(card.text.includes("🤝 Ada to pay ₦20,000 by Fri 30 Oct"));
      assert.deepEqual(ctx.promises.listByShop("shop-a"), []);

      const out = confirmProposal(p.id, "shop-a", ctx.deps);
      assert.equal(out.recordedIds.length, 1);
      const rows = ctx.promises.listByShop("shop-a");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].customer, "Ada");
      assert.equal(rows[0].amount_kobo, 2000000);
      assert.equal(rows[0].due_date, "2026-10-30");
      assert.equal(rows[0].status, "open");
      // Confirming twice does not duplicate the promise.
      confirmProposal(p.id, "shop-a", ctx.deps);
      assert.equal(ctx.promises.listByShop("shop-a").length, 1);
    } finally {
      teardown(ctx);
    }
  });

  it("a payment saved in the same note as the promise does not count toward it", async () => {
    const ctx = setup(async () => ({
      heard: "Ada pay 20k, she promise to pay 20k friday.",
      entries: [
        { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 20000, amountPhrase: "20k", priceBasis: "total" },
      ],
      totals: null,
      question: null,
      promise: { customer: "Ada", datePhrase: "friday", amountNaira: 20000 },
    }));
    try {
      const p = await propose("shop-a", "fake note", { ...ctx.deps, now: NOW });
      assert.deepEqual(p.flags, []);
      confirmProposal(p.id, "shop-a", ctx.deps);
      assert.equal(ctx.ledger.list("shop-a").length, 1);
      refreshPromises(ctx.promises, ctx.ledger, "shop-a", { now: NOW });
      const row = ctx.promises.listByShop("shop-a")[0];
      // The same-note payment was confirmed before the promise existed, so it
      // can never keep it; at most the outstanding promise goes broken.
      assert.notEqual(row.status, "kept");
      assert.equal(row.paid_kobo ?? 0, 0);
    } finally {
      teardown(ctx);
    }
  });

  it("an unclear day-phrase asks instead of guessing, then a Fix can set it", async () => {
    const ctx = setup(async (req) =>
      req.prior
        ? await withPromise({ customer: "Ada", datePhrase: "friday", amountNaira: null })()
        : await withPromise({ customer: "Ada", datePhrase: "next friday", amountNaira: null })()
    );
    try {
      const p = await propose("shop-a", "fake note", { ...ctx.deps, now: NOW });
      assert.match(p.flags.join(";"), /unclear/);
      assert.ok(p.question);
      assert.equal(p.promise, null);
      assert.throws(() => confirmProposal(p.id, "shop-a", ctx.deps), /cannot confirm/);

      const fixed = await fixProposal(p.id, "shop-a", "friday", { ...ctx.deps, now: NOW });
      assert.deepEqual(fixed.flags, []);
      assert.equal(fixed.promise.dueDate, "2026-10-30");
      assert.equal(fixed.promise.amountKobo, null);
      confirmProposal(fixed.id, "shop-a", ctx.deps);
      assert.equal(ctx.promises.listByShop("shop-a")[0].amount_kobo, null);
    } finally {
      teardown(ctx);
    }
  });

  it("promise needs a customer and a whole-naira amount", async () => {
    for (const [promise, want] of [
      [{ customer: null, datePhrase: "friday", amountNaira: null }, /customer/],
      [{ customer: "Ada", datePhrase: null, amountNaira: null }, /day/],
      [{ customer: "Ada", datePhrase: "friday", amountNaira: 20.5 }, /whole naira/],
      [{ customer: "Ada", datePhrase: "friday", amountNaira: -5 }, /negative/],
    ]) {
      const ctx = setup(withPromise(promise));
      try {
        const p = await propose("shop-a", "fake note", { ...ctx.deps, now: NOW });
        assert.match(p.flags.join(";"), want, JSON.stringify(promise));
        assert.equal(p.promise, null);
      } finally {
        teardown(ctx);
      }
    }
  });
});

describe("debt messages (fake data)", () => {
  it("formats due days and the promise card line", () => {
    assert.equal(formatDueDay("2026-10-30"), "Fri 30 Oct");
    assert.equal(formatDueDay("2026-11-02"), "Mon 2 Nov");
    assert.equal(promiseCardLine(null), null);
    assert.equal(
      promiseCardLine({ customer: "Ada", amountKobo: 2000000, dueDate: "2026-10-30" }),
      "🤝 Ada to pay ₦20,000 by Fri 30 Oct"
    );
    assert.equal(promiseCardLine({ customer: "Ada", amountKobo: null, dueDate: "2026-10-30" }), "🤝 Ada to pay by Fri 30 Oct");
  });

  it("who-owes lists debtors biggest first, capped", () => {
    const debts = [
      { customer: "Bola", owedKobo: 500000, oldestUnpaidAgeDays: 3 },
      { customer: "Ada", owedKobo: 2000000, oldestUnpaidAgeDays: 12 },
      { customer: "Settled", owedKobo: 0, oldestUnpaidAgeDays: null },
    ];
    assert.equal(renderWhoOwes(debts), "⚖️ *Who owes*\nAda owes *₦20,000* (12 days old)\nBola owes *₦5,000* (3 days old)");
    assert.equal(renderWhoOwes([]), "⚖️ *Who owes*\n\nNobody owes you anything.");
    const many = Array.from({ length: 15 }, (_, i) => ({ customer: `Customer ${i}`, owedKobo: (15 - i) * 100000, oldestUnpaidAgeDays: 1 }));
    const capped = renderWhoOwes(many);
    assert.ok(capped.includes("…and 5 more."));
    assert.ok(capped.length <= MAX_BODY_CHARS);
  });

  it("chase ranks the top 5 with three drafted tones", () => {
    const ranked = rankChase([
      { customer: "Ada", owedKobo: 2000000, ageDays: 12, broken: 1 },
      { customer: "Bola", owedKobo: 500000, ageDays: 3, broken: 0 },
    ]);
    const text = renderChase(ranked);
    assert.ok(text.startsWith("⚠️ *Chase list*\n1. Ada: *₦20,000* (12 days old, 1 broken promise)\n2. Bola: *₦5,000* (3 days old)"));
    assert.ok(text.includes("🤝 Friendly: "));
    assert.ok(text.includes("🤝 Firm: "));
    assert.ok(text.includes("🤝 Final: "));
    assert.equal(renderChase([]), "⚠️ *Chase list*\n\nNobody owes you anything.");
  });

  it("reminder drafts use the name, amount and age in fixed tones", () => {
    for (const tone of ["friendly", "firm", "final"]) {
      const draft = draftReminder(tone, { name: "Ada", amountKobo: 2000000, ageDays: 12 });
      assert.ok(draft.includes("Ada"), tone);
      assert.ok(draft.includes("₦20,000"), tone);
      assert.ok(draft.includes("12 days old"), tone);
    }
    assert.ok(draftReminder("friendly", { name: "Ada", amountKobo: 500000, ageDays: 0 }).includes("(from today)"));
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(draftReminder("firm", { name: "Ada", amountKobo: 500000, ageDays: 1 }).replace(/🤝/g, "")));
  });

  it("balance shows debt, age and kept-rate; unknown names get a polite reply", () => {
    assert.equal(
      renderBalance({ customer: "Ada", owedKobo: 2000000, oldestUnpaidAgeDays: 12 }, { kept: 2, total: 3, rate: 2 / 3 }),
      "⚖️ Ada owes *₦20,000* (12 days old)\nPromises kept: 2 of 3 (67%)"
    );
    assert.equal(
      renderBalance({ customer: "Ada", owedKobo: 0, oldestUnpaidAgeDays: null }, null),
      "⚖️ Ada owes nothing.\nNo promises yet."
    );
    assert.equal(unknownCustomer("Nobody"), 'Sorry, I have no record for "Nobody". Check the spelling and try again.');
  });

  it("due-today lines name each promise, capped", () => {
    assert.deepEqual(
      dueTodayLines([
        { customer: "Ada", amount_kobo: 2000000 },
        { customer: "Bola", amount_kobo: null },
      ]),
      ["🤝 Due today: Ada promised ₦20,000", "🤝 Due today: Bola promised to pay"]
    );
    const many = Array.from({ length: 8 }, (_, i) => ({ customer: `Customer ${i}`, amount_kobo: 100000 }));
    assert.deepEqual(dueTodayLines(many).length, 6);
    assert.equal(dueTodayLines(many)[5], "…and 3 more due today.");
  });

  it("no debt message exceeds 1024 characters", () => {
    const long = "C".repeat(150);
    const debts = Array.from({ length: 15 }, (_, i) => ({ customer: `${long} ${i}`, owedKobo: (15 - i) * 100000, oldestUnpaidAgeDays: 400 }));
    assert.ok(renderWhoOwes(debts).length <= MAX_BODY_CHARS);
    const ranked = rankChase(debts.map((d) => ({ customer: d.customer, owedKobo: d.owedKobo, ageDays: d.oldestUnpaidAgeDays, broken: 2 })));
    assert.ok(renderChase(ranked).length <= MAX_BODY_CHARS);
    assert.ok(renderBalance({ customer: "D".repeat(500), owedKobo: 100000, oldestUnpaidAgeDays: 9 }, { kept: 1, total: 1, rate: 1 }).length <= MAX_BODY_CHARS);
    assert.ok(unknownCustomer("E".repeat(2000)).length <= MAX_BODY_CHARS);
  });
});
