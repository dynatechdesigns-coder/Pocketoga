// Passwordless login: WhatsApp one-time codes exchanged for session tokens.
// Codes and tokens exist as plaintext only at creation; the tables hold
// SHA-256 hashes. Nothing here logs a code or a token — callers must keep
// them out of log lines too (they are too short for maskForLog to redact).
//
// Rules: one code per issue, 10-minute expiry, one use, at most 5 codes per
// number per rolling hour. Code guesses are limited separately: 5 failed
// exchanges per shop per hour, then 429 — a 6-digit code with unlimited
// guesses would be brute-forceable. Sessions live 30 days and revoke by
// token. The demo shop ("demo") stays public and is never gated.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const DEMO_SHOP_ID = "demo";
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
export const LOGIN_ISSUE_LIMIT = 5;
export const LOGIN_EXCHANGE_LIMIT = 5;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export function hashSecret(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_codes_shop ON login_codes(shop_id);
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('issue','exchange')),
  key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_kind_key ON login_attempts(kind, key);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_shop ON sessions(shop_id);
`;

const iso = (ms) => new Date(ms).toISOString();

export class AuthStore {
  // dbPathOrDb: a path (owned connection) or a shared DatabaseSync.
  constructor(dbPathOrDb = ":memory:") {
    if (typeof dbPathOrDb === "string") {
      this.db = new DatabaseSync(dbPathOrDb);
      this.ownsDb = true;
    } else {
      this.db = dbPathOrDb;
      this.ownsDb = false;
    }
    this.db.exec(AUTH_SCHEMA);
  }

  // Drops rows nobody can use again: attempts past the 1-hour window, codes
  // expired over an hour ago (kept that long so "expired" beats "wrong"),
  // sessions revoked or expired over an hour ago.
  prune(now = Date.now()) {
    const hourAgo = iso(now - HOUR_MS);
    this.db.prepare("DELETE FROM login_attempts WHERE created_at < ?").run(hourAgo);
    this.db.prepare("DELETE FROM login_codes WHERE expires_at < ?").run(hourAgo);
    this.db.prepare("DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?").run(hourAgo, hourAgo);
  }

  recentAttempts(kind, key, now = Date.now()) {
    return this.db
      .prepare("SELECT COUNT(*) AS c FROM login_attempts WHERE kind = ? AND key = ? AND created_at > ?")
      .get(kind, key, iso(now - HOUR_MS)).c;
  }

  // Issues a code for this sender's shop: { limited: true } past the
  // hourly budget, else { limited: false, code }. Older live codes stay
  // valid; each is good for one use.
  issueCode(shopId, sender, { now = Date.now() } = {}) {
    if (!shopId || typeof shopId !== "string" || !sender || typeof sender !== "string") {
      throw new Error("issueCode needs { shopId, sender }");
    }
    this.prune(now);
    if (this.recentAttempts("issue", sender, now) >= LOGIN_ISSUE_LIMIT) return { limited: true };
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO login_codes (shop_id, sender, code_hash, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)")
        .run(shopId, sender, hashSecret(code), iso(now), iso(now + LOGIN_CODE_TTL_MS));
      this.db.prepare("INSERT INTO login_attempts (kind, key, created_at) VALUES ('issue', ?, ?)").run(sender, iso(now));
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw err;
    }
    return { limited: false, code };
  }

  // Exchanges a code for a session token. Wrong, used and expired codes all
  // fail closed with a distinct reason; only failures count against the
  // hourly exchange budget, so logging in never locks itself out.
  exchangeCode(shopId, code, { now = Date.now() } = {}) {
    this.prune(now);
    const cleanShop = typeof shopId === "string" ? shopId.trim() : "";
    const cleanCode = typeof code === "string" ? code.trim() : "";
    if (!cleanShop || !cleanCode) return { ok: false, reason: "bad_request" };
    if (this.recentAttempts("exchange", cleanShop, now) >= LOGIN_EXCHANGE_LIMIT) {
      return { ok: false, reason: "rate_limited" };
    }
    const row = this.db
      .prepare("SELECT * FROM login_codes WHERE shop_id = ? AND code_hash = ? ORDER BY id DESC LIMIT 1")
      .get(cleanShop, hashSecret(cleanCode));
    if (!row) return this.#failedExchange(cleanShop, "wrong", now);
    if (row.used_at !== null) return this.#failedExchange(cleanShop, "used", now);
    if (Date.parse(row.expires_at) <= now) return this.#failedExchange(cleanShop, "expired", now);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = iso(now + SESSION_TTL_MS);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE login_codes SET used_at = ? WHERE id = ?").run(iso(now), row.id);
      this.db.prepare("INSERT INTO sessions (shop_id, token_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)")
        .run(cleanShop, hashSecret(token), iso(now), expiresAt);
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw err;
    }
    return { ok: true, token, shopId: cleanShop, expiresAt };
  }

  #failedExchange(shopId, reason, now) {
    this.db.prepare("INSERT INTO login_attempts (kind, key, created_at) VALUES ('exchange', ?, ?)").run(shopId, iso(now));
    return { ok: false, reason };
  }

  // A bearer token to its live session ({ shopId, sessionId }), or null
  // when unknown, expired or revoked.
  verifyToken(token, { now = Date.now() } = {}) {
    if (typeof token !== "string" || !token) return null;
    const row = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hashSecret(token));
    if (!row || row.revoked_at !== null || Date.parse(row.expires_at) <= now) return null;
    return { shopId: row.shop_id, sessionId: row.id };
  }

  // Revokes by token. True when a live session was revoked, false when the
  // token was unknown or already revoked.
  revokeToken(token, { now = Date.now() } = {}) {
    if (typeof token !== "string" || !token) return false;
    const result = this.db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .run(iso(now), hashSecret(token));
    return result.changes > 0;
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}
