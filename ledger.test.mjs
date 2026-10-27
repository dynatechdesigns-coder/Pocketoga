import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Ledger, verifyChain, computeEntryHash } from "./ledger.mjs";

// All fixtures below are fake test data. No real customers, items, or amounts.
const FAKE_SALE_A = {
  customer: "Test Customer Ada",
  item: "fake-rice",
  quantity: 2,
  unit: "bag",
  unit_price: 1000,
  amount_paid: 2000,
};
const FAKE_SALE_B = {
  customer: "Test Customer Bola",
  item: "fake-yam",
  quantity: 5,
  unit: "tuber",
  unit_price: 500,
  amount_paid: 2500,
};
const FAKE_DEBT = { customer: "Test Customer Chidi", amount_owed: 999, note: "fake debt" };

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
    const first = ledger.append({ type: "sale", payload: FAKE_SALE_A });
    const second = ledger.append({ type: "sale", payload: FAKE_SALE_B });
    const third = ledger.append({ type: "debt", payload: FAKE_DEBT });

    assert.equal(first.prev_hash, null);
    assert.equal(second.prev_hash, first.entry_hash);
    assert.equal(third.prev_hash, second.entry_hash);
    assert.match(first.entry_hash, /^[0-9a-f]{64}$/);

    const result = ledger.verify();
    assert.equal(result.ok, true);
    assert.equal(result.count, 3);
  });

  it("reports the first entry whose payload was tampered with", () => {
    ledger.append({ type: "sale", payload: FAKE_SALE_A });
    ledger.append({ type: "sale", payload: FAKE_SALE_B });
    ledger.append({ type: "debt", payload: FAKE_DEBT });

    const tampered = ledger.list().map((row) => ({ ...row }));
    tampered[1].payload = JSON.stringify({ ...FAKE_SALE_B, unit_price: 1 });

    const result = verifyChain(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.brokenId, tampered[1].id);
    assert.equal(result.index, 1);
    assert.match(result.reason, /entry_hash/);
  });

  it("reports the first entry with a broken prev_hash link", () => {
    ledger.append({ type: "sale", payload: FAKE_SALE_A });
    ledger.append({ type: "sale", payload: FAKE_SALE_B });

    const tampered = ledger.list().map((row) => ({ ...row }));
    tampered[1].prev_hash = "0".repeat(64);

    const result = verifyChain(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.brokenId, tampered[1].id);
    assert.match(result.reason, /prev_hash/);
  });

  it("reports the earliest break when several entries are bad", () => {
    ledger.append({ type: "sale", payload: FAKE_SALE_A });
    ledger.append({ type: "sale", payload: FAKE_SALE_B });
    ledger.append({ type: "debt", payload: FAKE_DEBT });

    const tampered = ledger.list().map((row) => ({ ...row }));
    tampered[1].payload = JSON.stringify(FAKE_DEBT);
    tampered[2].prev_hash = "f".repeat(64);

    const result = verifyChain(tampered);
    assert.equal(result.ok, false);
    assert.equal(result.brokenId, tampered[1].id);
    assert.equal(result.index, 1);
  });

  it("records corrections as new entries referencing the original", () => {
    const original = ledger.append({ type: "sale", payload: FAKE_SALE_A });
    const correction = ledger.appendCorrection(original.id, {
      payload: { ...FAKE_SALE_A, quantity: 3, amount_paid: 3000 },
    });

    assert.equal(correction.corrects_id, original.id);
    assert.equal(correction.prev_hash, original.entry_hash);
    // Original row is untouched.
    assert.deepEqual(JSON.parse(ledger.get(original.id).payload), FAKE_SALE_A);
    assert.equal(ledger.verify().ok, true);
  });

  it("rejects corrections that reference a missing entry", () => {
    assert.throws(() => ledger.appendCorrection(999, { payload: FAKE_SALE_A }), /does not exist/);
  });

  it("rejects UPDATE and DELETE at the database level", () => {
    const entry = ledger.append({ type: "sale", payload: FAKE_SALE_A });
    assert.throws(
      () => ledger.db.prepare("UPDATE ledger_entries SET payload = '{}' WHERE id = ?").run(entry.id),
      /append-only/
    );
    assert.throws(
      () => ledger.db.prepare("DELETE FROM ledger_entries WHERE id = ?").run(entry.id),
      /append-only/
    );
    // Chain still intact after the rejected writes.
    assert.equal(ledger.verify().ok, true);
  });

  it("detects a correction pointing at a missing entry", () => {
    const first = ledger.append({ type: "sale", payload: FAKE_SALE_A });
    const rows = ledger.list().map((row) => ({ ...row }));
    // Re-point corrects_id at a nonexistent entry, then re-hash so that the
    // hash check passes and only the dangling reference is reported.
    rows[0].corrects_id = first.id + 100;
    rows[0].entry_hash = computeEntryHash({
      prevHash: rows[0].prev_hash,
      type: rows[0].type,
      payload: rows[0].payload,
      correctsId: rows[0].corrects_id,
      createdAt: rows[0].created_at,
    });
    const result = verifyChain(rows);
    assert.equal(result.ok, false);
    assert.equal(result.brokenId, rows[0].id);
    assert.match(result.reason, /corrects_id/);
  });
});
