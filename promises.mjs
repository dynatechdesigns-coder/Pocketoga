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
  resolved_at TEXT,
  paid_kobo INTEGER CHECK (paid_kobo IS NULL OR (typeof(paid_kobo) = 'integer' AND paid_kobo >= 0))
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
    // Databases created before the paid_kobo column get it now.
    const columns = this.db
      .prepare("PRAGMA table_info(promises)")
      .all()
      .map((c) => c.name);
    if (!columns.includes("paid_kobo")) {
      this.db.exec("ALTER TABLE promises ADD COLUMN paid_kobo INTEGER CHECK (paid_kobo IS NULL OR (typeof(paid_kobo) = 'integer' AND paid_kobo >= 0))");
    }
  }

  create({ shopId, customer, amountKobo = null, dueDate, status = "open", createdAt = null, resolvedAt = null, paidKobo = null }) {
    if (!shopId || typeof shopId !== "string") throw new Error("shopId is required");
    if (!customer || typeof customer !== "string" || !customer.trim()) throw new Error("customer is required");
    if (amountKobo !== null && amountKobo !== undefined) {
      if (!Number.isInteger(amountKobo) || amountKobo < 0) throw new Error("amount_kobo must be null or an integer >= 0");
    }
    if (paidKobo !== null && paidKobo !== undefined) {
      if (!Number.isInteger(paidKobo) || paidKobo < 0) throw new Error("paid_kobo must be null or an integer >= 0");
    }
    assertDueDate(dueDate);
    if (!PROMISE_STATUSES.includes(status)) throw new Error(`bad promise status: ${String(status)}`);
    const stamp = createdAt ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO promises
           (shop_id, customer, amount_kobo, due_date, status, created_at, resolved_at, paid_kobo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(shopId, customer.trim(), amountKobo ?? null, dueDate, status, stamp, resolvedAt ?? null, paidKobo ?? null);
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
  resolve(id, { status, resolvedAt = null, paidKobo = null } = {}) {
    if (!["kept", "broken", "cancelled"].includes(status)) {
      throw new Error(`cannot resolve a promise as: ${String(status)}`);
    }
    if (paidKobo !== null && paidKobo !== undefined && (!Number.isInteger(paidKobo) || paidKobo < 0)) {
      throw new Error("paid_kobo must be null or an integer >= 0");
    }
    this.db
      .prepare("UPDATE promises SET status = ?, resolved_at = ?, paid_kobo = ? WHERE id = ?")
      .run(status, resolvedAt ?? new Date().toISOString(), paidKobo ?? null, id);
    return this.get(id);
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}

const WEEKDAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thurs: 4, fri: 5, sat: 6,
};

const NUMBER_WORDS = {
  a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function parseCount(word) {
  if (/^\d+$/.test(word)) return Number(word);
  return NUMBER_WORDS[word] ?? null;
}

// Resolves the model's day-phrase to "YYYY-MM-DD" in Africa/Lagos. Weeks
// start Monday. Covered forms: today, tomorrow, bare weekdays (the next
// upcoming one, strictly future — never today), "next week" (next Monday),
// "end of month", a weekday of next week in either order ("wednesday next
// week", "next friday"), "in N days|weeks" (digits or number words),
// "next next week" (the Monday after next) and "this weekend" (the upcoming
// Saturday, today when today is Saturday). Leading on|by|come, trailing
// time-of-day words and trailing punctuation are ignored. Returns null for
// anything else; callers show "no pay date" instead of asking.
export function resolvePromiseDate(phrase, nowMs = Date.now()) {
  const s = String(phrase ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.,;]+$/, "");
  if (!s) return null;
  const today = lagosDay(nowMs);
  if (s === "today") return today;
  if (s === "tomorrow") return addDays(today, 1);
  const core = s.replace(/^(on|by|come)\s+/, "").replace(/\s+(morning|afternoon|evening|night)$/, "");
  const mondayDelta = ((8 - lagosWeekday(nowMs)) % 7) || 7; // next Monday, strictly future
  if (core === "next week") return addDays(today, mondayDelta);
  if (core === "next next week") return addDays(today, mondayDelta + 7);
  if (core === "this weekend") {
    const saturdayDelta = (6 - lagosWeekday(nowMs) + 7) % 7;
    return addDays(today, saturdayDelta);
  }
  if (core === "end of month" || core === "end of the month") {
    const [y, m] = today.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${today.slice(0, 8)}${String(last).padStart(2, "0")}`;
  }
  let m = /^in\s+(\w+)\s+(days?|weeks?)$/.exec(core);
  if (m) {
    const n = parseCount(m[1]);
    if (n !== null && n > 0) return addDays(today, m[2].startsWith("week") ? n * 7 : n);
    return null;
  }
  m = /^([a-z]+)\s+next\s+week$/.exec(core) ?? /^next\s+([a-z]+)$/.exec(core);
  if (m) {
    const target = WEEKDAY_INDEX[m[1]];
    if (target === undefined) return null;
    return addDays(today, mondayDelta + ((target - 1 + 7) % 7));
  }
  if (/^[a-z]+$/.test(core) && WEEKDAY_INDEX[core] !== undefined) {
    const delta = ((WEEKDAY_INDEX[core] - lagosWeekday(nowMs) + 7) % 7) || 7;
    return addDays(today, delta);
  }
  return null;
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

// Payments by one customer inside a promise's window: strictly after the
// promise was created (so earlier payments, including any saved in the same
// confirmation, never count) and on or before the due date, end of that day
// in Africa/Lagos. Effective rows, so corrected payments count corrected.
function promisePayments(promise, shopRows) {
  const want = normCustomer(promise.customer);
  const createdAt = Date.parse(promise.created_at);
  const byId = new Map((shopRows ?? []).map((r) => [r.id, r]));
  return effectiveEntries(shopRows).filter(
    (r) =>
      isPaymentLike(r, byId) &&
      normCustomer(r.customer) === want &&
      Number.isFinite(createdAt) &&
      Date.parse(r.created_at) > createdAt &&
      lagosDay(Date.parse(r.created_at)) <= promise.due_date
  );
}

// What the customer paid toward a promise by its due date, in kobo.
export function promisePaidKobo(promise, shopRows) {
  return promisePayments(promise, shopRows).reduce((t, r) => t + r.amount_kobo, 0);
}

// Effective status of an OPEN promise against one shop's ledger rows:
// kept when a qualifying payment exists inside the window (at least the
// promised amount, or any payment when no amount was promised); broken when
// the due date has passed without that — including past-due part payments,
// whose paid part is recorded separately; otherwise still open. A payment
// after the due date never makes it kept.
export function promiseStatus(promise, shopRows, todayDay) {
  const before = promisePayments(promise, shopRows);
  const qualifying = before.filter(
    (r) => promise.amount_kobo === null || promise.amount_kobo === undefined || r.amount_kobo >= promise.amount_kobo
  );
  if (qualifying.length > 0) return "kept";
  if (todayDay > promise.due_date) return "broken";
  return "open";
}

// Moves every open promise of one shop to its effective status, stamping
// resolved_at and recording the paid part. Returns the transitions for
// callers that report them.
export function refreshPromises(store, ledger, shopId, { now = Date.now() } = {}) {
  if (!store || !ledger) return [];
  const today = lagosDay(now);
  const rows = ledger.list(shopId);
  const done = [];
  for (const p of store.listOpenByShop(shopId)) {
    const next = promiseStatus(p, rows, today);
    if (next === "kept" || next === "broken") {
      store.resolve(p.id, { status: next, resolvedAt: new Date(now).toISOString(), paidKobo: promisePaidKobo(p, rows) });
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
