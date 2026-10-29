// Products catalog: one row per item + unit per shop, auto-created when a
// restock or sale confirms. Prices are set by the trader through the API
// only — the model never sets them. Stock is never stored: it is computed
// from the ledger (restocks minus sales, corrections respected), so the
// catalog can never drift from the chain.
import { DatabaseSync } from "node:sqlite";
import { effectiveEntries, stockKind } from "./debts.mjs";
import { costBasisByProduct, costBasisKey } from "./profit.mjs";

// Stock at or below this many units counts as low.
export const LOW_STOCK_AT = 3;

export const PRODUCT_SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) > 0),
  unit TEXT CHECK (unit IS NULL OR length(unit) > 0),
  sell_price_kobo INTEGER CHECK (sell_price_kobo IS NULL OR (typeof(sell_price_kobo) = 'integer' AND sell_price_kobo >= 0)),
  cost_price_kobo INTEGER CHECK (cost_price_kobo IS NULL OR (typeof(cost_price_kobo) = 'integer' AND cost_price_kobo >= 0)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_shop_name_unit ON products(shop_id, lower(name), COALESCE(unit, ''));
CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id);
`;

function cleanName(name) {
  const clean = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("product name is required");
  return clean;
}

function cleanUnit(unit) {
  if (unit === null || unit === undefined) return null;
  const clean = String(unit).trim().replace(/\s+/g, " ");
  return clean ? clean : null;
}

function assertPrice(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer (kobo)`);
  }
  return value;
}

export class ProductStore {
  // dbPathOrDb: a path (owned connection) or a shared DatabaseSync.
  constructor(dbPathOrDb = ":memory:") {
    if (typeof dbPathOrDb === "string") {
      this.db = new DatabaseSync(dbPathOrDb);
      this.ownsDb = true;
    } else {
      this.db = dbPathOrDb;
      this.ownsDb = false;
    }
    this.db.exec(PRODUCT_SCHEMA);
  }

  // Get-or-create by (shop, lowercased name, unit). First-seen spelling is
  // kept; prices start empty and are only ever set through setPrices.
  ensure({ shopId, name, unit = null, createdAt = null, updatedAt = null }) {
    if (!shopId || typeof shopId !== "string") throw new Error("shopId is required");
    const clean = cleanName(name);
    const cleanU = cleanUnit(unit);
    const stamp = createdAt ?? new Date().toISOString();
    this.db
      .prepare("INSERT OR IGNORE INTO products (shop_id, name, unit, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(shopId, clean, cleanU, stamp, updatedAt ?? stamp);
    return this.db
      .prepare("SELECT * FROM products WHERE shop_id = ? AND lower(name) = lower(?) AND COALESCE(unit, '') = COALESCE(?, '')")
      .get(shopId, clean, cleanU);
  }

  get(id) {
    return this.db.prepare("SELECT * FROM products WHERE id = ?").get(id) ?? null;
  }

  listByShop(shopId) {
    return this.db
      .prepare("SELECT * FROM products WHERE shop_id = ? ORDER BY lower(name) ASC, COALESCE(unit, '') ASC")
      .all(shopId);
  }

  // Trader-set prices only. Undefined leaves a price untouched; anything
  // else must be whole non-negative kobo.
  setPrices(id, { sellPriceKobo, costPriceKobo, updatedAt = null } = {}) {
    const row = this.get(id);
    if (!row) throw new Error(`product ${id} not found`);
    if (sellPriceKobo === undefined && costPriceKobo === undefined) {
      throw new Error("nothing to update: pass sellPriceKobo and/or costPriceKobo");
    }
    const sell = sellPriceKobo === undefined ? row.sell_price_kobo : assertPrice(sellPriceKobo, "sellPriceKobo");
    const cost = costPriceKobo === undefined ? row.cost_price_kobo : assertPrice(costPriceKobo, "costPriceKobo");
    this.db
      .prepare("UPDATE products SET sell_price_kobo = ?, cost_price_kobo = ?, updated_at = ? WHERE id = ?")
      .run(sell, cost, updatedAt ?? new Date().toISOString(), id);
    return this.get(id);
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}

function normStockText(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Stock key for one product: "item|unit", both lowercased, empty unit when
// the product has none. Same grouping as the leak report's stock lines.
export function productKey(name, unit) {
  return `${normStockText(name)}|${normStockText(unit)}`;
}

// On-hand quantities over effective ledger rows: restocks add, sales remove.
// Rows without a usable quantity or item cannot be attributed and are
// skipped, exactly like the leak report.
export function stockLevels(rows) {
  const levels = new Map();
  for (const r of effectiveEntries(rows)) {
    const kind = stockKind(r, rows);
    if (!kind) continue;
    if (!Number.isInteger(r.quantity) || r.quantity <= 0) continue;
    if (!normStockText(r.item)) continue;
    const key = productKey(r.item, r.unit);
    levels.set(key, (levels.get(key) ?? 0) + (kind === "restock" ? r.quantity : -r.quantity));
  }
  return levels;
}

// Catalog rows with computed stockOnHand (0 when nothing moved) and lowStock.
// The unit cost resolves in three steps, all in code: the trader's own
// price when set, else the weighted-average purchase cost from the ledger,
// else null ("unknown"). costSource names which one it is.
export function withStock(products, rows) {
  const levels = stockLevels(rows ?? []);
  const basis = costBasisByProduct(rows ?? []);
  return (products ?? []).map((p) => {
    const stockOnHand = levels.get(productKey(p.name, p.unit)) ?? 0;
    const b = basis.get(costBasisKey(p.name, p.unit));
    const avgCost = b && b.qty > 0 ? Math.round(b.kobo / b.qty) : null;
    const costPriceKobo = p.cost_price_kobo ?? avgCost ?? null;
    const costSource = p.cost_price_kobo != null ? "trader" : avgCost != null ? "purchases" : "unknown";
    return { ...p, stockOnHand, lowStock: stockOnHand <= LOW_STOCK_AT, costPriceKobo, costSource };
  });
}

// API shape for one stocked product row.
export function toProductJson(p) {
  return {
    id: p.id,
    name: p.name,
    unit: p.unit,
    sellPriceKobo: p.sell_price_kobo,
    costPriceKobo: p.costPriceKobo ?? p.cost_price_kobo ?? null,
    costSource: p.costSource ?? (p.cost_price_kobo != null ? "trader" : "unknown"),
    stockOnHand: p.stockOnHand ?? 0,
    lowStock: p.lowStock ?? true,
  };
}
