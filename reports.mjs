// Monthly CSV export over confirmed ledger rows. Plain code only: no model,
// no caps, no writes. Callers pass one shop's rows (ledger.list(shopId)),
// so shops can never mix. Corrections replace their originals (same rule
// as profit and debts), so nothing double-counts; dangling correction
// chains count nothing. Amounts stay integer kobo until the final
// whole-naira.two-decimals rendering, which uses integer maths only.
import { effectiveEntries, customerDebts, allocatedSales, lagosDay, addDays } from "./debts.mjs";

export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

// UTF-8 byte-order mark, built from its code point so no invisible literal
// ever sits in this source file. Excel needs it to read the file correctly.
export const CSV_BOM = String.fromCharCode(0xfeff);

// Lagos calendar bounds { month, from, to } ("YYYY-MM-DD", inclusive) for
// one "YYYY-MM" month. Bad values throw a 400 with a plain message.
export function monthBounds(month) {
  if (typeof month !== "string" || !MONTH_RE.test(month)) {
    throw Object.assign(new Error("month must look like 2026-10"), { status: 400 });
  }
  const from = `${month}-01`;
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const nextFirst = mon === 12 ? `${year + 1}-01-01` : `${year}-${String(mon + 1).padStart(2, "0")}-01`;
  return { month, from, to: addDays(nextFirst, -1) };
}

// Missing or blank reads as the current month in Africa/Lagos.
export function parseReportMonth(value, nowMs = Date.now()) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return monthBounds(lagosDay(nowMs).slice(0, 7));
  return monthBounds(raw);
}

// Integer kobo to "whole.two-decimals" naira with integer maths only —
// never floats. Signed (a loss stays negative).
export function koboToNaira(kobo) {
  if (!Number.isInteger(kobo)) throw new Error("kobo must be an integer");
  const sign = kobo < 0 ? "-" : "";
  const abs = Math.abs(kobo);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// One CSV cell: a leading apostrophe neutralises formula injection on text
// cells starting with =, +, - or @; cells holding a comma, quote or line
// break are quoted with inner quotes doubled. Numbers from integer maths
// never need either treatment.
export function csvCell(value) {
  const s = String(value ?? "");
  if (/^[=+\-@]/.test(s)) return `"'${s.replace(/"/g, '""')}"`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(cells) {
  return cells.map(csvCell).join(",");
}

// One data row: text cells escaped, the amount passed through raw. Amounts
// come from integer kobo maths (never user text), and a negative Profit
// must stay a plain number — the injection guard is for text cells only.
export function csvEntryRow(date, type, customer, item, amountKobo) {
  return [csvCell(date), csvCell(type), csvCell(customer), csvCell(item), koboToNaira(amountKobo), ""].join(",");
}

// One summary line: both cells are code-built (fixed label, integer-maths
// number), so no escaping applies.
export function csvSummaryRow(label, value) {
  return `${label},${value}`;
}

// Effective kind of one row: corrections take the corrected entry's kind,
// followed through chains (same rule as debts and profit); unresolvable
// chains are null and never reach the file.
function entryKind(row, byId) {
  let cur = row;
  const seen = new Set();
  while (cur && cur.type === "correction") {
    if (cur.corrects_id === null || cur.corrects_id === undefined || seen.has(cur.id)) return null;
    seen.add(cur.id);
    cur = byId.get(cur.corrects_id);
  }
  if (!cur) return null;
  return cur.type;
}

// The file's Type for one effective row. Sales still owed at month end read
// "debt" (they are the entries behind "Debts still owed"); settled sales
// read "sale". Stock bought is money spent, so restock reads "expense".
function csvType(row, debtSaleIds, byId) {
  const kind = entryKind(row, byId);
  if (kind === "sale") return debtSaleIds.has(row.id) ? "debt" : "sale";
  if (kind === "payment") return "payment";
  if (kind === "expense" || kind === "restock") return "expense";
  return null;
}

// Full file text (UTF-8 BOM first, so Excel reads it correctly): one header
// row, one row per effective entry in the month (oldest first), a blank
// line, then the summary block. An empty month is a valid file: the header
// plus a summary of zeros. Only confirmed ledger rows are ever read —
// unconfirmed or rejected proposals live in the proposals table, never here.
export function buildMonthlyCsv(ledgerRows, month) {
  const { month: label, from, to } = monthBounds(month);
  const rows = ledgerRows ?? [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const live = effectiveEntries(rows)
    .filter((r) => entryKind(r, byId) !== null)
    .filter((r) => {
      const day = lagosDay(Date.parse(r.created_at));
      return day >= from && day <= to;
    })
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
  // What was still owed when the month ended: every entry on or before its
  // last day, oldest-first allocation per customer, positives only.
  const bounded = rows.filter((r) => lagosDay(Date.parse(r.created_at)) <= to);
  const debtSaleIds = new Set(
    allocatedSales(bounded, {}).filter((s) => s.remainingKobo > 0).map((s) => s.id)
  );
  const owedKobo = customerDebts(bounded, {}).reduce((t, d) => t + (d.owedKobo > 0 ? d.owedKobo : 0), 0);
  const lines = ["Date,Type,Customer,Item,Amount (Naira),Note"];
  let salesKobo = 0;
  let expensesKobo = 0;
  let count = 0;
  for (const r of live) {
    const type = csvType(r, debtSaleIds, byId);
    if (!type) continue;
    if (type === "sale" || type === "debt") salesKobo += r.amount_kobo;
    else if (type === "expense") expensesKobo += r.amount_kobo;
    else if (type !== "payment") continue;
    count += 1;
    lines.push(csvEntryRow(lagosDay(Date.parse(r.created_at)), type, r.customer, r.item ?? "", r.amount_kobo));
  }
  lines.push("");
  lines.push(csvSummaryRow("Total sales", koboToNaira(salesKobo)));
  lines.push(csvSummaryRow("Total expenses", koboToNaira(expensesKobo)));
  lines.push(csvSummaryRow("Profit", koboToNaira(salesKobo - expensesKobo)));
  lines.push(csvSummaryRow("Debts still owed", koboToNaira(owedKobo)));
  lines.push(csvSummaryRow("Number of entries", String(count)));
  return { month: label, from, to, csv: CSV_BOM + lines.join("\r\n") + "\r\n" };
}
