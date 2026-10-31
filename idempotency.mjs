// Offline-queue idempotency: the propose routes accept an optional
// client-generated "x-request-id" header. The same shop + id replays the
// stored proposal instead of proposing twice; keys live 24 hours, then a
// repeat proposes fresh. Request ids are scoped per shop: one shop can
// never read another shop's stored result.
import { DatabaseSync } from "node:sqlite";

// Request-id keys older than this propose fresh again.
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_REQUEST_ID_LENGTH = 128;

export const IDEMPOTENCY_SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency_keys (
  shop_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  proposal_id INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, request_id)
);
`;

export class IdempotencyStore {
  // dbPathOrDb: a path (owned connection) or a shared DatabaseSync.
  constructor(dbPathOrDb = ":memory:") {
    if (typeof dbPathOrDb === "string") {
      this.db = new DatabaseSync(dbPathOrDb);
      this.ownsDb = true;
    } else {
      this.db = dbPathOrDb;
      this.ownsDb = false;
    }
    this.db.exec(IDEMPOTENCY_SCHEMA);
  }

  find(shopId, requestId) {
    return (
      this.db
        .prepare("SELECT * FROM idempotency_keys WHERE shop_id = ? AND request_id = ?")
        .get(shopId, requestId) ?? null
    );
  }

  fresh(row, nowMs = Date.now()) {
    if (!row) return false;
    const ms = Date.parse(row.created_at);
    return Number.isFinite(ms) && nowMs - ms < IDEMPOTENCY_TTL_MS;
  }

  // Synchronous claim before any await: exactly one concurrent request for
  // the same shop + id owns the follow-up work. True when this caller owns
  // it, false when a row is already there.
  reserve(shopId, requestId, createdAt) {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO idempotency_keys (shop_id, request_id, proposal_id, created_at) VALUES (?, ?, NULL, ?)")
      .run(shopId, requestId, createdAt);
    return Number(result.changes) === 1;
  }

  attach(shopId, requestId, proposalId) {
    this.db
      .prepare("UPDATE idempotency_keys SET proposal_id = ? WHERE shop_id = ? AND request_id = ?")
      .run(proposalId, shopId, requestId);
  }

  remove(shopId, requestId) {
    this.db.prepare("DELETE FROM idempotency_keys WHERE shop_id = ? AND request_id = ?").run(shopId, requestId);
  }

  // Drops keys older than 24 hours so the table stays bounded.
  prune(nowMs = Date.now()) {
    this.db
      .prepare("DELETE FROM idempotency_keys WHERE created_at < ?")
      .run(new Date(nowMs - IDEMPOTENCY_TTL_MS).toISOString());
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}
