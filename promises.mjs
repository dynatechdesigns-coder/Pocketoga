// Promises: "Ada will pay ₦20,000 by Friday". Plain code only — the model
// supplies the trader's day-phrase, code resolves the date, and code alone
// marks promises kept or broken. Stored in their own table, mutable by
// design; the ledger is never touched from here.
import { DatabaseSync } from "node:sqlite";
import { lagosDay, lagosWeekday, addDays, effectiveEntries } from "./debts.mjs";

export const PROMISE_STATUSES = ["open", "kept", "broken", "cancelled"];

export const PROMISE_SCHEMA = `
CREATE TABLE IF NOT EXISTS promises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  customer TEXT NOT NULL,
  amount_kobo INTEGER CHECK (amount_kobo IS NULL OR (typeof(amount_kobo) = 'integer' AND amount_kobo >= 0)),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','kept','broken','cancelled')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_promises_shop ON promises(shop_id);
`;

function normCustomer(name) {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function assertDueDate(dueDate) {
  if (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || addDays(dueDate, 0) !== dueDate) {
    throw new Error(`due_date must be a real YYYY-MM-DD day, got: ${String(dueDate)}`);
  }
  return dueDate;
}

export class PromiseStore {
  // dbPathOrDb: a path (owned connection) or a shared DatabaseSync.
  constructor(dbPathOrDb = ":memory:") {
    if (typeof dbPathOrDb === "string") {
      this.db = new DatabaseSync(dbPathOrDb);
      this.ownsDb = true;
    } else {
      this.db = dbPathOrDb;
      this.ownsDb = false;
    }
    this.db.exec(PROMISE_SCHEMA);
  }

  create({ shopId, customer, amountKobo = null, dueDate, status = "open", createdAt = null, resolvedAt = null }) {
    if (!shopId || typeof shopId !== "string") throw new Error("shopId is required");
    if (!customer || typeof customer !== "string" || !customer.trim()) throw new Error("customer is required");
    if (amountKobo !== null && amountKobo !== undefined) {
      if (!Number.isInteger(amountKobo) || amountKobo < 0) throw new Error("amount_kobo must be null or an integer >= 0");
    }
    assertDueDate(dueDate);
    if (!PROMISE_STATUSES.includes(status)) throw new Error(`bad promise status: ${String(status)}`);
    const stamp = createdAt ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO promises
           (shop_id, customer, amount_kobo, due_date, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(shopId, customer.trim(), amountKobo ?? null, dueDate, status, stamp, resolvedAt ?? null);
    return this.get(Number(result.lastInsertRowid));
  }

  get(id) {
    return this.db.prepare("SELECT * FROM promises WHERE id = ?").get(id) ?? null;
  }

  listByShop(shopId) {
    return this.db.prepare("SELECT * FROM promises WHERE shop_id = ? ORDER BY id ASC").all(shopId);
  }

  listOpenByShop(shopId) {
    return this.db.prepare("SELECT * FROM promises WHERE shop_id = ? AND status = 'open' ORDER BY id ASC").all(shopId);
  }

  // Resolution only moves forward: open -> kept, broken or cancelled.
  resolve(id, { status, resolvedAt = null } = {}) {
    if (!["kept", "broken", "cancelled"].includes(status)) {
      throw new Error(`cannot resolve a promise as: ${String(status)}`);
    }
    this.db
      .prepare("UPDATE promises SET status = ?, resolved_at = ? WHERE id = ?")
      .run(status, resolvedAt ?? new Date().toISOString(), id);
    return this.get(id);
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}

const WEEKDAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

// Resolves the model's day-phrase to "YYYY-MM-DD" in Africa/Lagos: today,
// tomorrow, weekday names (the next occurrence, strictly future — a bare
// weekday never means today), "next week" (next Monday) and "end of month".
// Returns null when the phrase is ambiguous or unknown; callers must ask
// the trader instead of guessing.
export function resolvePromiseDate(phrase, nowMs = Date.now()) {
  const s = String(phrase ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  const today = lagosDay(nowMs);
  if (s === "today") return today;
  if (s === "tomorrow") return addDays(today, 1);
  if (s === "next week") {
    const delta = ((8 - lagosWeekday(nowMs)) % 7) || 7;
    return addDays(today, delta);
  }
  if (s === "end of month" || s === "end of the month") {
    const [y, m] = today.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${today.slice(0, 8)}${String(last).padStart(2, "0")}`;
  }
  const m = /^(?:(?:on|by|come)\s+)?([a-z]+)(?:\s+(morning|afternoon|evening|night))?$/.exec(s);
  if (!m) return null;
  const target = WEEKDAY_INDEX[m[1]];
  if (target === undefined) return null;
  const delta = ((target - lagosWeekday(nowMs) + 7) % 7) || 7;
  return addDays(today, delta);
}

function isPaymentLike(row, byId) {
  let cur = row;
  const seen = new Set();
  while (cur && cur.type === "correction") {
    if (cur.corrects_id === null || cur.corrects_id === undefined || seen.has(cur.id)) return false;
    seen.add(cur.id);
    cur = byId.get(cur.corrects_id);
  }
  return !!cur && cur.type === "payment";
}

// Effective status of an OPEN promise against one shop's ledger rows:
// kept when a qualifying payment exists on or before the due date (at least
// the promised amount, or any payment when no amount was promised); broken
// when the due date has passed with no payment at all on or before it;
// otherwise still open (a part-payment before the due date keeps it open).
export function promiseStatus(promise, shopRows, todayDay) {
  const want = normCustomer(promise.customer);
  const byId = new Map((shopRows ?? []).map((r) => [r.id, r]));
  const before = effectiveEntries(shopRows).filter(
    (r) =>
      isPaymentLike(r, byId) &&
      normCustomer(r.customer) === want &&
      lagosDay(Date.parse(r.created_at)) <= promise.due_date
  );
  const qualifying = before.filter(
    (r) => promise.amount_kobo === null || promise.amount_kobo === undefined || r.amount_kobo >= promise.amount_kobo
  );
  if (qualifying.length > 0) return "kept";
  if (todayDay > promise.due_date && before.length === 0) return "broken";
  return "open";
}

// Moves every open promise of one shop to its effective status, stamping
// resolved_at. Returns the transitions for callers that report them.
export function refreshPromises(store, ledger, shopId, { now = Date.now() } = {}) {
  if (!store || !ledger) return [];
  const today = lagosDay(now);
  const rows = ledger.list(shopId);
  const done = [];
  for (const p of store.listOpenByShop(shopId)) {
    const next = promiseStatus(p, rows, today);
    if (next === "kept" || next === "broken") {
      store.resolve(p.id, { status: next, resolvedAt: new Date(now).toISOString() });
      done.push({ id: p.id, to: next });
    }
  }
  return done;
}

// { kept, total, rate } over resolved (kept + broken) promises for one
// customer, case-insensitive; null when the customer has no resolved
// promises yet. Cancelled promises never count.
export function keptRate(promises, customer) {
  const want = normCustomer(customer);
  let kept = 0;
  let total = 0;
  for (const p of promises ?? []) {
    if (normCustomer(p.customer) !== want) continue;
    if (p.status === "kept") {
      kept++;
      total++;
    } else if (p.status === "broken") {
      total++;
    }
  }
  if (total === 0) return null;
  return { kept, total, rate: kept / total };
}
