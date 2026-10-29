// Corrections over HTTP: POST /ledger/:id/correct appends through the
// existing correction path; reasons live in corrections_log, never in the
// ledger. Fake data only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { PromiseStore } from "./promises.mjs";
import { effectiveEntries } from "./debts.mjs";
import { stockLevels } from "./products.mjs";
import { handleVoiceRequest, handleWebhookOnlyRequest } from "./server.mjs";

const SHOP_A = "shop-a";
const SHOP_B = "shop-b";

function setup() {
  const db = new DatabaseSync(":memory:");
  return { db, ledger: new Ledger(db), promises: new PromiseStore(db) };
}

function teardown(ctx) {
  ctx.db.close();
}

function fakeReq({ method = "GET", url = "/", headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = () => {};
  const text = body === undefined ? "" : JSON.stringify(body);
  process.nextTick(() => {
    if (text) req.emit("data", Buffer.from(text));
    req.emit("end");
  });
  return req;
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    text: "",
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    end(chunk) {
      if (chunk) this.text += String(chunk);
    },
  };
}

async function dispatch(deps, opts) {
  const res = fakeRes();
  try {
    await handleVoiceRequest(fakeReq(opts), res, deps);
  } catch (err) {
    res.writeHead(err.status ?? 500);
    res.end(JSON.stringify({ error: err.message ?? "internal error" }));
  }
  return { status: res.statusCode, json: JSON.parse(res.text) };
}

async function dispatchOnly(deps, opts) {
  const res = fakeRes();
  await handleWebhookOnlyRequest(fakeReq(opts), res, deps);
  return { status: res.statusCode, json: JSON.parse(res.text) };
}

function routeCtx() {
  const ctx = setup();
  return { ...ctx, deps: { ledger: ctx.ledger, promises: ctx.promises } };
}

describe("corrections_log", () => {
  it("stores reasons outside the ledger without touching its columns", () => {
    const ctx = setup();
    try {
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      const fix = ctx.ledger.appendCorrection(sale.id, { amountKobo: 1500000 });
      ctx.ledger.recordCorrectionReason(fix.id, "wrong amount, should be 15k");
      assert.equal(ctx.ledger.correctionReason(fix.id), "wrong amount, should be 15k");
      assert.equal(ctx.ledger.correctionReason(sale.id), null);

      // The ledger itself has no reason column and no reason value.
      const columns = ctx.db.prepare("PRAGMA table_info(ledger_entries)").all().map((c) => c.name);
      assert.ok(!columns.includes("reason"), columns.join(","));
      assert.ok(!("reason" in ctx.ledger.get(fix.id)));
      assert.ok(!JSON.stringify(ctx.ledger.list(SHOP_A)).includes("wrong amount"));

      for (const bad of ["", "   ", null, undefined]) {
        assert.throws(() => ctx.ledger.recordCorrectionReason(fix.id, bad), /reason/, `reason ${String(bad)}`);
      }
    } finally {
      teardown(ctx);
    }
  });
});

describe("POST /ledger/:id/correct", () => {
  it("appends through the correction path and returns entry plus verify", async () => {
    const ctx = routeCtx();
    try {
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" });
      const out = await dispatch(ctx.deps, {
        method: "POST",
        url: `/ledger/${sale.id}/correct`,
        headers: { "x-shop-id": SHOP_A },
        body: { amountKobo: 1500000, reason: "2 bags at 7.5k each" },
      });
      assert.equal(out.status, 200);
      assert.equal(out.json.entry.corrects_id, sale.id);
      assert.equal(out.json.entry.amount_kobo, 1500000);
      assert.equal(out.json.entry.type, "correction");
      // Untouched fields inherit the original.
      assert.equal(out.json.entry.customer, "Ada");
      assert.equal(out.json.entry.item, "rice");
      assert.deepEqual(out.json.verify, { ok: true, count: 2, shopId: SHOP_A });
      // The original row is untouched; the correction supersedes it.
      assert.equal(ctx.ledger.get(sale.id).amount_kobo, 2000000);
      assert.deepEqual(
        effectiveEntries(ctx.ledger.list(SHOP_A)).map((e) => e.amount_kobo),
        [1500000]
      );
      assert.equal(ctx.ledger.correctionReason(out.json.entry.id), "2 bags at 7.5k each");
    } finally {
      teardown(ctx);
    }
  });

  it("overrides only the fields given; explicit null clears item and unit", async () => {
    const ctx = routeCtx();
    try {
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" });
      const renamed = await dispatch(ctx.deps, {
        method: "POST",
        url: `/ledger/${sale.id}/correct`,
        headers: { "x-shop-id": SHOP_A },
        body: { customer: "Adaboy", reason: "wrong customer name" },
      });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.json.entry.customer, "Adaboy");
      assert.equal(renamed.json.entry.amount_kobo, 2000000);

      const cleared = await dispatch(ctx.deps, {
        method: "POST",
        url: `/ledger/${sale.id}/correct`,
        headers: { "x-shop-id": SHOP_A },
        body: { item: null, quantity: null, unit: null, reason: "was not rice" },
      });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.json.entry.item, null);
      assert.equal(cleared.json.entry.quantity, null);
      assert.equal(cleared.json.entry.unit, null);
    } finally {
      teardown(ctx);
    }
  });

  it("requires a reason, validates like any entry, and isolates shops", async () => {
    const ctx = routeCtx();
    try {
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      const headers = { "x-shop-id": SHOP_A };
      for (const body of [
        { amountKobo: 100 },
        { amountKobo: 100, reason: "" },
        { amountKobo: 100, reason: "   " },
        { amountKobo: 10.5, reason: "r" },
        { amountKobo: -5, reason: "r" },
        { amountKobo: "100", reason: "r" },
        { customer: "", reason: "r" },
        { quantity: 0, reason: "r" },
        { quantity: -2, reason: "r" },
        { quantity: 1.5, reason: "r" },
        { item: "", reason: "r" },
        { unit: "", reason: "r" },
      ]) {
        const bad = await dispatch(ctx.deps, { method: "POST", url: `/ledger/${sale.id}/correct`, headers, body });
        assert.equal(bad.status, 400, JSON.stringify(body));
      }

      const cross = await dispatch(ctx.deps, {
        method: "POST",
        url: `/ledger/${sale.id}/correct`,
        headers: { "x-shop-id": SHOP_B },
        body: { amountKobo: 100, reason: "other shop" },
      });
      assert.equal(cross.status, 403);

      const missing = await dispatch(ctx.deps, {
        method: "POST",
        url: "/ledger/9999/correct",
        headers,
        body: { amountKobo: 100, reason: "nothing there" },
      });
      assert.equal(missing.status, 404);

      const noShop = await dispatch(ctx.deps, {
        method: "POST",
        url: `/ledger/${sale.id}/correct`,
        body: { amountKobo: 100, reason: "no header" },
      });
      assert.equal(noShop.status, 400);
    } finally {
      teardown(ctx);
    }
  });

  it("a failed correction writes neither entry nor reason", async () => {
    const ctx = routeCtx();
    try {
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      const bad = await dispatch(ctx.deps, {
        method: "POST",
        url: `/ledger/${sale.id}/correct`,
        headers: { "x-shop-id": SHOP_A },
        body: { amountKobo: -5, reason: "bad money" },
      });
      assert.equal(bad.status, 400);
      assert.equal(ctx.ledger.list(SHOP_A).length, 1);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS c FROM corrections_log").get().c, 0);
    } finally {
      teardown(ctx);
    }
  });

  it("the webhook port 404s the correct route", async () => {
    const ctx = routeCtx();
    try {
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      assert.equal(
        (
          await dispatchOnly(ctx.deps, {
            method: "POST",
            url: `/ledger/${sale.id}/correct`,
            headers: { "x-shop-id": SHOP_A },
            body: { amountKobo: 100, reason: "tunneled" },
          })
        ).status,
        404
      );
    } finally {
      teardown(ctx);
    }
  });
});

describe("GET /ledger correction fields", () => {
  it("marks each entry with its latest correction and reason", async () => {
    const ctx = routeCtx();
    try {
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      const payment = ctx.ledger.append({ shopId: SHOP_A, type: "payment", amountKobo: 500000, customer: "Ada" });
      const headers = { "x-shop-id": SHOP_A };

      const first = await dispatch(ctx.deps, {
        method: "POST",
        url: `/ledger/${sale.id}/correct`,
        headers,
        body: { amountKobo: 1800000, reason: "first fix" },
      });
      const second = await dispatch(ctx.deps, {
        method: "POST",
        url: `/ledger/${sale.id}/correct`,
        headers,
        body: { amountKobo: 1500000, reason: "second fix" },
      });

      const out = await dispatch(ctx.deps, { url: "/ledger", headers });
      assert.equal(out.status, 200);
      const byId = new Map(out.json.entries.map((e) => [e.id, e]));
      // Latest correction wins for both fields.
      assert.equal(byId.get(sale.id).correctedById, second.json.entry.id);
      assert.equal(byId.get(sale.id).correctionReason, "second fix");
      // The older correction and the untouched payment show nulls.
      assert.equal(byId.get(first.json.entry.id).correctedById, null);
      assert.equal(byId.get(first.json.entry.id).correctionReason, null);
      assert.equal(byId.get(payment.id).correctedById, null);
      assert.equal(byId.get(payment.id).correctionReason, null);
      // Legacy corrections without a logged reason still link.
      const raw = ctx.ledger.appendCorrection(payment.id, { amountKobo: 400000 });
      const relisted = await dispatch(ctx.deps, { url: "/ledger", headers });
      const relistedById = new Map(relisted.json.entries.map((e) => [e.id, e]));
      assert.equal(relistedById.get(payment.id).correctedById, raw.id);
      assert.equal(relistedById.get(payment.id).correctionReason, null);
    } finally {
      teardown(ctx);
    }
  });
});

describe("corrections flow downstream", () => {
  it("debts, stock and the report follow a correction made through the route", async () => {
    const ctx = routeCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      const restock = ctx.ledger.append({ shopId: SHOP_A, type: "restock", amountKobo: 10000000, customer: SHOP_A, item: "rice", quantity: 10, unit: "bag" });
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada", item: "rice", quantity: 4, unit: "bag" });
      assert.equal(stockLevels(ctx.ledger.list(SHOP_A)).get("rice|bag"), 6);

      const fixed = await dispatch(ctx.deps, {
        method: "POST",
        url: `/ledger/${restock.id}/correct`,
        headers,
        body: { quantity: 7, reason: "only 7 bags arrived" },
      });
      assert.equal(fixed.status, 200);
      assert.equal(stockLevels(ctx.ledger.list(SHOP_A)).get("rice|bag"), 3);

      const saleFix = await dispatch(ctx.deps, {
        method: "POST",
        url: `/ledger/${sale.id}/correct`,
        headers,
        body: { amountKobo: 1200000, reason: "discounted" },
      });
      assert.equal(saleFix.status, 200);

      const debts = await dispatch(ctx.deps, { url: "/debts", headers });
      assert.equal(debts.status, 200);
      assert.equal(debts.json.debts.find((d) => d.customer === "Ada").owedKobo, 1200000);

      const report = await dispatch(ctx.deps, { url: "/report", headers });
      assert.equal(report.status, 200);
      assert.equal(report.json.report.owed.totalKobo, 1200000);
    } finally {
      teardown(ctx);
    }
  });
});
