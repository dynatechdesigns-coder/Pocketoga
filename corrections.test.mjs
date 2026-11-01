// Corrections over HTTP: POST /ledger/:id/correct appends through the
// existing correction path; reasons live in corrections_log, never in the
// ledger. Fake data only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { PromiseStore } from "./promises.mjs";
import { createMockModelClient } from "./model.mjs";
import { effectiveEntries, lagosDay } from "./debts.mjs";
import { buildMonthlyCsv } from "./reports.mjs";
import { IdempotencyStore } from "./idempotency.mjs";
import { stockLevels } from "./products.mjs";
import { handleVoiceRequest, handleWebhookOnlyRequest } from "./server.mjs";
import { AuthStore, DEMO_SHOP_ID } from "./auth.mjs";

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

// Tests log in transparently: the first request for a shop mints a session
// through the real issue+exchange path (the login flow itself is tested in
// auth.test.mjs). Explicit authorization headers always win.
function tokenFor(deps, shop) {
  deps._testTokens ??= new Map();
  if (!deps._testTokens.has(shop)) {
    const issued = deps.auths.issueCode(shop, `test-login-${shop}`, {});
    const exchanged = deps.auths.exchangeCode(shop, issued.code, {});
    if (!exchanged.ok) throw new Error(`test login failed: ${exchanged.reason}`);
    deps._testTokens.set(shop, exchanged.token);
  }
  return deps._testTokens.get(shop);
}

async function dispatch(deps, opts) {
  const headers = { ...(opts.headers ?? {}) };
  const shop = headers["x-shop-id"];
  if (shop && shop !== DEMO_SHOP_ID && !headers.authorization && !headers.Authorization && deps.auths) {
    headers.authorization = `Bearer ${tokenFor(deps, shop)}`;
  }
  const res = fakeRes();
  try {
    await handleVoiceRequest(fakeReq({ ...opts, headers }), res, deps);
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
  const auths = new AuthStore(ctx.db);
  return { ...ctx, auths, deps: { ledger: ctx.ledger, promises: ctx.promises, auths } };
}

// Full loop for the propose/confirm correction flow: proposals for the
// route and confirm, a mock model for fix.
function flowCtx(modelHandler = null) {
  const db = new DatabaseSync(":memory:");
  const ledger = new Ledger(db);
  const proposals = new ProposalStore(db);
  const promises = new PromiseStore(db);
  const model = createMockModelClient(
    modelHandler ?? (async () => {
      throw new Error("model should not be called");
    })
  );
  const auths = new AuthStore(db);
  return { db, ledger, proposals, promises, model, auths, deps: { ledger, proposals, promises, model, auths } };
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

describe("POST /correct-last", () => {
  it("proposes the latest entry and records nothing until confirm", async () => {
    const ctx = flowCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      const latest = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 3000000, customer: "Bola", item: "rice", quantity: 2, unit: "bag" });
      const out = await dispatch(ctx.deps, {
        method: "POST",
        url: "/correct-last",
        headers,
        body: { amountKobo: 2500000, reason: "discounted" },
      });
      assert.equal(out.status, 201);
      const p = out.json.proposal;
      assert.equal(p.correctionOf, latest.id);
      assert.equal(p.correctionReason, "discounted");
      assert.equal(p.entries.length, 1);
      assert.deepEqual(
        [p.entries[0].type, p.entries[0].amountKobo, p.entries[0].customer, p.entries[0].item, p.entries[0].quantity, p.entries[0].unit],
        ["sale", 2500000, "Bola", "rice", 2, "bag"]
      );
      assert.deepEqual(p.flags, []);
      assert.equal(ctx.ledger.list(SHOP_A).length, 2);

      const confirmed = await dispatch(ctx.deps, { method: "POST", url: `/confirm/${p.id}`, headers });
      assert.equal(confirmed.status, 200);
      assert.equal(confirmed.json.alreadyConfirmed, false);
      assert.equal(confirmed.json.recordedIds.length, 1);
      const rows = ctx.ledger.list(SHOP_A);
      assert.equal(rows.length, 3);
      const created = ctx.ledger.get(confirmed.json.recordedIds[0]);
      assert.equal(created.type, "correction");
      assert.equal(created.corrects_id, latest.id);
      assert.equal(created.amount_kobo, 2500000);
      assert.equal(created.seq, 3);
      assert.equal(created.prev_hash, latest.entry_hash);
      assert.equal(ctx.ledger.get(latest.id).amount_kobo, 3000000);
      assert.equal(ctx.ledger.correctionReason(created.id), "discounted");
      assert.deepEqual(ctx.ledger.verify(SHOP_A), { ok: true, count: 3, shopId: SHOP_A });
    } finally {
      teardown(ctx);
    }
  });

  it("confirming twice records once", async () => {
    const ctx = flowCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 3000000, customer: "Bola" });
      const out = await dispatch(ctx.deps, { method: "POST", url: "/correct-last", headers, body: { amountKobo: 2500000, reason: "discounted" } });
      const first = await dispatch(ctx.deps, { method: "POST", url: `/confirm/${out.json.proposal.id}`, headers });
      assert.equal(first.json.alreadyConfirmed, false);
      const second = await dispatch(ctx.deps, { method: "POST", url: `/confirm/${out.json.proposal.id}`, headers });
      assert.equal(second.status, 200);
      assert.equal(second.json.alreadyConfirmed, true);
      assert.equal(ctx.ledger.list(SHOP_A).length, 2);
      assert.equal(ctx.ledger.list(SHOP_A).filter((r) => r.type === "correction").length, 1);
    } finally {
      teardown(ctx);
    }
  });

  it("rejects entries that are not the latest, already corrected, or another shop's", async () => {
    const ctx = flowCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      const old = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      const latest = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 3000000, customer: "Bola" });
      const foreign = ctx.ledger.append({ shopId: SHOP_B, type: "sale", amountKobo: 9000000, customer: "Zed" });

      const stale = await dispatch(ctx.deps, { method: "POST", url: "/correct-last", headers, body: { entryId: old.id, amountKobo: 100, reason: "old" } });
      assert.equal(stale.status, 409);
      assert.match(stale.json.error, /not the shop's latest/);

      // Correct the latest through the immediate route; it is now corrected.
      const immediate = await dispatch(ctx.deps, {
        method: "POST",
        url: `/ledger/${latest.id}/correct`,
        headers,
        body: { amountKobo: 2500000, reason: "immediate" },
      });
      assert.equal(immediate.status, 200);
      const redone = await dispatch(ctx.deps, { method: "POST", url: "/correct-last", headers, body: { entryId: latest.id, amountKobo: 100, reason: "again" } });
      assert.equal(redone.status, 409);
      assert.match(redone.json.error, /already corrected/);

      const cross = await dispatch(ctx.deps, { method: "POST", url: "/correct-last", headers, body: { entryId: foreign.id, amountKobo: 100, reason: "nope" } });
      assert.equal(cross.status, 403);

      const missing = await dispatch(ctx.deps, { method: "POST", url: "/correct-last", headers, body: { entryId: 9999, amountKobo: 100, reason: "nothing" } });
      assert.equal(missing.status, 404);

      for (const entryId of ["3", 0, -2, 1.5]) {
        const bad = await dispatch(ctx.deps, { method: "POST", url: "/correct-last", headers, body: { entryId, amountKobo: 100, reason: "bad id" } });
        assert.equal(bad.status, 400, JSON.stringify(entryId));
      }

      // An explicit id naming the latest entry works.
      const named = await dispatch(ctx.deps, {
        method: "POST",
        url: "/correct-last",
        headers,
        body: { entryId: immediate.json.entry.id, amountKobo: 2400000, reason: "fix the fix" },
      });
      assert.equal(named.status, 201);
      assert.equal(named.json.proposal.correctionOf, immediate.json.entry.id);
    } finally {
      teardown(ctx);
    }
  });

  it("404s an empty shop and validates the reason and money", async () => {
    const ctx = flowCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      const empty = await dispatch(ctx.deps, { method: "POST", url: "/correct-last", headers, body: { amountKobo: 100, reason: "nothing" } });
      assert.equal(empty.status, 404);

      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      for (const body of [
        { amountKobo: 100 },
        { amountKobo: 100, reason: "" },
        { amountKobo: 10.5, reason: "r" },
        { amountKobo: -5, reason: "r" },
        { amountKobo: "100", reason: "r" },
        { customer: "", reason: "r" },
        { quantity: 0, reason: "r" },
        { item: "", reason: "r" },
        { unit: "", reason: "r" },
      ]) {
        const bad = await dispatch(ctx.deps, { method: "POST", url: "/correct-last", headers, body });
        assert.equal(bad.status, 400, JSON.stringify(body));
      }
      assert.equal(ctx.ledger.list(SHOP_A).length, 1);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS c FROM corrections_log").get().c, 0);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS c FROM proposals").get().c, 0);
    } finally {
      teardown(ctx);
    }
  });

  it("explicit null clears item, quantity and unit", async () => {
    const ctx = flowCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" });
      const out = await dispatch(ctx.deps, {
        method: "POST",
        url: "/correct-last",
        headers,
        body: { item: null, quantity: null, unit: null, reason: "was not rice" },
      });
      assert.equal(out.status, 201);
      assert.deepEqual([out.json.proposal.entries[0].item, out.json.proposal.entries[0].quantity, out.json.proposal.entries[0].unit], [null, null, null]);
      const confirmed = await dispatch(ctx.deps, { method: "POST", url: `/confirm/${out.json.proposal.id}`, headers });
      const created = ctx.ledger.get(confirmed.json.recordedIds[0]);
      assert.deepEqual([created.item, created.quantity, created.unit], [null, null, null]);
    } finally {
      teardown(ctx);
    }
  });

  it("confirm revalidates: a newer entry or a rival correction fails it", async () => {
    const ctx = flowCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 3000000, customer: "Bola" });
      const stale = await dispatch(ctx.deps, { method: "POST", url: "/correct-last", headers, body: { amountKobo: 2500000, reason: "late" } });
      ctx.ledger.append({ shopId: SHOP_A, type: "payment", amountKobo: 1000000, customer: "Bola" });
      const late = await dispatch(ctx.deps, { method: "POST", url: `/confirm/${stale.json.proposal.id}`, headers });
      assert.equal(late.status, 409);
      assert.match(late.json.error, /not the shop's latest/);
      assert.equal(ctx.ledger.list(SHOP_A).filter((r) => r.type === "correction").length, 0);

      const first = await dispatch(ctx.deps, { method: "POST", url: "/correct-last", headers, body: { amountKobo: 900000, reason: "rival one" } });
      const second = await dispatch(ctx.deps, { method: "POST", url: "/correct-last", headers, body: { amountKobo: 800000, reason: "rival two" } });
      assert.equal((await dispatch(ctx.deps, { method: "POST", url: `/confirm/${first.json.proposal.id}`, headers })).status, 200);
      const beaten = await dispatch(ctx.deps, { method: "POST", url: `/confirm/${second.json.proposal.id}`, headers });
      assert.equal(beaten.status, 409);
      assert.match(beaten.json.error, /already corrected/);
    } finally {
      teardown(ctx);
    }
  });

  it("fix on a correction proposal keeps its target and updates the values", async () => {
    const reading = {
      heard: "make am 12k",
      entries: [{ type: "sale", customer: "Ada", item: "rice", quantity: 2, unit: "bag", amountNaira: 12000, amountPhrase: "12k", priceBasis: "total" }],
      totals: null,
      promise: null,
      question: null,
    };
    const ctx = flowCtx(async () => reading);
    try {
      const headers = { "x-shop-id": SHOP_A };
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" });
      const out = await dispatch(ctx.deps, { method: "POST", url: "/correct-last", headers, body: { amountKobo: 1500000, reason: "first guess" } });
      const fixed = await dispatch(ctx.deps, { method: "POST", url: `/fix/${out.json.proposal.id}`, headers, body: { correctionText: "make am 12k" } });
      assert.equal(fixed.status, 200);
      assert.equal(fixed.json.proposal.correctionOf, sale.id);
      assert.equal(fixed.json.proposal.correctionReason, "first guess");
      assert.equal(fixed.json.proposal.entries[0].amountKobo, 1200000);
      assert.deepEqual(fixed.json.proposal.flags, []);
      const confirmed = await dispatch(ctx.deps, { method: "POST", url: `/confirm/${fixed.json.proposal.id}`, headers });
      assert.equal(ctx.ledger.get(confirmed.json.recordedIds[0]).amount_kobo, 1200000);
    } finally {
      teardown(ctx);
    }
  });

  it("the webhook port 404s the correct-last route", async () => {
    const ctx = flowCtx();
    try {
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      const out = await dispatchOnly(ctx.deps, {
        method: "POST",
        url: "/correct-last",
        headers: { "x-shop-id": SHOP_A },
        body: { amountKobo: 100, reason: "tunneled" },
      });
      assert.equal(out.status, 404);
    } finally {
      teardown(ctx);
    }
  });
});

describe("POST /entries/:id/correct", () => {
  // Correction proposals need the proposals store (and idempotency for the
  // offline replays); no model call is ever made on this path.
  function anyCtx() {
    const db = new DatabaseSync(":memory:");
    const ledger = new Ledger(db);
    const proposals = new ProposalStore(db);
    const promises = new PromiseStore(db);
    const auths = new AuthStore(db);
    const idempotency = new IdempotencyStore(db);
    return { db, ledger, proposals, promises, auths, idempotency, deps: { ledger, proposals, promises, auths, idempotency } };
  }

  function anyTeardown(ctx) {
    ctx.db.close();
  }

  it("corrects an old entry (not the latest) and saves nothing before confirm", async () => {
    const ctx = anyCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      const old = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" });
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 3000000, customer: "Bola" });

      const out = await dispatch(ctx.deps, {
        method: "POST",
        url: `/entries/${old.id}/correct`,
        headers,
        body: { amountKobo: 1500000 },
      });
      assert.equal(out.status, 201);
      const p = out.json.proposal;
      assert.equal(p.correctionOf, old.id);
      assert.equal(p.correctionScope, "any");
      assert.equal(p.correctionReason, "trader correction");
      assert.equal(p.entries.length, 1);
      assert.deepEqual(
        [p.entries[0].type, p.entries[0].amountKobo, p.entries[0].customer, p.entries[0].item, p.entries[0].quantity, p.entries[0].unit],
        ["sale", 1500000, "Ada", "rice", 2, "bag"]
      );
      // Nothing saved yet: no ledger row, no reason, same verify count.
      assert.equal(ctx.ledger.list(SHOP_A).length, 2);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS c FROM corrections_log").get().c, 0);
      assert.deepEqual(ctx.ledger.verify(SHOP_A), { ok: true, count: 2, shopId: SHOP_A });

      const confirmed = await dispatch(ctx.deps, { method: "POST", url: `/confirm/${p.id}`, headers });
      assert.equal(confirmed.status, 200);
      assert.equal(confirmed.json.alreadyConfirmed, false);
      assert.equal(confirmed.json.recordedIds.length, 1);
      const created = ctx.ledger.get(confirmed.json.recordedIds[0]);
      assert.equal(created.type, "correction");
      assert.equal(created.corrects_id, old.id);
      assert.equal(created.amount_kobo, 1500000);
      // The original row is untouched; the chain still verifies.
      assert.equal(ctx.ledger.get(old.id).amount_kobo, 2000000);
      assert.deepEqual(ctx.ledger.verify(SHOP_A), { ok: true, count: 3, shopId: SHOP_A });
      assert.deepEqual(
        effectiveEntries(ctx.ledger.list(SHOP_A)).map((e) => e.amount_kobo),
        [3000000, 1500000]
      );
      assert.equal(ctx.ledger.correctionReason(created.id), "trader correction");
    } finally {
      anyTeardown(ctx);
    }
  });

  it("a second correction chains to the previous current version", async () => {
    const ctx = anyCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      const old = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 3000000, customer: "Bola" });

      const first = await dispatch(ctx.deps, {
        method: "POST", url: `/entries/${old.id}/correct`, headers, body: { amountKobo: 1500000, reason: "first fix" },
      });
      const firstId = ctx.ledger.get((await dispatch(ctx.deps, { method: "POST", url: `/confirm/${first.json.proposal.id}`, headers })).json.recordedIds[0]).id;

      const second = await dispatch(ctx.deps, {
        method: "POST", url: `/entries/${old.id}/correct`, headers, body: { amountKobo: 1200000, reason: "second fix" },
      });
      assert.equal(second.status, 201);
      const created = ctx.ledger.get((await dispatch(ctx.deps, { method: "POST", url: `/confirm/${second.json.proposal.id}`, headers })).json.recordedIds[0]);
      assert.equal(created.corrects_id, firstId);
      assert.equal(created.amount_kobo, 1200000);
      assert.equal(ctx.ledger.get(old.id).amount_kobo, 2000000);
      assert.deepEqual(ctx.ledger.verify(SHOP_A), { ok: true, count: 4, shopId: SHOP_A });
      assert.deepEqual(
        effectiveEntries(ctx.ledger.list(SHOP_A)).map((e) => e.amount_kobo).sort((a, b) => a - b),
        [1200000, 3000000]
      );

      const listed = await dispatch(ctx.deps, { url: "/ledger", headers });
      const byId = new Map(listed.json.entries.map((e) => [e.id, e]));
      assert.deepEqual(
        [byId.get(old.id).canCorrect, byId.get(old.id).wasCorrected, byId.get(old.id).currentVersionId],
        [false, true, created.id]
      );
      assert.equal(byId.get(old.id).correctedById, firstId);
      assert.deepEqual(
        [byId.get(firstId).canCorrect, byId.get(firstId).wasCorrected, byId.get(firstId).currentVersionId],
        [false, true, created.id]
      );
      assert.deepEqual(
        [byId.get(created.id).canCorrect, byId.get(created.id).wasCorrected, byId.get(created.id).currentVersionId],
        [true, false, created.id]
      );
    } finally {
      anyTeardown(ctx);
    }
  });

  it("debts, profit and the CSV use only the current version", async () => {
    const ctx = anyCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      const old = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 3000000, customer: "Ada" });
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 1000000, customer: "Chidi" });
      const out = await dispatch(ctx.deps, {
        method: "POST", url: `/entries/${old.id}/correct`, headers, body: { amountKobo: 2000000, reason: "discounted" },
      });
      await dispatch(ctx.deps, { method: "POST", url: `/confirm/${out.json.proposal.id}`, headers });

      const debts = await dispatch(ctx.deps, { url: "/debts", headers });
      assert.equal(debts.json.debts.find((d) => d.customer === "Ada").owedKobo, 2000000);

      const profit = await dispatch(ctx.deps, { url: "/profit?period=today", headers });
      assert.equal(profit.json.salesKobo, 3000000);

      const month = lagosDay(Date.now()).slice(0, 7);
      const { csv } = buildMonthlyCsv(ctx.ledger.list(SHOP_A), month);
      const adaLines = csv.split("\n").filter((line) => line.includes("Ada"));
      assert.equal(adaLines.length, 1);
      assert.ok(adaLines[0].includes("20000.00"));
    } finally {
      anyTeardown(ctx);
    }
  });

  it("another shop's entry reads 404 and saves nothing", async () => {
    const ctx = anyCtx();
    try {
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      const cross = await dispatch(ctx.deps, {
        method: "POST",
        url: `/entries/${sale.id}/correct`,
        headers: { "x-shop-id": SHOP_B },
        body: { amountKobo: 100, reason: "nope" },
      });
      assert.equal(cross.status, 404);
      const missing = await dispatch(ctx.deps, {
        method: "POST",
        url: "/entries/9999/correct",
        headers: { "x-shop-id": SHOP_A },
        body: { amountKobo: 100, reason: "nothing" },
      });
      assert.equal(missing.status, 404);
      assert.equal(ctx.ledger.list(SHOP_A).length, 1);
      assert.equal(ctx.ledger.list(SHOP_B).length, 0);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS c FROM proposals").get().c, 0);
    } finally {
      anyTeardown(ctx);
    }
  });

  it("changing the type is refused but restating it passes", async () => {
    const ctx = anyCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      const bad = await dispatch(ctx.deps, {
        method: "POST", url: `/entries/${sale.id}/correct`, headers, body: { type: "payment", reason: "switch" },
      });
      assert.equal(bad.status, 400);
      assert.match(bad.json.error, /cannot be changed/);
      const ok = await dispatch(ctx.deps, {
        method: "POST", url: `/entries/${sale.id}/correct`, headers, body: { type: "sale", amountKobo: 1900000, reason: "same type" },
      });
      assert.equal(ok.status, 201);
      assert.equal(ok.json.proposal.entries[0].type, "sale");
      assert.equal(ctx.ledger.list(SHOP_A).length, 1);
    } finally {
      anyTeardown(ctx);
    }
  });

  it("a sale with payments locks the amount but still renames the label", async () => {
    const ctx = anyCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 3000000, customer: "Ada" });
      ctx.ledger.append({ shopId: SHOP_A, type: "payment", amountKobo: 1000000, customer: "Ada" });

      const blocked = await dispatch(ctx.deps, {
        method: "POST", url: `/entries/${sale.id}/correct`, headers, body: { amountKobo: 2000000, reason: "cheaper" },
      });
      assert.equal(blocked.status, 409);
      assert.match(blocked.json.error, /already has payments/);

      const renamed = await dispatch(ctx.deps, {
        method: "POST", url: `/entries/${sale.id}/correct`, headers, body: { customer: "Adaeze", reason: "full name" },
      });
      assert.equal(renamed.status, 201);
      const created = ctx.ledger.get((await dispatch(ctx.deps, { method: "POST", url: `/confirm/${renamed.json.proposal.id}`, headers })).json.recordedIds[0]);
      assert.equal(created.amount_kobo, 3000000);
      assert.equal(created.customer, "Adaeze");
      // Only the sale row is relabelled; its payment stays under the old
      // label (whole-customer renames go through POST /customers/rename).
      const debts = await dispatch(ctx.deps, { url: "/debts", headers });
      assert.equal(debts.json.debts.find((d) => d.customer === "Adaeze").owedKobo, 3000000);
      assert.equal(ctx.ledger.list(SHOP_A).filter((r) => r.type === "correction").length, 1);
    } finally {
      anyTeardown(ctx);
    }
  });

  it("bad dates and non-integer amounts are refused; a past date records", async () => {
    const ctx = anyCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      for (const body of [
        { date: new Date(Date.now() + 3600000).toISOString(), reason: "future" },
        { date: "not-a-date", reason: "garbage" },
        { amountKobo: 10.5, reason: "r" },
        { amountKobo: "100", reason: "r" },
        { amountKobo: -5, reason: "r" },
      ]) {
        const bad = await dispatch(ctx.deps, { method: "POST", url: `/entries/${sale.id}/correct`, headers, body });
        assert.equal(bad.status, 400, JSON.stringify(body));
      }
      const past = "2026-10-15T12:00:00.000Z";
      const out = await dispatch(ctx.deps, {
        method: "POST", url: `/entries/${sale.id}/correct`, headers, body: { date: past, reason: "wrong day" },
      });
      assert.equal(out.status, 201);
      const created = ctx.ledger.get((await dispatch(ctx.deps, { method: "POST", url: `/confirm/${out.json.proposal.id}`, headers })).json.recordedIds[0]);
      assert.equal(created.created_at, past);
      assert.equal(ctx.ledger.list(SHOP_A).filter((r) => r.type === "correction").length, 1);
    } finally {
      anyTeardown(ctx);
    }
  });

  it("offline replays share one proposal and confirm records once", async () => {
    const ctx = anyCtx();
    try {
      const headers = { "x-shop-id": SHOP_A, "x-request-id": "correct-offline-1" };
      const old = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 3000000, customer: "Bola" });
      const first = await dispatch(ctx.deps, {
        method: "POST", url: `/entries/${old.id}/correct`, headers, body: { amountKobo: 1500000, reason: "offline fix" },
      });
      assert.equal(first.status, 201);
      const replay = await dispatch(ctx.deps, {
        method: "POST", url: `/entries/${old.id}/correct`, headers, body: { amountKobo: 1500000, reason: "offline fix" },
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.json.proposal.id, first.json.proposal.id);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS c FROM proposals").get().c, 1);
      const done = await dispatch(ctx.deps, { method: "POST", url: `/confirm/${first.json.proposal.id}`, headers: { "x-shop-id": SHOP_A } });
      assert.equal(done.json.alreadyConfirmed, false);
      const again = await dispatch(ctx.deps, { method: "POST", url: `/confirm/${first.json.proposal.id}`, headers: { "x-shop-id": SHOP_A } });
      assert.equal(again.json.alreadyConfirmed, true);
      assert.equal(ctx.ledger.list(SHOP_A).filter((r) => r.type === "correction").length, 1);
    } finally {
      anyTeardown(ctx);
    }
  });

  it("every listed entry carries the Edit-button fields; entries alias matches ledger", async () => {
    const ctx = anyCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      const old = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      const out = await dispatch(ctx.deps, {
        method: "POST", url: `/entries/${old.id}/correct`, headers, body: { amountKobo: 1500000, reason: "fix" },
      });
      await dispatch(ctx.deps, { method: "POST", url: `/confirm/${out.json.proposal.id}`, headers });
      for (const url of ["/ledger", "/entries"]) {
        const listed = await dispatch(ctx.deps, { url, headers });
        assert.equal(listed.status, 200);
        assert.equal(listed.json.entries.length, 2);
        for (const e of listed.json.entries) {
          assert.equal(typeof e.canCorrect, "boolean", url);
          assert.equal(typeof e.wasCorrected, "boolean", url);
          assert.ok(Number.isInteger(e.currentVersionId), url);
        }
        assert.deepEqual(listed.json.verify, { ok: true, count: 2, shopId: SHOP_A });
      }
    } finally {
      anyTeardown(ctx);
    }
  });

  it("the webhook port 404s the entries correct route", async () => {
    const ctx = anyCtx();
    try {
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada" });
      assert.equal(
        (
          await dispatchOnly(ctx.deps, {
            method: "POST",
            url: `/entries/${sale.id}/correct`,
            headers: { "x-shop-id": SHOP_A },
            body: { amountKobo: 100, reason: "tunneled" },
          })
        ).status,
        404
      );
    } finally {
      anyTeardown(ctx);
    }
  });
});

describe("correct-last flows downstream", () => {
  it("debts, profit and the ledger use the corrected values; both rows listed", async () => {
    const ctx = flowCtx();
    try {
      const headers = { "x-shop-id": SHOP_A };
      const sale = ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 3000000, customer: "Ada" });
      const out = await dispatch(ctx.deps, { method: "POST", url: "/correct-last", headers, body: { amountKobo: 2000000, reason: "overcharged" } });
      await dispatch(ctx.deps, { method: "POST", url: `/confirm/${out.json.proposal.id}`, headers });

      const debts = await dispatch(ctx.deps, { url: "/debts", headers });
      assert.equal(debts.json.debts.find((d) => d.customer === "Ada").owedKobo, 2000000);

      const profit = await dispatch(ctx.deps, { url: "/profit?period=today", headers });
      assert.equal(profit.json.salesKobo, 2000000);
      assert.equal(profit.json.estimatedProfitKobo, 2000000);

      const ledger = await dispatch(ctx.deps, { url: "/ledger", headers });
      assert.equal(ledger.json.entries.length, 2);
      const byId = new Map(ledger.json.entries.map((e) => [e.id, e]));
      const correction = ledger.json.entries.find((e) => e.type === "correction");
      assert.equal(correction.corrects_id, sale.id);
      assert.equal(byId.get(sale.id).correctedById, correction.id);
      assert.equal(byId.get(sale.id).correctionReason, "overcharged");
      assert.equal(ledger.json.verify.ok, true);
    } finally {
      teardown(ctx);
    }
  });
});
