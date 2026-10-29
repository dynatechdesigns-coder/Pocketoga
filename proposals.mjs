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
  recorded_ids TEXT,
  name_checked TEXT,
  source TEXT CHECK (source IS NULL OR source IN ('voice','text','form'))
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
    // Databases created before the name_checked column get it now.
    const columns = this.db
      .prepare("PRAGMA table_info(proposals)")
      .all()
      .map((c) => c.name);
    if (!columns.includes("name_checked")) {
      this.db.exec("ALTER TABLE proposals ADD COLUMN name_checked TEXT");
    }
    // Databases created before the source label get it now; old rows keep
    // NULL (unknown path, ledger-identical either way).
    if (!columns.includes("source")) {
      this.db.exec("ALTER TABLE proposals ADD COLUMN source TEXT CHECK (source IS NULL OR source IN ('voice','text','form'))");
    }
  }

  // envelope: { version, entries, totals, flags, notes } (plain-code checks).
  // source names the entry path (voice, text, form); photo checks predate
  // it and pass nothing.
  create({ shopId, status = "pending", envelope, heard, question = null, createdAt = null, recordedIds = null, nameChecked = null, source = null }) {
    if (!shopId || typeof shopId !== "string") throw new Error("shopId is required");
    const stamp = createdAt ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO proposals
           (shop_id, status, entries_json, heard, question, created_at, recorded_ids, name_checked, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(shopId, status, JSON.stringify(envelope), heard, question, stamp, recordedIds ? JSON.stringify(recordedIds) : null, nameChecked ? JSON.stringify(nameChecked) : null, source ?? null);
    return this.get(Number(result.lastInsertRowid));
  }

  get(id) {
    return this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) ?? null;
  }

  update(id, { status, envelope, heard, question, createdAt, recordedIds, nameChecked } = {}) {
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
    if (nameChecked !== undefined) {
      sets.push("name_checked = ?");
      args.push(nameChecked ? JSON.stringify(nameChecked) : null);
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
