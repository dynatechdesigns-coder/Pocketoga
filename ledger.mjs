import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Exact fields covered by the hash, in fixed canonical order. "unit" is
// covered whenever it is non-null; a null unit is omitted from the material
// so rows written before the unit column existed verify byte-identically.
export const HASHED_FIELDS = [
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
];

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_entries (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_shop_seq ON ledger_entries(shop_id, seq);
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update
BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only: UPDATE not allowed');
END;
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete
BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only: DELETE not allowed');
END;
-- Human reasons for corrections. The ledger has no reason column by design,
-- so each reason lives here keyed by the correcting entry's id.
CREATE TABLE IF NOT EXISTS corrections_log (
  entry_id INTEGER PRIMARY KEY REFERENCES ledger_entries(id),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  created_at TEXT NOT NULL
);
`;

// Unambiguous canonical encoding: a JSON array of the hashed fields in fixed
// order. Field boundaries and types are explicit, so a "|" inside one field
// (e.g. customer) can never collide with another entry the way a "|"-joined
// string could.
export function computeEntryHash({
  shopId,
  seq,
  type,
  amountKobo,
  customer,
  item = null,
  quantity = null,
  unit = null,
  correctsId = null,
  createdAt,
  prevHash = null,
}) {
  const material = JSON.stringify([
    shopId,
    seq,
    type,
    amountKobo,
    customer,
    item ?? null,
    quantity ?? null,
    ...(unit ?? null) === null ? [] : [unit],
    createdAt,
    correctsId ?? null,
    prevHash ?? null,
  ]);
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function assertAmountKobo(amountKobo) {
  if (typeof amountKobo !== "number" || !Number.isInteger(amountKobo)) {
    throw new Error("amount_kobo must be an integer (kobo)");
  }
  if (amountKobo < 0) {
    throw new Error("amount_kobo must be >= 0");
  }
}

function assertItem(item) {
  if (item === null || item === undefined) return null;
  if (typeof item !== "string" || item.length === 0) {
    throw new Error("item must be text");
  }
  return item;
}

function assertQuantity(quantity) {
  if (quantity === null || quantity === undefined) return null;
  if (typeof quantity !== "number" || !Number.isInteger(quantity)) {
    throw new Error("quantity must be an integer");
  }
  if (quantity <= 0) {
    throw new Error("quantity must be > 0");
  }
  return quantity;
}

function assertUnit(unit) {
  if (unit === null || unit === undefined) return null;
  if (typeof unit !== "string" || unit.trim().length === 0) {
    throw new Error("unit must be text");
  }
  return unit.trim();
}

// Pure chain check over entries of ONE shop ordered by seq ascending.
// Returns { ok: true, count } or { ok: false, brokenId, index, reason, ... }.
export function verifyChain(entries) {
  const seen = new Set();
  let shopId = null;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];

    if (index === 0) {
      shopId = entry.shop_id;
    } else if (entry.shop_id !== shopId) {
      return {
        ok: false,
        brokenId: entry.id,
        index,
        reason: "verifyChain expects entries of a single shop",
        expected: shopId,
        actual: entry.shop_id,
      };
    }

    const expectedSeq = index + 1;
    if (entry.seq !== expectedSeq) {
      return {
        ok: false,
        brokenId: entry.id,
        index,
        reason: "seq must be consecutive per shop starting at 1",
        expected: expectedSeq,
        actual: entry.seq,
      };
    }

    if (index === 0) {
      if (entry.prev_hash !== null) {
        return {
          ok: false,
          brokenId: entry.id,
          index,
          reason: "genesis entry must have NULL prev_hash",
          expected: null,
          actual: entry.prev_hash,
        };
      }
    } else {
      const expected = entries[index - 1].entry_hash;
      if (entry.prev_hash !== expected) {
        return {
          ok: false,
          brokenId: entry.id,
          index,
          reason: "prev_hash does not match previous entry_hash",
          expected,
          actual: entry.prev_hash,
        };
      }
    }

    const recomputed = computeEntryHash({
      shopId: entry.shop_id,
      seq: entry.seq,
      type: entry.type,
      amountKobo: entry.amount_kobo,
      customer: entry.customer,
      item: entry.item,
      quantity: entry.quantity,
      unit: entry.unit,
      correctsId: entry.corrects_id,
      createdAt: entry.created_at,
      prevHash: entry.prev_hash,
    });
    if (recomputed !== entry.entry_hash) {
      return {
        ok: false,
        brokenId: entry.id,
        index,
        reason: "entry_hash does not match recomputed SHA-256",
        expected: recomputed,
        actual: entry.entry_hash,
      };
    }

    if (entry.corrects_id !== null && entry.corrects_id !== undefined) {
      if (!seen.has(entry.corrects_id)) {
        return {
          ok: false,
          brokenId: entry.id,
          index,
          reason: "corrects_id does not reference an earlier entry",
          expected: "id of an earlier entry",
          actual: entry.corrects_id,
        };
      }
    }

    seen.add(entry.id);
  }
  return { ok: true, count: entries.length };
}

export class Ledger {
  // dbPathOrDb: a path (owned connection) or a shared DatabaseSync.
  constructor(dbPathOrDb = ":memory:") {
    if (typeof dbPathOrDb === "string") {
      this.db = new DatabaseSync(dbPathOrDb);
      this.ownsDb = true;
    } else {
      this.db = dbPathOrDb;
      this.ownsDb = false;
    }
    this.db.exec(SCHEMA);
    // Databases created before the unit column get it now; old rows keep
    // unit NULL and verify exactly as before.
    const columns = this.db
      .prepare("PRAGMA table_info(ledger_entries)")
      .all()
      .map((c) => c.name);
    if (!columns.includes("unit")) {
      this.db.exec("ALTER TABLE ledger_entries ADD COLUMN unit TEXT CHECK (unit IS NULL OR length(unit) > 0)");
    }
  }

  append({
    shopId,
    type,
    amountKobo,
    customer,
    item = null,
    quantity = null,
    unit = null,
    correctsId = null,
    createdAt = null,
  }) {
    if (!shopId || typeof shopId !== "string") throw new Error("shopId is required");
    if (!type || typeof type !== "string") throw new Error("type is required");
    assertAmountKobo(amountKobo);
    if (!customer || typeof customer !== "string") throw new Error("customer is required");
    const cleanItem = assertItem(item);
    const cleanQuantity = assertQuantity(quantity);
    const cleanUnit = assertUnit(unit);
    if (type === "payment" && (cleanItem !== null || cleanQuantity !== null || cleanUnit !== null)) {
      throw new Error("payment entries must have item, quantity and unit null");
    }
    const stamp = createdAt ?? new Date().toISOString();

    if (correctsId !== null) {
      const original = this.get(correctsId);
      if (!original) throw new Error(`corrects_id ${correctsId} does not exist`);
      if (original.shop_id !== shopId) {
        throw new Error("corrects_id must reference an entry of the same shop");
      }
    }

    const prev = this.db
      .prepare("SELECT seq, entry_hash FROM ledger_entries WHERE shop_id = ? ORDER BY seq DESC LIMIT 1")
      .get(shopId);
    const seq = prev ? prev.seq + 1 : 1;
    const prevHash = prev ? prev.entry_hash : null;

    const entryHash = computeEntryHash({
      shopId,
      seq,
      type,
      amountKobo,
      customer,
      item: cleanItem,
      quantity: cleanQuantity,
      unit: cleanUnit,
      correctsId,
      createdAt: stamp,
      prevHash,
    });

    const result = this.db
      .prepare(
        `INSERT INTO ledger_entries
           (shop_id, seq, prev_hash, entry_hash, type, amount_kobo, customer, item, quantity, unit, corrects_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(shopId, seq, prevHash, entryHash, type, amountKobo, customer, cleanItem, cleanQuantity, cleanUnit, correctsId, stamp);

    return this.get(Number(result.lastInsertRowid));
  }

  // Corrections are new entries that reference the original; never edits.
  // The correction stays in the original's shop and inherits the original's
  // customer/item/quantity/unit unless overridden (pass null to clear one).
  appendCorrection(
    originalId,
    { type = "correction", amountKobo, customer = null, item = undefined, quantity = undefined, unit = undefined, createdAt = null } = {}
  ) {
    const original = this.get(originalId);
    if (!original) throw new Error(`corrects_id ${originalId} does not exist`);
    return this.append({
      shopId: original.shop_id,
      type,
      amountKobo,
      customer: customer ?? original.customer,
      item: item === undefined ? original.item : item,
      quantity: quantity === undefined ? original.quantity : quantity,
      unit: unit === undefined ? original.unit : unit,
      correctsId: originalId,
      createdAt,
    });
  }

  // Records the human reason for a correcting entry. Reasons live only
  // in corrections_log — never in ledger rows or hashes.
  recordCorrectionReason(entryId, reason, createdAt = null) {
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error("correction reason is required");
    }
    this.db
      .prepare("INSERT OR REPLACE INTO corrections_log (entry_id, reason, created_at) VALUES (?, ?, ?)")
      .run(entryId, reason.trim(), createdAt ?? new Date().toISOString());
    return this.correctionReason(entryId);
  }

  // The logged reason for one correcting entry, or null when none (legacy
  // corrections made before reasons existed).
  correctionReason(entryId) {
    const row = this.db.prepare("SELECT reason FROM corrections_log WHERE entry_id = ?").get(entryId);
    return row ? row.reason : null;
  }

  get(id) {
    return this.db.prepare("SELECT * FROM ledger_entries WHERE id = ?").get(id) ?? null;
  }

  list(shopId = null) {
    if (shopId !== null && shopId !== undefined) {
      return this.db
        .prepare("SELECT * FROM ledger_entries WHERE shop_id = ? ORDER BY seq ASC")
        .all(shopId);
    }
    return this.db
      .prepare("SELECT * FROM ledger_entries ORDER BY shop_id ASC, seq ASC")
      .all();
  }

  shops() {
    return this.db.prepare("SELECT DISTINCT shop_id FROM ledger_entries ORDER BY shop_id ASC").all().map((r) => r.shop_id);
  }

  // Verifies one shop's chain when shopId is given, else every shop's chain.
  verify(shopId = null) {
    if (shopId !== null && shopId !== undefined) {
      const result = verifyChain(this.list(shopId));
      if (result.ok) return { ok: true, count: result.count, shopId };
      return { ...result, shopId };
    }
    const ids = this.shops();
    if (ids.length === 0) return { ok: true, count: 0 };
    let total = 0;
    for (const id of ids) {
      const result = verifyChain(this.list(id));
      if (!result.ok) return { ...result, shopId: id };
      total += result.count;
    }
    return { ok: true, count: total };
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}
