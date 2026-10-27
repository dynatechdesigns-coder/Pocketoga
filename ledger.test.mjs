import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Ledger, verifyChain, computeEntryHash } from "./ledger.mjs";

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

  it("hash covers every field: any field change breaks verification", () => {
    ledger.append(FAKE_SALE_A);
    ledger.append(FAKE_SALE_B);
    const rows = ledger.list(SHOP_A);
    const base = computeEntryHash({
      shopId: rows[0].shop_id,
      seq: rows[0].seq,
      type: rows[0].type,
      amountKobo: rows[0].amount_kobo,
      customer: rows[0].customer,
      correctsId: rows[0].corrects_id,
      createdAt: rows[0].created_at,
      prevHash: rows[0].prev_hash,
    });
    assert.equal(rows[0].entry_hash, base);
    // Each hashed field flips the digest when changed.
    const variants = [
      { shopId: "other-shop" },
      { seq: 99 },
      { type: "refund" },
      { amountKobo: rows[0].amount_kobo + 1 },
      { customer: "Someone Else" },
      { createdAt: "2000-01-01T00:00:00.000Z" },
      { correctsId: 999 },
      { prevHash: "0".repeat(64) },
    ];
    for (const patch of variants) {
      const altered = computeEntryHash({
        shopId: rows[0].shop_id,
        seq: rows[0].seq,
        type: rows[0].type,
        amountKobo: rows[0].amount_kobo,
        customer: rows[0].customer,
        correctsId: rows[0].corrects_id,
        createdAt: rows[0].created_at,
        prevHash: rows[0].prev_hash,
        ...patch,
      });
      assert.notEqual(altered, base, `hash must change when ${Object.keys(patch)[0]} changes`);
    }
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
