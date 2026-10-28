// Money Leak Report v1: separate leak categories over one shop's confirmed
// ledger rows and promises. Plain code only — the AI never touches a number.
// Categories stay separate and are never added into one number.
import { customerDebts, allocatedSales, effectiveEntries, stockKind, entrySign, lagosDay } from "./debts.mjs";

function normItem(value) {
  return String(value ?? "").trim().toLowerCase();
}

function stockDisplay(item, unit) {
  return unit ? `${item} (${unit})` : item;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Per (item, unit) stock group: restocks add, sales subtract. Units are
// lowercased and null units group together; rows without an item or
// quantity cannot be attributed and are skipped.
function stockGroups(rows) {
  const live = effectiveEntries(rows);
  const groups = new Map();
  for (const r of live) {
    const kind = stockKind(r, rows);
    if (!kind) continue;
    if (!Number.isInteger(r.quantity) || r.quantity <= 0) continue;
    const item = normItem(r.item);
    if (!item) continue;
    const unit = normItem(r.unit) || null;
    const key = `${item}|${unit ?? ""}`;
    if (!groups.has(key)) groups.set(key, { item, unit, stockedQty: 0, stockedKobo: 0, sales: [] });
    const g = groups.get(key);
    if (kind === "restock") {
      if (Number.isInteger(r.amount_kobo)) {
        g.stockedQty += r.quantity;
        g.stockedKobo += r.amount_kobo;
      }
    } else {
      g.sales.push(r);
    }
  }
  return [...groups.values()];
}

export function moneyLeakReport(ledgerRows, promises, { now = Date.now() } = {}) {
  const rows = ledgerRows ?? [];

  // (a) Total owed and the number of customers owing.
  const owing = customerDebts(rows, { now }).filter((d) => d.owedKobo > 0);
  const owed = {
    totalKobo: owing.reduce((t, d) => t + d.owedKobo, 0),
    customers: owing.length,
  };

  // (b) Overdue: unpaid remainders on sales strictly older than 30 days,
  // after oldest-first allocation.
  const overdue = {
    amountKobo: allocatedSales(rows, { now })
      .filter((s) => s.ageDays > 30)
      .reduce((t, s) => t + s.remainingKobo, 0),
  };

  // (c) Broken promises: count and outstanding amount (promised minus the
  // recorded paid part, clamped at zero; amount-less promises count only).
  const brokenRows = (promises ?? []).filter((p) => p.status === "broken");
  const broken = {
    count: brokenRows.length,
    amountKobo: brokenRows.reduce((t, p) => {
      if (p.amount_kobo === null || p.amount_kobo === undefined) return t;
      const paid = Number.isInteger(p.paid_kobo) && p.paid_kobo > 0 ? p.paid_kobo : 0;
      return t + Math.max(0, p.amount_kobo - paid);
    }, 0),
  };

  // (d) Items sold more than bought, biggest shortfall first — but only
  // when the item and unit has restock history. Sale groups with nothing
  // ever stocked are not shortfalls; they are counted separately.
  const groups = stockGroups(rows).map((g) => {
    const soldQty = g.sales.reduce((t, r) => t + r.quantity, 0);
    return {
      display: stockDisplay(g.item, g.unit),
      item: g.item,
      unit: g.unit,
      soldQty,
      stockedQty: g.stockedQty,
      shortfallQty: soldQty - g.stockedQty,
    };
  });
  const shortfalls = groups
    .filter((g) => g.stockedQty > 0 && g.shortfallQty > 0)
    .sort((a, b) => b.shortfallQty - a.shortfallQty || compareText(a.display, b.display));
  const noStockRecord = groups.filter((g) => g.soldQty > 0 && g.stockedQty <= 0).length;

  // (e) Below-cost sales: per item and unit, the quantity-weighted average
  // restock cost per unit (total kobo / total qty, rounded half-up to whole
  // kobo). A sale below it loses (average - unit price) x quantity. Items
  // with sales but no restock history are skipped and counted.
  const belowItems = [];
  let skippedItems = 0;
  for (const g of stockGroups(rows)) {
    if (g.sales.length === 0) continue;
    if (g.stockedQty <= 0) {
      skippedItems++;
      continue;
    }
    const avgCostKobo = Math.round(g.stockedKobo / g.stockedQty);
    let marginKobo = 0;
    for (const s of g.sales) {
      const unitPriceKobo = Math.round(s.amount_kobo / s.quantity);
      if (unitPriceKobo < avgCostKobo) marginKobo += (avgCostKobo - unitPriceKobo) * s.quantity;
    }
    if (marginKobo > 0) {
      belowItems.push({ display: stockDisplay(g.item, g.unit), item: g.item, unit: g.unit, marginKobo });
    }
  }
  belowItems.sort((a, b) => b.marginKobo - a.marginKobo || compareText(a.display, b.display));
  const belowCost = { items: belowItems, skippedItems };

  // Today's trading in Lagos time: sales recorded today, payments collected
  // today, and the entry count. Effective entries only, so a correction
  // replaces its original instead of double-counting it.
  const todayDay = lagosDay(now);
  const live = effectiveEntries(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  let soldTodayKobo = 0;
  let collectedTodayKobo = 0;
  let entriesToday = 0;
  for (const r of live) {
    if (lagosDay(Date.parse(r.created_at)) !== todayDay) continue;
    const sign = entrySign(r, byId);
    if (sign > 0) {
      soldTodayKobo += r.amount_kobo;
      entriesToday++;
    } else if (sign < 0) {
      collectedTodayKobo += r.amount_kobo;
      entriesToday++;
    }
  }
  const today = { soldTodayKobo, collectedTodayKobo, entriesToday };

  return { owed, overdue, broken, shortfalls, noStockRecord, belowCost, today };
}
