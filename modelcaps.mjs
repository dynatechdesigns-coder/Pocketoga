// Daily caps on paid model calls (Meta text/audio/image + Baseten second
// opinion), reset at midnight Africa/Lagos. Counts live in the existing
// SQLite database, so a restart within the same day keeps them. Only model
// calls are counted — ledger reads, manual entry, health and every other
// code-only path never touch the caps. Fake data only in tests; the mock
// model client stands in for the network.
import { DatabaseSync } from "node:sqlite";
import { lagosDay } from "./debts.mjs";
import { DEMO_SHOP_ID } from "./auth.mjs";

// One config place for the three budgets, overridable by environment.
export const DAILY_CAP_DEFAULTS = { demo: 40, shop: 200, service: 1500 };

export function resolveDailyCaps(env = process.env) {
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    demo: num(env.DAILY_CAP_DEMO, DAILY_CAP_DEFAULTS.demo),
    shop: num(env.DAILY_CAP_SHOP, DAILY_CAP_DEFAULTS.shop),
    service: num(env.DAILY_CAP_SERVICE, DAILY_CAP_DEFAULTS.service),
  };
}

export const MODEL_DAILY_CAP_MESSAGE = "PocketOga has reached today's limit. Please try again tomorrow.";

export function modelCapError() {
  return Object.assign(new Error(MODEL_DAILY_CAP_MESSAGE), { status: 429, code: "MODEL_DAILY_CAP" });
}

export function isModelCapError(err) {
  return !!err && err.code === "MODEL_DAILY_CAP";
}

export const MODEL_CAP_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_call_counts (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope, key)
);
`;

export class ModelCapStore {
  // dbPathOrDb: a path (owned connection) or a shared DatabaseSync.
  constructor(dbPathOrDb = ":memory:") {
    if (typeof dbPathOrDb === "string") {
      this.db = new DatabaseSync(dbPathOrDb);
      this.ownsDb = true;
    } else {
      this.db = dbPathOrDb;
      this.ownsDb = false;
    }
    this.db.exec(MODEL_CAP_SCHEMA);
  }

  dayFor(now = Date.now()) {
    return lagosDay(now);
  }

  countFor(day, scope, key) {
    const row = this.db
      .prepare("SELECT count AS c FROM model_call_counts WHERE day = ? AND scope = ? AND key = ?")
      .get(day, scope, key);
    return row ? row.c : 0;
  }

  counts(shopId, now = Date.now()) {
    const day = this.dayFor(now);
    return {
      day,
      shop: this.countFor(day, "shop", shopId),
      service: this.countFor(day, "service", "service"),
    };
  }

  // Records one model call for this shop and the whole service, in one
  // transaction so concurrent calls cannot both slip past a full bucket.
  // Throws modelCapError() (status 429, plain message) when the shop's own
  // budget (demo or real) or the service budget is already spent. Counts
  // nothing on the capped path.
  charge(shopId, { caps = DAILY_CAP_DEFAULTS, isDemo = shopId === DEMO_SHOP_ID, now = Date.now() } = {}) {
    const day = this.dayFor(now);
    const limit = isDemo ? caps.demo : caps.shop;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const shop = this.countFor(day, "shop", shopId);
      const service = this.countFor(day, "service", "service");
      if (shop >= limit || service >= caps.service) {
        this.db.exec("ROLLBACK");
        throw modelCapError();
      }
      this.db
        .prepare("INSERT INTO model_call_counts (day, scope, key, count) VALUES (?, 'shop', ?, 1) ON CONFLICT(day, scope, key) DO UPDATE SET count = count + 1")
        .run(day, shopId);
      this.db
        .prepare("INSERT INTO model_call_counts (day, scope, key, count) VALUES (?, 'service', 'service', 1) ON CONFLICT(day, scope, key) DO UPDATE SET count = count + 1")
        .run(day);
      this.db.exec("COMMIT");
      return { day, shop: shop + 1, service: service + 1 };
    } catch (err) {
      if (err?.code === "MODEL_DAILY_CAP") throw err;
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw err;
    }
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}

// Wraps a model client so every complete() call charges the daily cap
// first. A spent cap throws modelCapError() before any network happens, so
// no credits burn; anything else (including the mock client) is delegated
// untouched. A missing charge function means uncapped (tests, scripts).
export function withModelCap(model, charge) {
  if (!model || typeof model.complete !== "function") return model;
  if (typeof charge !== "function") return model;
  return { ...model, complete: async (request) => { await charge(); return model.complete(request); } };
}

// Wraps a fetch function the same way, for the Baseten second-opinion
// path (fetchSecondReading degrades a throw to "not available", so a spent
// cap quietly skips the second opinion instead of failing the note).
export function withFetchCap(fetchFn, charge) {
  const base = fetchFn ?? fetch;
  if (typeof charge !== "function") return base;
  return async (url, opts) => { await charge(); return base(url, opts); };
}
