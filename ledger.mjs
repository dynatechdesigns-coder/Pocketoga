import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Placeholder hashed for the genesis entry (stored as NULL in prev_hash).
const GENESIS_SENTINEL = "GENESIS";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prev_hash TEXT,
  entry_hash TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  corrects_id INTEGER REFERENCES ledger_entries(id),
  created_at TEXT NOT NULL
);
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
`;

// Deterministic JSON: sorted keys so the hash is stable.
export function canonicalize(payload) {
  if (typeof payload === "string") return payload;
  return JSON.stringify(sortValue(payload));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

export function computeEntryHash({ prevHash, type, payload, correctsId, createdAt }) {
  const canonical = canonicalize(payload);
  const material = [
    prevHash ?? GENESIS_SENTINEL,
    type,
    canonical,
    correctsId ?? "",
    createdAt,
  ].join("|");
  return createHash("sha256").update(material, "utf8").digest("hex");
}

// Pure chain check over entries ordered by id ascending.
// Returns { ok: true, count } or { ok: false, brokenId, index, reason, ... }.
export function verifyChain(entries) {
  const seen = new Set();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];

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
      prevHash: entry.prev_hash,
      type: entry.type,
      payload: entry.payload,
      correctsId: entry.corrects_id,
      createdAt: entry.created_at,
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
  constructor(dbPath = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  append({ type, payload, correctsId = null, createdAt = null }) {
    if (!type || typeof type !== "string") throw new Error("type is required");
    if (payload === undefined) throw new Error("payload is required");
    const canonical = canonicalize(payload);
    const stamp = createdAt ?? new Date().toISOString();

    if (correctsId !== null) {
      const original = this.get(correctsId);
      if (!original) throw new Error(`corrects_id ${correctsId} does not exist`);
    }

    const prev = this.db
      .prepare("SELECT entry_hash FROM ledger_entries ORDER BY id DESC LIMIT 1")
      .get();
    const prevHash = prev ? prev.entry_hash : null;

    const entryHash = computeEntryHash({
      prevHash,
      type,
      payload: canonical,
      correctsId,
      createdAt: stamp,
    });

    const result = this.db
      .prepare(
        `INSERT INTO ledger_entries
           (prev_hash, entry_hash, type, payload, corrects_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(prevHash, entryHash, type, canonical, correctsId, stamp);

    return this.get(Number(result.lastInsertRowid));
  }

  // Corrections are new entries that reference the original; never edits.
  appendCorrection(originalId, { type = "correction", payload, createdAt = null } = {}) {
    return this.append({ type, payload, correctsId: originalId, createdAt });
  }

  get(id) {
    return this.db.prepare("SELECT * FROM ledger_entries WHERE id = ?").get(id) ?? null;
  }

  list() {
    return this.db.prepare("SELECT * FROM ledger_entries ORDER BY id ASC").all();
  }

  // Verifies the whole chain; reports the first broken entry.
  verify() {
    return verifyChain(this.list());
  }

  close() {
    this.db.close();
  }
}
