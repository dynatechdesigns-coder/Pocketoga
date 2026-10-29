// Customers directory: names, phones and consent per shop. Mutable by
// design and separate from the ledger — phone numbers never enter ledger
// rows, hashes, logs or model prompts.
import { DatabaseSync } from "node:sqlite";
import { customerDebts } from "./debts.mjs";

export const CUSTOMER_SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) > 0),
  name_norm TEXT NOT NULL,
  phone TEXT CHECK (phone IS NULL OR length(phone) > 0),
  consent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_shop_name ON customers(shop_id, name_norm);
CREATE INDEX IF NOT EXISTS idx_customers_shop ON customers(shop_id);
`;

// Normalized identity: trimmed, single spaces, lowercased. Stored in
// name_norm so SQLite enforces uniqueness on (shop, normalized name).
export function normCustomerName(name) {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function cleanName(name) {
  const clean = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("customer name is required");
  return clean;
}

// Digits with a country code. Nigerian numbers starting with 0 (or a bare
// 10-digit mobile) become 234…; numbers that already carry a code stay.
export function normalizePhone(phone) {
  if (typeof phone !== "string") throw new Error("phone must be text with a country code");
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length < 7) throw new Error("phone must have at least 7 digits");
  if (digits.startsWith("0")) return `234${digits.replace(/^0+/, "")}`;
  if (digits.startsWith("234")) return digits;
  if (digits.length === 10) return `234${digits}`;
  return digits;
}

export class CustomerStore {
  // dbPathOrDb: a path (owned connection) or a shared DatabaseSync.
  constructor(dbPathOrDb = ":memory:") {
    if (typeof dbPathOrDb === "string") {
      this.db = new DatabaseSync(dbPathOrDb);
      this.ownsDb = true;
    } else {
      this.db = dbPathOrDb;
      this.ownsDb = false;
    }
    this.db.exec(CUSTOMER_SCHEMA);
  }

  // Create or update by normalized name. A phone needs consent === true
  // (strict); without a phone no consent is needed. First-seen spelling is
  // kept; a null/undefined phone leaves the stored phone untouched.
  upsert({ shopId, name, phone = null, consent = null, createdAt = null, updatedAt = null }) {
    if (!shopId || typeof shopId !== "string") throw new Error("shopId is required");
    const clean = cleanName(name);
    const norm = normCustomerName(clean);
    let normalized = null;
    if (phone !== null && phone !== undefined) {
      if (consent !== true) throw new Error("consent: true is required to store a phone number");
      normalized = normalizePhone(phone);
    }
    const stamp = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT * FROM customers WHERE shop_id = ? AND name_norm = ?")
      .get(shopId, norm);
    if (!existing) {
      const result = this.db
        .prepare(
          "INSERT INTO customers (shop_id, name, name_norm, phone, consent_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(shopId, clean, norm, normalized, normalized ? (stamp) : null, createdAt ?? stamp, updatedAt ?? stamp);
      return this.get(Number(result.lastInsertRowid));
    }
    this.db
      .prepare("UPDATE customers SET phone = ?, consent_at = ?, updated_at = ? WHERE id = ?")
      .run(
        normalized ?? existing.phone,
        normalized ? stamp : existing.consent_at,
        updatedAt ?? stamp,
        existing.id
      );
    return this.get(existing.id);
  }

  // Forget-me: removes the phone and consent, keeps the customer row.
  clearPhone(id) {
    const row = this.get(id);
    if (!row) throw new Error(`customer ${id} not found`);
    this.db
      .prepare("UPDATE customers SET phone = NULL, consent_at = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return this.get(id);
  }

  get(id) {
    return this.db.prepare("SELECT * FROM customers WHERE id = ?").get(id) ?? null;
  }

  listByShop(shopId) {
    return this.db
      .prepare("SELECT * FROM customers WHERE shop_id = ? ORDER BY lower(name) ASC")
      .all(shopId);
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}

// One directory line per customer: stored rows plus names that exist only
// in the ledger (id and phone null). Balances come from debts.mjs;
// lastActivityAt is the newest ledger stamp for that name, any entry type.
// The shop's own id (self-restock marker) is never listed as a customer.
export function describeCustomers(directory, rows, shopId) {
  const debts = new Map(customerDebts(rows ?? [], {}).map((d) => [normCustomerName(d.customer), d.owedKobo]));
  const spellings = new Map();
  const lastSeen = new Map();
  for (const r of rows ?? []) {
    if (typeof r.customer !== "string") continue;
    if (r.customer === shopId) continue;
    const norm = normCustomerName(r.customer);
    if (!norm) continue;
    if (!spellings.has(norm)) spellings.set(norm, r.customer.trim());
    const stamp = String(r.created_at ?? "");
    if (stamp && (lastSeen.get(norm) === undefined || stamp > lastSeen.get(norm))) {
      lastSeen.set(norm, r.created_at);
    }
  }
  const out = [];
  const seen = new Set();
  for (const c of directory ?? []) {
    const norm = normCustomerName(c.name);
    seen.add(norm);
    out.push({
      id: c.id,
      name: c.name,
      phone: c.phone,
      owedKobo: debts.get(norm) ?? 0,
      lastActivityAt: lastSeen.get(norm) ?? null,
    });
  }
  for (const [norm, spelling] of spellings) {
    if (seen.has(norm)) continue;
    out.push({ id: null, name: spelling, phone: null, owedKobo: debts.get(norm) ?? 0, lastActivityAt: lastSeen.get(norm) ?? null });
  }
  out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return out;
}
