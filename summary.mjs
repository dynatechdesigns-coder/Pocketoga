// Daily summary: opt-in evening message built entirely by code from the
// ledger — the model is never involved, so no number can be invented.
// SummaryStore keeps per-shop-and-number settings; collectDailySummary
// assembles one day's figures plus the single most important thing.
import { lagosDay, daysBetween, effectiveEntries, entrySign } from "./debts.mjs";
import { profitForPeriod } from "./profit.mjs";
import { withStock } from "./products.mjs";

export const SUMMARY_SCHEMA = `
CREATE TABLE IF NOT EXISTS summary_settings (
  shop_id TEXT NOT NULL,
  wa_number TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  hour INTEGER NOT NULL DEFAULT 20,
  last_sent_date TEXT,
  last_inbound_at INTEGER,
  pending_text TEXT,
  pending_date TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, wa_number)
);
`;

export const SUMMARY_DEFAULT_HOUR = 20;
export const SUMMARY_MIN_HOUR = 17;
export const SUMMARY_MAX_HOUR = 23;
const DAY_MS = 24 * 3600 * 1000;

export class SummaryStore {
  constructor(db) {
    this.db = db;
    db.exec(SUMMARY_SCHEMA);
  }

  get(shopId, digits) {
    return (
      this.db
        .prepare("SELECT * FROM summary_settings WHERE shop_id = ? AND wa_number = ?")
        .get(shopId, digits) ?? null
    );
  }

  // Enables or disables the daily message. A null hour keeps the stored one
  // (or the 8 PM default for a new row); any other hour must be 17-23.
  setEnabled(shopId, digits, enabled, hour = null, nowMs = Date.now()) {
    if (hour !== null && hour !== undefined && (!Number.isInteger(hour) || hour < SUMMARY_MIN_HOUR || hour > SUMMARY_MAX_HOUR)) {
      throw new Error(`summary hour must be ${SUMMARY_MIN_HOUR} to ${SUMMARY_MAX_HOUR}`);
    }
    const stamp = new Date(nowMs).toISOString();
    const current = this.get(shopId, digits);
    const keepHour = hour === null || hour === undefined ? (current?.hour ?? SUMMARY_DEFAULT_HOUR) : hour;
    this.db
      .prepare(
        `INSERT INTO summary_settings (shop_id, wa_number, enabled, hour, last_sent_date, last_inbound_at, pending_text, pending_date, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop_id, wa_number) DO UPDATE SET enabled = excluded.enabled, hour = excluded.hour, updated_at = excluded.updated_at`
      )
      .run(
        shopId, digits, enabled ? 1 : 0, keepHour,
        current?.last_sent_date ?? null, current?.last_inbound_at ?? null,
        current?.pending_text ?? null, current?.pending_date ?? null, stamp
      );
    return this.get(shopId, digits);
  }

  // Records the trader's latest inbound message (any type). Creates a
  // disabled row when none exists so the 24-hour window is always known.
  touchInbound(shopId, digits, nowMs = Date.now()) {
    const stamp = new Date(nowMs).toISOString();
    const current = this.get(shopId, digits);
    if (!current) {
      this.db
        .prepare(
          "INSERT INTO summary_settings (shop_id, wa_number, enabled, hour, last_sent_date, last_inbound_at, pending_text, pending_date, updated_at) VALUES (?, ?, 0, ?, NULL, ?, NULL, NULL, ?)"
        )
        .run(shopId, digits, SUMMARY_DEFAULT_HOUR, nowMs, stamp);
      return this.get(shopId, digits);
    }
    this.db
      .prepare("UPDATE summary_settings SET last_inbound_at = ?, updated_at = ? WHERE shop_id = ? AND wa_number = ?")
      .run(nowMs, stamp, shopId, digits);
    return this.get(shopId, digits);
  }

  markSent(shopId, digits, day) {
    this.db
      .prepare("UPDATE summary_settings SET last_sent_date = ?, updated_at = ? WHERE shop_id = ? AND wa_number = ?")
      .run(day, new Date().toISOString(), shopId, digits);
  }

  setPending(shopId, digits, text, day) {
    this.db
      .prepare("UPDATE summary_settings SET pending_text = ?, pending_date = ?, updated_at = ? WHERE shop_id = ? AND wa_number = ?")
      .run(text, day, new Date().toISOString(), shopId, digits);
  }

  // Returns the waiting summary and clears it, or null when none waits.
  takePending(shopId, digits) {
    const row = this.get(shopId, digits);
    if (!row?.pending_text) return null;
    this.db
      .prepare("UPDATE summary_settings SET pending_text = NULL, pending_date = NULL, updated_at = ? WHERE shop_id = ? AND wa_number = ?")
      .run(new Date().toISOString(), shopId, digits);
    return { text: row.pending_text, date: row.pending_date };
  }

  listEnabled() {
    return this.db.prepare("SELECT * FROM summary_settings WHERE enabled = 1 ORDER BY shop_id ASC, wa_number ASC").all();
  }
}

// One day's figures plus the single most important thing, all from recorded
// rows — no model, no guesses. Returns null on a day with no entries and no
// promises due, which the caller skips silently (an explicit "summary now"
// still gets a short nothing-today line from its own caller).
export function collectDailySummary({ shopId, rows = [], openPromises = [], catalog = [], paymentChecks = [], now = Date.now() } = {}) {
  const today = lagosDay(now);
  const profit = profitForPeriod(rows ?? [], "today", { now });
  const live = effectiveEntries(rows ?? []);
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));
  const todayRows = live.filter((r) => {
    const stamp = Date.parse(r.created_at);
    return Number.isFinite(stamp) && lagosDay(stamp) === today;
  });
  const open = (openPromises ?? []).filter((p) => p && p.status === "open");
  const due = open
    .filter((p) => typeof p.due_date === "string" && p.due_date <= today)
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  if (todayRows.length === 0 && due.length === 0) return null;

  let highlight = null;
  if (due.length > 0) {
    const top = due[0];
    highlight = {
      kind: "promise",
      customer: top.customer,
      amountKobo: Number.isInteger(top.amount_kobo) ? top.amount_kobo : null,
      overdueDays: Math.max(0, daysBetween(top.due_date, today)),
    };
  } else {
    // New debt per customer from today's entries: today's sales minus
    // today's payments. First-seen spelling is kept for the message.
    const net = new Map();
    for (const r of todayRows) {
      if (typeof r.customer !== "string" || !r.customer.trim() || r.customer === shopId) continue;
      if (!Number.isInteger(r.amount_kobo)) continue;
      const sign = entrySign(r, byId);
      if (sign === 0) continue;
      const key = r.customer.trim().toLowerCase().replace(/\s+/g, " ");
      const cur = net.get(key) ?? { name: r.customer.trim(), kobo: 0 };
      cur.kobo += sign > 0 ? r.amount_kobo : -r.amount_kobo;
      net.set(key, cur);
    }
    let biggest = null;
    if (profit.salesKobo > 0) {
      for (const cur of net.values()) {
        if (cur.kobo > profit.salesKobo * 0.2 && (!biggest || cur.kobo > biggest.kobo)) biggest = cur;
      }
    }
    if (biggest) {
      highlight = { kind: "debt", customer: biggest.name, amountKobo: biggest.kobo };
    } else {
      const low = withStock(catalog ?? [], rows ?? []).filter((p) => p.lowStock);
      low.sort((a, b) => a.stockOnHand - b.stockOnHand || String(a.name).localeCompare(String(b.name)));
      if (low.length > 0) {
        highlight = { kind: "stock", name: low[0].name, unit: low[0].unit, stockOnHand: low[0].stockOnHand };
      } else {
        const stale = (paymentChecks ?? []).find((c) => {
          const stamp = Date.parse(c?.created_at);
          return Number.isFinite(stamp) && now - stamp > DAY_MS;
        });
        if (stale) {
          highlight = {
            kind: "transfer",
            amountKobo: Number.isInteger(stale.amount_kobo) ? stale.amount_kobo : null,
            ageDays: Math.max(1, Math.floor((now - Date.parse(stale.created_at)) / DAY_MS)),
          };
        } else {
          highlight = { kind: "none" };
        }
      }
    }
  }

  return {
    date: today,
    salesKobo: profit.salesKobo,
    collectedKobo: profit.collectedKobo,
    expensesKobo: profit.expensesKobo,
    estimatedProfitKobo: profit.estimatedProfitKobo,
    result: profit.result,
    resultKobo: profit.resultKobo,
    owedKobo: profit.owedKobo,
    missingCost: profit.missing_cost_items,
    highlight,
  };
}
