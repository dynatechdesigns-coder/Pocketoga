import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Ledger, verifyChain, computeEntryHash, HASHED_FIELDS } from "./ledger.mjs";

// All fixtures below are fake test data. No real customers, items, or amounts.
// Money is integer kobo (1 naira = 100 kobo).
const SHOP_A = "shop-a";
const SHOP_B = "shop-b";
const FAKE_SALE_A = { shopId: SHOP_A, type: "sale", amountKobo: 200000, customer: "Test Customer Ada" };
const FAKE_SALE_B = { shopId: SHOP_A, type: "sale", amountKobo: 250000, customer: "Test Customer Bola" };
const FAKE_DEBT = { shopId: SHOP_A, type: "debt", amountKobo: 99900, customer: "Test Customer Chidi" };

describe("ledger_entries (append-only hash chain)", () => {
  let ledger;
  beforeEach(() => {
    ledger = new Ledger(":memory:");
  });
  afterEach(() => {
    ledger.close();
  });

  it("starts empty and verifies ok", () => {
    assert.deepEqual(ledger.list(), []);
    assert.deepEqual(ledger.verify(), { ok: true, count: 0 });
  });

  it("chains entries via prev_hash and verifies", () => {
    const first = ledger.append(FAKE_SALE_A);
    const second = ledger.append(FAKE_SALE_B);
    const third = ledger.append(FAKE_DEBT);

    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(third.seq, 3);
    assert.equal(first.prev_hash, null);
    assert.equal(second.prev_hash, first.entry_hash);
    assert.equal(third.prev_hash, second.entry_hash);
    assert.match(first.entry_hash, /^[0-9a-f]{64}$/);

    const result = ledger.verify(SHOP_A);
    assert.equal(result.ok, true);
    assert.equal(result.count, 3);
  });

  it("keeps independent chains and seq per shop", () => {
    const a1 = ledger.append(FAKE_SALE_A);
    const b1 = ledger.append({ ...FAKE_SALE_B, shopId: SHOP_B });
    const a2 = ledger.append(FAKE_DEBT);
    const b2 = ledger.append({ ...FAKE_DEBT, shopId: SHOP_B, customer: "Test Customer Bola" });

    // Each shop starts its own seq at 1 with a NULL genesis prev_hash.
    assert.equal(a1.seq, 1);
    assert.equal(b1.seq, 1);
    assert.equal(a2.seq, 2);
    assert.equal(b2.seq, 2);
    assert.equal(a1.prev_hash, null);
    assert.equal(b1.prev_hash, null);
    assert.equal(a2.prev_hash, a1.entry_hash);
    assert.equal(b2.prev_hash, b1.entry_hash);

    assert.equal(ledger.verify(SHOP_A).ok, true);
    assert.equal(ledger.verify(SHOP_B).ok, true);
    assert.deepEqual(ledger.verify(), { ok: true, count: 4 });
  });

  it("reports the first entry whose amount was tampered with", () => {
    ledger.append(FAKE_SALE_A);
    ledger.append(FAKE_SALE_B);
    ledger.append(FAKE_DEBT);

    const tampered = ledger.list(SHOP_A).map((row) => ({ ...row }));
    tampered[1].amount_kobo = 1;

    const result = verifyChain(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.brokenId, tampered[1].id);
    assert.equal(result.index, 1);
    assert.match(result.reason, /entry_hash/);
  });

  it("reports the first entry with a broken prev_hash link", () => {
    ledger.append(FAKE_SALE_A);
    ledger.append(FAKE_SALE_B);

    const tampered = ledger.list(SHOP_A).map((row) => ({ ...row }));
    tampered[1].prev_hash = "0".repeat(64);

    const result = verifyChain(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.brokenId, tampered[1].id);
    assert.match(result.reason, /prev_hash/);
  });

  it("reports the earliest break when several entries are bad", () => {
    ledger.append(FAKE_SALE_A);
    ledger.append(FAKE_SALE_B);
    ledger.append(FAKE_DEBT);

    const tampered = ledger.list(SHOP_A).map((row) => ({ ...row }));
    tampered[1].amount_kobo = 1;
    tampered[2].prev_hash = "f".repeat(64);

    const result = verifyChain(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.brokenId, tampered[1].id);
    assert.equal(result.index, 1);
  });

  it("tampering with one shop does not flag the other", () => {
    ledger.append(FAKE_SALE_A);
    ledger.append(FAKE_SALE_B);
    ledger.append({ ...FAKE_SALE_A, shopId: SHOP_B });
    ledger.append({ ...FAKE_SALE_B, shopId: SHOP_B });

    const badA = ledger.list(SHOP_A).map((row) => ({ ...row }));
    badA[1].amount_kobo = 12345;

    assert.equal(verifyChain(badA).ok, false);
    // The other shop's rows are untouched and still verify.
    assert.equal(ledger.verify(SHOP_B).ok, true);
    assert.deepEqual(ledger.verify(SHOP_B), { ok: true, count: 2, shopId: SHOP_B });
  });

  it("records corrections as new entries referencing the original", () => {
    const original = ledger.append(FAKE_SALE_A);
    const correction = ledger.appendCorrection(original.id, { amountKobo: 300000 });

    assert.equal(correction.corrects_id, original.id);
    assert.equal(correction.shop_id, SHOP_A);
    assert.equal(correction.seq, 2);
    assert.equal(correction.prev_hash, original.entry_hash);
    // Original row is untouched.
    assert.equal(ledger.get(original.id).amount_kobo, 200000);
    assert.equal(ledger.verify(SHOP_A).ok, true);
  });

  it("rejects corrections that reference a missing entry", () => {
    assert.throws(() => ledger.appendCorrection(999, { amountKobo: 100 }), /does not exist/);
  });

  it("rejects corrections across shops", () => {
    const original = ledger.append(FAKE_SALE_A);
    assert.throws(
      () => ledger.append({ ...FAKE_SALE_B, shopId: SHOP_B, correctsId: original.id }),
      /same shop/
    );
  });

  it("rejects non-integer or negative money", () => {
    for (const bad of [10.5, 100.01, "1000", NaN, null, undefined, true]) {
      assert.throws(
        () => ledger.append({ ...FAKE_SALE_A, amountKobo: bad }),
        /amount_kobo must be an integer/,
        `amountKobo=${String(bad)} should be rejected`
      );
    }
    for (const bad of [-1, -500]) {
      assert.throws(
        () => ledger.append({ ...FAKE_SALE_A, amountKobo: bad }),
        />= 0/,
        `amountKobo=${bad} should be rejected`
      );
    }
    assert.deepEqual(ledger.list(), []);
  });

  it("enforces a unique index on (shop_id, seq)", () => {
    ledger.append(FAKE_SALE_A);
    const indexes = ledger.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ledger_entries'")
      .all()
      .map((r) => r.sql)
      .join("\n");
    assert.match(indexes, /UNIQUE INDEX.*shop_id.*seq|UNIQUE.*shop_id.*seq/s);
    assert.throws(
      () =>
        ledger.db
          .prepare(
            `INSERT INTO ledger_entries
               (shop_id, seq, prev_hash, entry_hash, type, amount_kobo, customer, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(SHOP_A, 1, null, "ab".repeat(32), "sale", 100, "Test Customer Ada", new Date().toISOString()),
      /UNIQUE/
    );
  });

  it("HASHED_FIELDS lists every covered field in canonical order", () => {
    assert.deepEqual(HASHED_FIELDS, [
      "shop_id",
      "seq",
      "type",
      "amount_kobo",
      "customer",
      "item",
      "quantity",
      "unit",
      "created_at",
      "corrects_id",
      "prev_hash",
    ]);
  });

  it("hash covers every field: any field change breaks verification", () => {
    ledger.append({ ...FAKE_SALE_A, item: "fake-rice", quantity: 2, unit: "bag" });
    ledger.append(FAKE_SALE_B);
    const rows = ledger.list(SHOP_A);
    const fields = (row) => ({
      shopId: row.shop_id,
      seq: row.seq,
      type: row.type,
      amountKobo: row.amount_kobo,
      customer: row.customer,
      item: row.item,
      quantity: row.quantity,
      unit: row.unit,
      correctsId: row.corrects_id,
      createdAt: row.created_at,
      prevHash: row.prev_hash,
    });
    const base = computeEntryHash(fields(rows[0]));
    assert.equal(rows[0].entry_hash, base);
    // Each hashed field flips the digest when changed.
    const variants = [
      { shopId: "other-shop" },
      { seq: 99 },
      { type: "refund" },
      { amountKobo: rows[0].amount_kobo + 1 },
      { customer: "Someone Else" },
      { item: "fake-beans" },
      { quantity: 3 },
      { unit: "crate" },
      { createdAt: "2000-01-01T00:00:00.000Z" },
      { correctsId: 999 },
      { prevHash: "0".repeat(64) },
    ];
    for (const patch of variants) {
      const altered = computeEntryHash({ ...fields(rows[0]), ...patch });
      assert.notEqual(altered, base, `hash must change when ${Object.keys(patch)[0]} changes`);
    }
    // NULL vs present also flips the digest.
    assert.equal(computeEntryHash(fields(rows[1])), rows[1].entry_hash);
    assert.notEqual(computeEntryHash({ ...fields(rows[1]), item: "fake-rice" }), rows[1].entry_hash);
    assert.notEqual(computeEntryHash({ ...fields(rows[1]), quantity: 1 }), rows[1].entry_hash);
    assert.notEqual(computeEntryHash({ ...fields(rows[1]), unit: "bag" }), rows[1].entry_hash);
    assert.notEqual(computeEntryHash({ ...fields(rows[0]), unit: null }), rows[0].entry_hash);
  });

  it("hashes unambiguously: '|' placement can never collide", () => {
    const base = {
      shopId: SHOP_A,
      seq: 1,
      type: "sale",
      amountKobo: 100,
      item: null,
      quantity: null,
      correctsId: null,
      prevHash: null,
    };
    const stamp = "2024-01-01T00:00:00.000Z";
    // These two would join to one identical string under the old "|"-separated
    // encoding (customer "Ada" + createdAt "T|X" vs customer "Ada|T" + createdAt "X").
    const h1 = computeEntryHash({ ...base, customer: "Ada", createdAt: `${stamp}|X` });
    const h2 = computeEntryHash({ ...base, customer: `Ada|${stamp}`, createdAt: "X" });
    assert.notEqual(h1, h2);
    // Two entries differing only by where "|" sits in the customer name.
    const h3 = computeEntryHash({ ...base, customer: "A|BC", createdAt: stamp });
    const h4 = computeEntryHash({ ...base, customer: "AB|C", createdAt: stamp });
    assert.notEqual(h3, h4);
  });

  it("stores nullable item, quantity and unit and verifies", () => {
    const withGoods = ledger.append({ ...FAKE_SALE_A, item: "fake-rice", quantity: 2, unit: "bag" });
    assert.equal(withGoods.item, "fake-rice");
    assert.equal(withGoods.quantity, 2);
    assert.equal(withGoods.unit, "bag");
    const withoutGoods = ledger.append(FAKE_SALE_B);
    assert.equal(withoutGoods.item, null);
    assert.equal(withoutGoods.quantity, null);
    assert.equal(withoutGoods.unit, null);
    assert.equal(ledger.verify(SHOP_A).ok, true);
  });

  it("rejects bad item, quantity or unit", () => {
    for (const bad of [0, -1, 1.5, "2", NaN]) {
      assert.throws(
        () => ledger.append({ ...FAKE_SALE_A, item: "fake-rice", quantity: bad }),
        /quantity/,
        `quantity=${String(bad)} should be rejected`
      );
    }
    for (const bad of [123, "", true]) {
      assert.throws(
        () => ledger.append({ ...FAKE_SALE_A, item: bad, quantity: 1 }),
        /item must be text/,
        `item=${String(bad)} should be rejected`
      );
    }
    for (const bad of [123, "", "   ", true]) {
      assert.throws(
        () => ledger.append({ ...FAKE_SALE_A, unit: bad }),
        /unit must be text/,
        `unit=${String(bad)} should be rejected`
      );
    }
    assert.deepEqual(ledger.list(), []);
  });

  it("rejects bad item, quantity or unit at the database level", () => {
    const stamp = new Date().toISOString();
    const insert = (item, quantity, unit, tag) =>
      ledger.db
        .prepare(
          `INSERT INTO ledger_entries
             (shop_id, seq, prev_hash, entry_hash, type, amount_kobo, customer, item, quantity, unit, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(SHOP_A, 1, null, tag.padEnd(64, "0"), "sale", 100, "Test Customer Ada", item, quantity, unit, stamp);
    assert.throws(() => insert("fake-rice", 0, null, "aa"), /CHECK/);
    assert.throws(() => insert("fake-rice", -3, null, "bb"), /CHECK/);
    assert.throws(() => insert("fake-rice", 1.5, null, "cc"), /CHECK/);
    // SQLite TEXT affinity stores numbers as text, so the DB-level item
    // check enforces non-empty; mistyped values are rejected in JS.
    assert.throws(() => insert("", 1, null, "dd"), /CHECK/);
    assert.throws(() => insert("fake-rice", 1, "", "ee"), /CHECK/);
    assert.equal(ledger.list().length, 0);
  });

  it("detects tampering with item, quantity or unit", () => {
    ledger.append({ ...FAKE_SALE_A, item: "fake-rice", quantity: 2, unit: "bag" });
    ledger.append({ ...FAKE_SALE_B, item: "fake-yam", quantity: 5, unit: "tuber" });

    const badItem = ledger.list(SHOP_A).map((row) => ({ ...row }));
    badItem[0].item = "fake-beans";
    const r1 = verifyChain(badItem);
    assert.equal(r1.ok, false);
    assert.equal(r1.brokenId, badItem[0].id);
    assert.match(r1.reason, /entry_hash/);

    const badQty = ledger.list(SHOP_A).map((row) => ({ ...row }));
    badQty[1].quantity = 6;
    const r2 = verifyChain(badQty);
    assert.equal(r2.ok, false);
    assert.equal(r2.brokenId, badQty[1].id);
    assert.match(r2.reason, /entry_hash/);

    const badUnit = ledger.list(SHOP_A).map((row) => ({ ...row }));
    badUnit[0].unit = "crate";
    const r3 = verifyChain(badUnit);
    assert.equal(r3.ok, false);
    assert.equal(r3.brokenId, badUnit[0].id);
    assert.match(r3.reason, /entry_hash/);

    const nulledUnit = ledger.list(SHOP_A).map((row) => ({ ...row }));
    nulledUnit[1].unit = null;
    assert.equal(verifyChain(nulledUnit).ok, false);
  });

  it("payments store no item, quantity or unit", () => {
    for (const extra of [{ item: "fake-rice" }, { quantity: 2 }, { unit: "bag" }]) {
      assert.throws(
        () => ledger.append({ shopId: SHOP_A, type: "payment", amountKobo: 1000, customer: "Test Customer Ada", ...extra }),
        /payment entries must have/,
        `payment with ${JSON.stringify(extra)} should be rejected`
      );
    }
    const payment = ledger.append({ shopId: SHOP_A, type: "payment", amountKobo: 1000, customer: "Test Customer Ada" });
    assert.equal(payment.item, null);
    assert.equal(payment.quantity, null);
    assert.equal(payment.unit, null);
    assert.equal(ledger.verify(SHOP_A).ok, true);
  });

  it("migrates pre-unit databases and old rows still verify", () => {
    // Schema as it was before the unit column (no "unit", no migration).
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
        corrects_id INTEGER REFERENCES ledger_entries(id),
        created_at TEXT NOT NULL,
        UNIQUE (shop_id, seq)
      )`);
      const stamp = "2026-10-27T00:00:00.000Z";
      const oldHash = computeEntryHash({
        shopId: SHOP_A,
        seq: 1,
        type: "sale",
        amountKobo: 500000,
        customer: "Test Customer Ada",
        item: "fake-rice",
        quantity: 2,
        createdAt: stamp,
        prevHash: null,
      });
      db.prepare(
        `INSERT INTO ledger_entries
           (shop_id, seq, prev_hash, entry_hash, type, amount_kobo, customer, item, quantity, corrects_id, created_at)
         VALUES (?, 1, NULL, ?, 'sale', 500000, 'Test Customer Ada', 'fake-rice', 2, NULL, ?)`
      ).run(SHOP_A, oldHash, stamp);

      const migrated = new Ledger(db);
      const columns = db.prepare("PRAGMA table_info(ledger_entries)").all().map((c) => c.name);
      assert.ok(columns.includes("unit"));
      assert.deepEqual(migrated.verify(SHOP_A), { ok: true, count: 1, shopId: SHOP_A });
      // New rows with units chain on top of migrated ones.
      const next = migrated.append({
        shopId: SHOP_A,
        type: "sale",
        amountKobo: 100,
        customer: "Test Customer Bola",
        unit: "bag",
      });
      assert.equal(next.seq, 2);
      assert.equal(migrated.verify(SHOP_A).ok, true);
    } finally {
      db.close();
    }
  });

  it("corrections inherit item, quantity and unit unless overridden", () => {
    const original = ledger.append({ ...FAKE_SALE_A, item: "fake-rice", quantity: 2, unit: "bag" });
    const inherited = ledger.appendCorrection(original.id, { amountKobo: 300000 });
    assert.equal(inherited.item, "fake-rice");
    assert.equal(inherited.quantity, 2);
    assert.equal(inherited.unit, "bag");
    const overridden = ledger.appendCorrection(original.id, {
      amountKobo: 300000,
      item: "fake-beans",
      quantity: 3,
      unit: "crate",
    });
    assert.equal(overridden.item, "fake-beans");
    assert.equal(overridden.quantity, 3);
    assert.equal(overridden.unit, "crate");
    const cleared = ledger.appendCorrection(original.id, { amountKobo: 300000, item: null, quantity: null, unit: null });
    assert.equal(cleared.item, null);
    assert.equal(cleared.quantity, null);
    assert.equal(cleared.unit, null);
    assert.equal(ledger.verify(SHOP_A).ok, true);
  });

  it("rejects UPDATE and DELETE at the database level", () => {
    const entry = ledger.append(FAKE_SALE_A);
    assert.throws(
      () => ledger.db.prepare("UPDATE ledger_entries SET amount_kobo = 1 WHERE id = ?").run(entry.id),
      /append-only/
    );
    assert.throws(
      () => ledger.db.prepare("DELETE FROM ledger_entries WHERE id = ?").run(entry.id),
      /append-only/
    );
    // Chain still intact after the rejected writes.
    assert.equal(ledger.verify(SHOP_A).ok, true);
  });

  it("detects a correction pointing at a missing entry", () => {
    const first = ledger.append(FAKE_SALE_A);
    const rows = ledger.list(SHOP_A).map((row) => ({ ...row }));
    // Re-point corrects_id at a nonexistent entry, then re-hash so that the
    // hash check passes and only the dangling reference is reported.
    rows[0].corrects_id = first.id + 100;
    rows[0].entry_hash = computeEntryHash({
      shopId: rows[0].shop_id,
      seq: rows[0].seq,
      type: rows[0].type,
      amountKobo: rows[0].amount_kobo,
      customer: rows[0].customer,
      item: rows[0].item,
      quantity: rows[0].quantity,
      correctsId: rows[0].corrects_id,
      createdAt: rows[0].created_at,
      prevHash: rows[0].prev_hash,
    });
    const result = verifyChain(rows);
    assert.equal(result.ok, false);
    assert.equal(result.brokenId, rows[0].id);
    assert.match(result.reason, /corrects_id/);
  });
});
