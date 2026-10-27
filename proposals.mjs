import { DatabaseSync } from "node:sqlite";

// Proposals are drafts awaiting the trader's tap. They may change freely;
// the ledger never does. One row per voice/text note.
export const PROPOSAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected','expired')),
  entries_json TEXT NOT NULL,
  heard TEXT NOT NULL,
  question TEXT,
  created_at TEXT NOT NULL,
  recorded_ids TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_shop ON proposals(shop_id);
`;

export class ProposalStore {
  // dbPathOrDb: a path (owned connection) or a shared DatabaseSync.
  constructor(dbPathOrDb = ":memory:") {
    if (typeof dbPathOrDb === "string") {
      this.db = new DatabaseSync(dbPathOrDb);
      this.ownsDb = true;
    } else {
      this.db = dbPathOrDb;
      this.ownsDb = false;
    }
    this.db.exec(PROPOSAL_SCHEMA);
  }

  // envelope: { version, entries, totals, flags, notes } (plain-code checks).
  create({ shopId, status = "pending", envelope, heard, question = null, createdAt = null, recordedIds = null }) {
    if (!shopId || typeof shopId !== "string") throw new Error("shopId is required");
    const stamp = createdAt ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO proposals
           (shop_id, status, entries_json, heard, question, created_at, recorded_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(shopId, status, JSON.stringify(envelope), heard, question, stamp, recordedIds ? JSON.stringify(recordedIds) : null);
    return this.get(Number(result.lastInsertRowid));
  }

  get(id) {
    return this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) ?? null;
  }

  update(id, { status, envelope, heard, question, createdAt, recordedIds } = {}) {
    const sets = [];
    const args = [];
    if (status !== undefined) {
      sets.push("status = ?");
      args.push(status);
    }
    if (envelope !== undefined) {
      sets.push("entries_json = ?");
      args.push(JSON.stringify(envelope));
    }
    if (heard !== undefined) {
      sets.push("heard = ?");
      args.push(heard);
    }
    if (question !== undefined) {
      sets.push("question = ?");
      args.push(question);
    }
    if (createdAt !== undefined) {
      sets.push("created_at = ?");
      args.push(createdAt);
    }
    if (recordedIds !== undefined) {
      sets.push("recorded_ids = ?");
      args.push(recordedIds ? JSON.stringify(recordedIds) : null);
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE proposals SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    }
    return this.get(id);
  }

  listByShop(shopId) {
    return this.db.prepare("SELECT * FROM proposals WHERE shop_id = ? ORDER BY id ASC").all(shopId);
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}
