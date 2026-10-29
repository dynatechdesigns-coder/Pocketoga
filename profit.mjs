// Profit and expenses over one shop's confirmed ledger rows. Plain code
// only — the AI never touches a number. Periods follow the Lagos calendar.
// Sales and collected are never merged into one figure; corrections replace
// their originals, so nothing double-counts.
import { effectiveEntries, entrySign, stockKind, expenseKind, lagosDay, lagosWeekday, addDays } from "./debts.mjs";

export const PROFIT_PERIODS = ["today", "week", "month", "year"];

const lagosHourFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  hour: "2-digit",
  hourCycle: "h23",
});

// Clock hour "00".."23" in Africa/Lagos. hourCycle h23 keeps midnight "00"
// (some locales render it "24" with hour12: false).
export function lagosHour(ms) {
  return lagosHourFmt.format(ms);
}

// Lagos calendar bounds { from, to } ("YYYY-MM-DD", inclusive) for a period
// at `now`. Weeks run Monday to Sunday.
export function periodRange(period, now = Date.now()) {
  if (!PROFIT_PERIODS.includes(period)) {
    throw new Error(`unknown period "${String(period)}" (want today, week, month or year)`);
  }
  const today = lagosDay(now);
  if (period === "today") return { from: today, to: today };
  if (period === "week") {
    const sinceMonday = (lagosWeekday(now) + 6) % 7;
    const from = addDays(today, -sinceMonday);
    return { from, to: addDays(from, 6) };
  }
  if (period === "month") {
    const from = `${today.slice(0, 7)}-01`;
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    const nextFirst = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
    return { from, to: addDays(nextFirst, -1) };
  }
  const year = today.slice(0, 4);
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

function normStock(value) {
  return String(value ?? "").trim().toLowerCase();
}

// Cost-basis key for one (item, unit): lowercased, null units group
// together. Same grouping as the leak report.
export function costBasisKey(item, unit) {
  return `${normStock(item)}|${normStock(unit)}`;
}

// (item, unit) key for cost attribution; null when the row cannot be
// attributed (no item or no usable quantity).
function stockKey(row) {
  if (!Number.isInteger(row.quantity) || row.quantity <= 0) return null;
  if (!normStock(row.item)) return null;
  return costBasisKey(row.item, row.unit);
}

function emptyBucket(label) {
  return { label, salesKobo: 0, cogsKobo: 0, expensesKobo: 0, profitKobo: 0 };
}

// Full bucket grid for a period: 24 hours, every day from..to, or 12 months.
// Day labels are Lagos "YYYY-MM-DD", month labels "YYYY-MM": unambiguous.
function bucketLabels(period, from, to) {
  if (period === "today") return Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
  if (period === "year") return Array.from({ length: 12 }, (_, m) => `${from.slice(0, 4)}-${String(m + 1).padStart(2, "0")}`);
  const labels = [];
  for (let day = from; day <= to; day = addDays(day, 1)) labels.push(day);
  return labels;
}

function rowBucket(period, stamp) {
  if (period === "today") return lagosHour(stamp);
  if (period === "year") return lagosDay(stamp).slice(0, 7);
  return lagosDay(stamp);
}

// All-time restock cost basis per (item, unit): key -> { qty, kobo }.
// October sales run on September stock, so the basis ignores periods.
// Shared by profit (COGS) and the products catalog (unit cost from
// purchases); one grouping, no drift between the two.
export function costBasisByProduct(ledgerRows) {
  const rows = ledgerRows ?? [];
  const basis = new Map();
  for (const r of effectiveEntries(rows)) {
    if (stockKind(r, rows) !== "restock") continue;
    if (!Number.isInteger(r.amount_kobo)) continue;
    const key = stockKey(r);
    if (!key) continue;
    const b = basis.get(key) ?? { qty: 0, kobo: 0 };
    b.qty += r.quantity;
    b.kobo += r.amount_kobo;
    basis.set(key, b);
  }
  return basis;
}

// Profit for a period: sales and payments recorded inside from..to (Lagos),
// cost of goods from the all-time weighted restock average per item and
// unit, expenses recorded inside the period. Sales without restock history
// for their item and unit are skipped from cogs and counted once each in
// itemsWithoutCost; unattributed rows (no item or quantity) count sales
// but no cogs, exactly like the leak report.
//
// The net result is signed integer kobo and is never clamped: a loss stays
// negative. `result` names it ("profit", "loss", "break_even") and
// `resultKobo` carries the same amount as a positive number for display.
// `owedKobo` is this period's sales minus its collections, floored at zero:
// money still owed to the trader, beside the profit. `missing_cost_items`
// counts the distinct sold products with no cost price (same count as the
// older `itemsWithoutCost`, kept for older readers).
export function profitForPeriod(ledgerRows, period, { now = Date.now() } = {}) {
  const rows = ledgerRows ?? [];
  const { from, to } = periodRange(period, now);
  const live = effectiveEntries(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const basis = costBasisByProduct(rows);

  const buckets = new Map(bucketLabels(period, from, to).map((label) => [label, emptyBucket(label)]));
  let salesKobo = 0;
  let collectedKobo = 0;
  let cogsKobo = 0;
  let expensesKobo = 0;
  const noCostKeys = new Set();
  for (const r of live) {
    const stamp = Date.parse(r.created_at);
    const day = lagosDay(stamp);
    if (day < from || day > to) continue;
    const bucket = buckets.get(rowBucket(period, stamp));
    const sign = entrySign(r, byId);
    if (sign > 0) {
      salesKobo += r.amount_kobo;
      bucket.salesKobo += r.amount_kobo;
      const key = stockKey(r);
      if (key) {
        const cost = basis.get(key);
        if (!cost || cost.qty <= 0) {
          noCostKeys.add(key);
        } else {
          const rowCogs = Math.round(cost.kobo / cost.qty) * r.quantity;
          cogsKobo += rowCogs;
          bucket.cogsKobo += rowCogs;
        }
      }
    } else if (sign < 0) {
      collectedKobo += r.amount_kobo;
    }
    if (expenseKind(r, rows) === "expense") {
      expensesKobo += r.amount_kobo;
      bucket.expensesKobo += r.amount_kobo;
    }
  }
  const series = [...buckets.values()].map((b) => ({ ...b, profitKobo: b.salesKobo - b.cogsKobo - b.expensesKobo }));
  const estimatedProfitKobo = salesKobo - cogsKobo - expensesKobo;
  return {
    period,
    from,
    to,
    salesKobo,
    collectedKobo,
    cogsKobo,
    expensesKobo,
    estimatedProfitKobo,
    result: estimatedProfitKobo > 0 ? "profit" : estimatedProfitKobo < 0 ? "loss" : "break_even",
    resultKobo: Math.abs(estimatedProfitKobo),
    owedKobo: Math.max(0, salesKobo - collectedKobo),
    itemsWithoutCost: noCostKeys.size,
    missing_cost_items: noCostKeys.size,
    series,
  };
}

// Expenses recorded inside the period, oldest first, with a per-category
// breakdown (biggest category first). Corrections respected: only the
// effective entry counts, dated when it was recorded.
export function expensesForPeriod(ledgerRows, period, { now = Date.now() } = {}) {
  const rows = ledgerRows ?? [];
  const { from, to } = periodRange(period, now);
  const expenses = [];
  for (const r of effectiveEntries(rows)) {
    if (expenseKind(r, rows) !== "expense") continue;
    const day = lagosDay(Date.parse(r.created_at));
    if (day < from || day > to) continue;
    expenses.push({ id: r.id, createdAt: r.created_at, category: r.item, payee: r.customer, amountKobo: r.amount_kobo });
  }
  expenses.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id));
  const totals = new Map();
  for (const e of expenses) totals.set(e.category, (totals.get(e.category) ?? 0) + e.amountKobo);
  const byCategory = [...totals.entries()]
    .map(([category, amountKobo]) => ({ category, amountKobo }))
    .sort((a, b) => b.amountKobo - a.amountKobo || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  return { expenses, byCategory };
}
