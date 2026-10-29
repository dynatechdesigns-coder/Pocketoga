// Debt maths over confirmed ledger rows. Plain code only: the model never
// touches balances, allocation, ages or ranking. Functions take rows
// (ledger.list(shopId)) so shops never mix; "now" is injectable for tests.

const LAGOS_TZ = "Africa/Lagos";
const DAY_MS = 86400000;

const lagosDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: LAGOS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const lagosDowFmt = new Intl.DateTimeFormat("en-US", { timeZone: LAGOS_TZ, weekday: "short" });
const DOW_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// "YYYY-MM-DD" in Africa/Lagos.
export function lagosDay(ms) {
  return lagosDayFmt.format(ms);
}

// 0 = Sunday .. 6 = Saturday, in Africa/Lagos.
export function lagosWeekday(ms) {
  return DOW_INDEX[lagosDowFmt.format(ms)];
}

// Calendar-day arithmetic on "YYYY-MM-DD" days (exact: whole UTC days).
export function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(aDay, bDay) {
  return Math.round((Date.parse(`${bDay}T00:00:00Z`) - Date.parse(`${aDay}T00:00:00Z`)) / DAY_MS);
}

function normCustomer(name) {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Sign of one row: sales add, payments subtract, everything else is ignored.
// A correction counts with the corrected entry's sign, followed through
// chains; dangling or circular corrections count nothing.
export function entrySign(row, byId) {
  let cur = row;
  const seen = new Set();
  while (cur && cur.type === "correction") {
    if (cur.corrects_id === null || cur.corrects_id === undefined || seen.has(cur.id)) return 0;
    seen.add(cur.id);
    cur = byId.get(cur.corrects_id);
  }
  if (!cur) return 0;
  if (cur.type === "sale") return 1;
  if (cur.type === "payment") return -1;
  return 0;
}

// Rows with corrections applied: an entry counts unless a later entry
// corrects it — directly, or as a newer correction of the same original.
export function effectiveEntries(rows) {
  const ordered = [...(rows ?? [])].sort((a, b) => a.seq - b.seq || a.id - b.id);
  const superseded = new Set();
  const correctionsOf = new Map();
  for (const r of ordered) {
    if (r.corrects_id === null || r.corrects_id === undefined) continue;
    superseded.add(r.corrects_id);
    const sibs = correctionsOf.get(r.corrects_id) ?? [];
    for (const s of sibs) superseded.add(s.id);
    sibs.push(r);
    correctionsOf.set(r.corrects_id, sibs);
  }
  return ordered.filter((r) => !superseded.has(r.id));
}

// One debt line per customer (case-insensitive exact match, first-seen
// spelling kept): amount owed, oldest unpaid sale's age in days, and the
// last payment date. Payments apply to the oldest unpaid sale first.
export function customerDebts(rows, { now = Date.now() } = {}) {
  const today = lagosDay(now);
  const live = effectiveEntries(rows);
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));
  const groups = new Map();
  for (const r of live) {
    if (typeof r.customer !== "string") continue;
    const norm = normCustomer(r.customer);
    if (!norm) continue;
    if (!groups.has(norm)) groups.set(norm, { customer: r.customer.trim(), sales: [], payments: [] });
    const g = groups.get(norm);
    const sign = entrySign(r, byId);
    if (sign > 0) g.sales.push(r);
    else if (sign < 0) g.payments.push(r);
  }
  const out = [];
  for (const g of groups.values()) {
    g.sales.sort((a, b) => a.seq - b.seq || a.id - b.id);
    const salesKobo = g.sales.reduce((t, r) => t + r.amount_kobo, 0);
    const paidKobo = g.payments.reduce((t, r) => t + r.amount_kobo, 0);
    let pool = paidKobo;
    let oldest = null;
    for (const s of g.sales) {
      const applied = Math.min(s.amount_kobo, pool);
      pool -= applied;
      if (!oldest && applied < s.amount_kobo) oldest = s;
    }
    const lastPaymentAt =
      g.payments.length > 0
        ? g.payments.reduce((a, b) => (Date.parse(a.created_at) >= Date.parse(b.created_at) ? a : b)).created_at
        : null;
    out.push({
      customer: g.customer,
      owedKobo: salesKobo - paidKobo,
      salesKobo,
      paidKobo,
      oldestUnpaidAgeDays: oldest ? daysBetween(lagosDay(Date.parse(oldest.created_at)), today) : null,
      oldestUnpaidAt: oldest ? oldest.created_at : null,
      lastPaymentAt,
    });
  }
  return out;
}

// Per-sale oldest-first allocation: every effective sale with its unpaid
// remainder and age in days. Same pool rules as customerDebts. Each line
// also carries the row's id, item, quantity and unit so the /sales view can
// show what was sold, not just the money.
export function allocatedSales(rows, { now = Date.now() } = {}) {
  const today = lagosDay(now);
  const live = effectiveEntries(rows);
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));
  const groups = new Map();
  for (const r of live) {
    if (typeof r.customer !== "string") continue;
    const norm = normCustomer(r.customer);
    if (!norm) continue;
    if (!groups.has(norm)) groups.set(norm, { customer: r.customer.trim(), sales: [], paidKobo: 0 });
    const g = groups.get(norm);
    const sign = entrySign(r, byId);
    if (sign > 0) g.sales.push(r);
    else if (sign < 0) g.paidKobo += r.amount_kobo;
  }
  const out = [];
  for (const g of groups.values()) {
    g.sales.sort((a, b) => a.seq - b.seq || a.id - b.id);
    let pool = g.paidKobo;
    for (const s of g.sales) {
      const applied = Math.min(s.amount_kobo, pool);
      pool -= applied;
      out.push({
        id: s.id,
        customer: g.customer,
        item: s.item ?? null,
        quantity: Number.isInteger(s.quantity) ? s.quantity : null,
        unit: s.unit ?? null,
        amountKobo: s.amount_kobo,
        paidKobo: applied,
        remainingKobo: s.amount_kobo - applied,
        ageDays: daysBetween(lagosDay(Date.parse(s.created_at)), today),
        createdAt: s.created_at,
      });
    }
  }
  return out;
}

// Effective stock kind of one row: "sale" sells stock, "restock" adds it,
// anything else is null. Corrections take the corrected entry's kind.
export function stockKind(row, rows) {
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));
  let cur = row;
  const seen = new Set();
  while (cur && cur.type === "correction") {
    if (cur.corrects_id === null || cur.corrects_id === undefined || seen.has(cur.id)) return null;
    seen.add(cur.id);
    cur = byId.get(cur.corrects_id);
  }
  if (!cur) return null;
  if (cur.type === "sale") return "sale";
  if (cur.type === "restock") return "restock";
  return null;
}

// Effective expense kind of one row: "expense" for expenses, anything else
// null. Corrections take the corrected entry's kind, followed through
// chains; dangling or circular corrections count nothing.
export function expenseKind(row, rows) {
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));
  let cur = row;
  const seen = new Set();
  while (cur && cur.type === "correction") {
    if (cur.corrects_id === null || cur.corrects_id === undefined || seen.has(cur.id)) return null;
    seen.add(cur.id);
    cur = byId.get(cur.corrects_id);
  }
  if (!cur) return null;
  if (cur.type === "expense") return "expense";
  return null;
}

// Debtors only, biggest debt first.
export function owingDebts(rows, opts = {}) {
  return customerDebts(rows, opts)
    .filter((d) => d.owedKobo > 0)
    .sort((a, b) => b.owedKobo - a.owedKobo);
}

// Chase score (higher = chase first):
//   10 points per day the oldest unpaid sale is overdue
// + 500 points per broken promise
// + 1 point per whole ₦1,000 owed
// A missed promise date dominates because it is the strongest signal that
// the customer needs chasing; age beats amount so small old debts surface
// above big new ones.
export function chaseScore({ owedKobo, ageDays, broken }) {
  const age = Number.isInteger(ageDays) && ageDays > 0 ? ageDays : 0;
  const misses = Number.isInteger(broken) && broken > 0 ? broken : 0;
  const amount = Number.isInteger(owedKobo) && owedKobo > 0 ? Math.floor(owedKobo / 100000) : 0;
  return age * 10 + misses * 500 + amount;
}

// Broken-promise counts keyed by normalized customer name.
export function brokenCounts(promises) {
  const counts = new Map();
  for (const p of promises ?? []) {
    if (p.status !== "broken") continue;
    const k = normCustomer(p.customer);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

// Ranked chase list for one shop's rows and promises in one call.
export function chaseForShop(rows, promises, { now = Date.now() } = {}) {
  const broken = brokenCounts(promises);
  return rankChase(
    customerDebts(rows, { now }).map((d) => ({
      customer: d.customer,
      owedKobo: d.owedKobo,
      ageDays: d.oldestUnpaidAgeDays,
      broken: broken.get(normCustomer(d.customer)) ?? 0,
    }))
  );
}

// Ranked chase list: debtors only, score first, then bigger debt, then name.
export function rankChase(candidates) {
  return (candidates ?? [])
    .filter((c) => Number.isInteger(c.owedKobo) && c.owedKobo > 0)
    .map((c) => ({ ...c, score: chaseScore({ owedKobo: c.owedKobo, ageDays: c.ageDays, broken: c.broken }) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.owedKobo - a.owedKobo ||
        (normCustomer(a.customer) < normCustomer(b.customer) ? -1 : normCustomer(a.customer) > normCustomer(b.customer) ? 1 : 0)
    );
}
