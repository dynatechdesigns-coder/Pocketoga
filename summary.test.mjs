// Daily summary: opt-in settings, scheduler tick, code-only content and
// 24-hour/template delivery. Fixed clock, mocked fetch, fake data only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { PromiseStore } from "./promises.mjs";
import { ProductStore } from "./products.mjs";
import { PhotoCheckStore } from "./photos.mjs";
import { AuthStore, DEMO_SHOP_ID } from "./auth.mjs";
import { WhatsAppStore } from "./whatsapp.mjs";
import { SummaryStore, collectDailySummary } from "./summary.mjs";
import { renderDailySummary, MAX_BODY_CHARS } from "./messages.mjs";
import {
  buildWhatsAppContext,
  processWhatsAppPayload,
  runSummaryTick,
  parseCommand,
} from "./whatsapp.mjs";
import { handleVoiceRequest, handleWebhookOnlyRequest } from "./server.mjs";
import { lagosDay } from "./debts.mjs";

const ENV = {
  WHATSAPP_TOKEN: "test-token-abcdef123456",
  WHATSAPP_PHONE_NUMBER_ID: "15550001111",
  WHATSAPP_APP_SECRET: "test-app-secret-xyz",
  WHATSAPP_VERIFY_TOKEN: "test-verify-token",
  WHATSAPP_ALLOWED_NUMBERS: "2348012345678, 2348098765432",
};
const FROM = "2348012345678";
const DAY_MS = 24 * 3600 * 1000;

// Fixed clock: Lagos 20:30 on the current Lagos day, so "today" always has
// room for entries and hour-20 settings always fire.
const NOW = Date.parse(`${lagosDay(Date.now())}T19:30:00Z`);
const isoAt = (ms) => new Date(ms).toISOString();

let nextMsg = 1;
const mid = () => `wamid-summary-${nextMsg++}`;
const wrap = (messages) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "entry-1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages } }] }],
});
const waText = (from, id, body) => ({ from, id, type: "text", text: { body } });

function makeFetch() {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid-reply" }] }), text: async () => "{}" };
  };
  fn.calls = calls;
  return fn;
}

function setup(opts = {}) {
  const db = new DatabaseSync(":memory:");
  const ledger = new Ledger(db);
  const proposals = new ProposalStore(db);
  const promises = new PromiseStore(db);
  const products = new ProductStore(db);
  const photoChecks = new PhotoCheckStore(db);
  const auths = new AuthStore(db);
  const whatsapp = new WhatsAppStore(db);
  const fetch = makeFetch();
  const logs = [];
  const deps = {
    ledger,
    proposals,
    promises,
    products,
    photoChecks,
    auths,
    whatsapp,
    model: null,
    fetch,
    log: (line) => logs.push(String(line)),
    env: { ...ENV, ...(opts.env ?? {}) },
    nowMs: NOW,
  };
  const shopId = whatsapp.getOrCreateShop(FROM);
  return { db, ledger, proposals, promises, products, photoChecks, auths, whatsapp, fetch, logs, deps, shopId };
}

function teardown(ctx) {
  ctx.db.close();
}

function sends(ctx) {
  return ctx.fetch.calls
    .filter((c) => c.url.endsWith("/messages"))
    .map((c) => JSON.parse(c.opts.body));
}

function textBodies(ctx) {
  return sends(ctx)
    .filter((b) => b.type === "text")
    .map((b) => b.text.body);
}

async function inbound(ctx, body, from = FROM) {
  await processWhatsAppPayload(wrap([waText(from, mid(), body)]), buildWhatsAppContext(ctx.deps));
}

function sale(ctx, over = {}) {
  return ctx.ledger.append({
    shopId: ctx.shopId,
    type: "sale",
    amountKobo: 3000000,
    customer: "Ada",
    item: "rice",
    quantity: 2,
    unit: "bag",
    createdAt: isoAt(NOW - 3600 * 1000),
    ...over,
  });
}

function seedCatalog(ctx, name = "rice", unit = "bag", sellNaira = 45000) {
  const row = ctx.products.ensure({ shopId: ctx.shopId, name, unit });
  ctx.products.setPrices(row.id, { sellPriceKobo: sellNaira * 100 });
  return row;
}

function seedStock(ctx, item = "rice", unit = "bag", quantity = 20, costNaira = 40000, atMs = NOW - 2 * DAY_MS) {
  return ctx.ledger.append({
    shopId: ctx.shopId,
    type: "restock",
    amountKobo: costNaira * 100 * quantity,
    customer: ctx.shopId,
    item,
    quantity,
    unit,
    createdAt: isoAt(atMs),
  });
}

function seedPromise(ctx, over = {}) {
  return ctx.promises.create({
    shopId: ctx.shopId,
    customer: "Ada",
    amountKobo: 500000,
    dueDate: lagosDay(NOW),
    createdAt: isoAt(NOW - 3600 * 1000),
    ...over,
  });
}

function summaryData(ctx, over = {}) {
  return collectDailySummary({
    shopId: ctx.shopId,
    rows: ctx.ledger.list(ctx.shopId),
    openPromises: ctx.promises.listOpenByShop(ctx.shopId),
    catalog: ctx.products.listByShop(ctx.shopId),
    paymentChecks: ctx.photoChecks.listUnconfirmedByShop(ctx.shopId),
    now: NOW,
    ...over,
  });
}

function noLongDigits(s) {
  return !/\d{7,}/.test(String(s ?? ""));
}

function fakeRequest({ method, url, headers }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = () => {};
  process.nextTick(() => req.emit("end"));
  return req;
}

function fakeResponse() {
  const res = new EventEmitter();
  res.statusCode = null;
  res.headersSent = false;
  res.chunks = "";
  res.writeHead = (status) => {
    res.statusCode = status;
    res.headersSent = true;
  };
  res.end = (chunk) => {
    if (chunk) res.chunks += chunk;
  };
  return res;
}

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

async function dispatch(deps, shopId, { method, url }) {
  const req = fakeRequest({ method, url, headers: { "x-shop-id": shopId, authorization: `Bearer ${tokenFor(deps, shopId)}` } });
  const res = fakeResponse();
  await handleVoiceRequest(req, res, deps);
  return { status: res.statusCode, json: JSON.parse(res.chunks) };
}

async function dispatchOnly(deps, { method, url }) {
  const req = fakeRequest({ method, url, headers: {} });
  const res = fakeResponse();
  await handleWebhookOnlyRequest(req, res, deps);
  return { status: res.statusCode, json: JSON.parse(res.chunks) };
}

describe("summary commands (mocked fetch, fixed clock)", () => {
  it("summary on and off opt the number in and out", async () => {
    const ctx = setup();
    try {
      const store = new SummaryStore(ctx.db);
      assert.equal(store.get(ctx.shopId, FROM), null);
      await inbound(ctx, "summary on");
      assert.match(textBodies(ctx).at(-1), /8 PM/);
      assert.equal(store.get(ctx.shopId, FROM).enabled, 1);
      assert.equal(store.get(ctx.shopId, FROM).hour, 20);
      await inbound(ctx, "summary off");
      assert.match(textBodies(ctx).at(-1), /Daily summary off/);
      assert.equal(store.get(ctx.shopId, FROM).enabled, 0);
    } finally {
      teardown(ctx);
    }
  });

  it("summary 7pm sets the hour; bad hours get usage", async () => {
    const ctx = setup();
    try {
      const store = new SummaryStore(ctx.db);
      await inbound(ctx, "summary 7pm");
      assert.equal(store.get(ctx.shopId, FROM).hour, 19);
      assert.match(textBodies(ctx).at(-1), /7 PM/);
      await inbound(ctx, "summary 5pm");
      assert.equal(store.get(ctx.shopId, FROM).hour, 17);
      await inbound(ctx, "summary 11pm");
      assert.equal(store.get(ctx.shopId, FROM).hour, 23);
      for (const bad of ["summary 4pm", "summary 7am", "summary 12"]) {
        await inbound(ctx, bad);
        assert.match(textBodies(ctx).at(-1), /5 to 11 PM/);
      }
      assert.equal(store.get(ctx.shopId, FROM).hour, 23);
    } finally {
      teardown(ctx);
    }
  });

  it("summary now sends today without opt-in; quiet day gets the nothing line", async () => {
    const ctx = setup();
    try {
      sale(ctx);
      await inbound(ctx, "summary now");
      assert.match(textBodies(ctx).at(-1), /Sales/);
      const ctx2 = setup();
      try {
        await inbound(ctx2, "summary now");
        assert.equal(textBodies(ctx2).at(-1), "Nothing to report today yet.");
      } finally {
        teardown(ctx2);
      }
    } finally {
      teardown(ctx);
    }
  });

  it("parseCommand covers every summary form", () => {
    assert.deepEqual(parseCommand("summary on"), { name: "summary", arg: "on" });
    assert.deepEqual(parseCommand("summary off"), { name: "summary", arg: "off" });
    assert.deepEqual(parseCommand("summary now"), { name: "summary", arg: "now" });
    assert.deepEqual(parseCommand("summary 7pm"), { name: "summary", arg: "hour:19" });
    assert.deepEqual(parseCommand("Summary 7 PM"), { name: "summary", arg: "hour:19" });
    assert.deepEqual(parseCommand("summary 4pm"), { name: "summary", arg: "bad" });
    assert.deepEqual(parseCommand("summary 7am"), { name: "summary", arg: "bad" });
    assert.equal(parseCommand("summary"), null);
  });
});

describe("summary content priority (fixed clock)", () => {
  it("a promise due today beats debt, low stock and stale transfers", () => {
    const ctx = setup();
    try {
      sale(ctx, { customer: "Ada", amountKobo: 3000000 });
      seedCatalog(ctx);
      seedStock(ctx, "rice", "bag", 2);
      ctx.photoChecks.create({ shopId: ctx.shopId, photoType: "payment_alert", amountKobo: 900000, createdAt: isoAt(NOW - 2 * DAY_MS) });
      seedPromise(ctx);
      const data = summaryData(ctx);
      assert.equal(data.highlight.kind, "promise");
      assert.match(renderDailySummary(data), /suppose pay/);
    } finally {
      teardown(ctx);
    }
  });

  it("an overdue promise names the days late", () => {
    const ctx = setup();
    try {
      sale(ctx);
      seedPromise(ctx, { dueDate: lagosDay(NOW - 2 * DAY_MS) });
      const data = summaryData(ctx);
      assert.equal(data.highlight.kind, "promise");
      assert.equal(data.highlight.overdueDays, 2);
      assert.match(renderDailySummary(data), /2 days late/);
    } finally {
      teardown(ctx);
    }
  });

  it("a new debt over 20% of sales is next", () => {
    const ctx = setup();
    try {
      sale(ctx, { customer: "Ada", amountKobo: 3000000 });
      const data = summaryData(ctx);
      assert.equal(data.highlight.kind, "debt");
      assert.match(renderDailySummary(data), /New debt/);
    } finally {
      teardown(ctx);
    }
  });

  it("low stock follows when no debt qualifies", () => {
    const ctx = setup();
    try {
      ctx.ledger.append({ shopId: ctx.shopId, type: "expense", amountKobo: 200000, customer: ctx.shopId, item: "fuel", quantity: null, unit: null, createdAt: isoAt(NOW - 3600 * 1000) });
      seedCatalog(ctx);
      seedStock(ctx, "rice", "bag", 2);
      const data = summaryData(ctx);
      assert.equal(data.highlight.kind, "stock");
      assert.match(renderDailySummary(data), /Low stock/);
    } finally {
      teardown(ctx);
    }
  });

  it("a stale unconfirmed transfer follows that", () => {
    const ctx = setup();
    try {
      ctx.ledger.append({ shopId: ctx.shopId, type: "expense", amountKobo: 200000, customer: ctx.shopId, item: "fuel", quantity: null, unit: null, createdAt: isoAt(NOW - 3600 * 1000) });
      seedCatalog(ctx);
      seedStock(ctx, "rice", "bag", 20);
      ctx.photoChecks.create({ shopId: ctx.shopId, photoType: "payment_alert", amountKobo: 900000, createdAt: isoAt(NOW - 2 * DAY_MS) });
      const data = summaryData(ctx);
      assert.equal(data.highlight.kind, "transfer");
      assert.match(renderDailySummary(data), /unconfirmed/);
    } finally {
      teardown(ctx);
    }
  });

  it("a calm day says nothing needs attention", () => {
    const ctx = setup();
    try {
      ctx.ledger.append({ shopId: ctx.shopId, type: "expense", amountKobo: 200000, customer: ctx.shopId, item: "fuel", quantity: null, unit: null, createdAt: isoAt(NOW - 3600 * 1000) });
      seedCatalog(ctx);
      seedStock(ctx, "rice", "bag", 20);
      const data = summaryData(ctx);
      assert.equal(data.highlight.kind, "none");
      assert.match(renderDailySummary(data), /Nothing needs attention/);
    } finally {
      teardown(ctx);
    }
  });

  it("an empty day with no promises due is skipped", () => {
    const ctx = setup();
    try {
      assert.equal(summaryData(ctx), null);
    } finally {
      teardown(ctx);
    }
  });

  it("every built text fits 1024 chars with no long digit runs", () => {
    const ctx = setup();
    try {
      sale(ctx, { customer: "A very long customer name indeed", amountKobo: 1500000000 });
      seedCatalog(ctx, "a very long product name indeed", "basin", 45000);
      seedStock(ctx, "a very long product name indeed", "basin", 1);
      seedPromise(ctx, { customer: "A very long customer name indeed", amountKobo: 1500000000 });
      const text = renderDailySummary(summaryData(ctx));
      assert.ok(text.length <= MAX_BODY_CHARS, text.length);
      assert.ok(noLongDigits(text));
    } finally {
      teardown(ctx);
    }
  });
});

describe("summary scheduler and delivery (fixed clock, mocked fetch)", () => {
  it("sends once per day even across a simulated restart", async () => {
    const ctx = setup();
    try {
      const store = new SummaryStore(ctx.db);
      store.setEnabled(ctx.shopId, FROM, true, 20, NOW);
      store.touchInbound(ctx.shopId, FROM, NOW - 3600 * 1000);
      sale(ctx);
      await runSummaryTick(ctx.deps, { now: NOW });
      assert.equal(sends(ctx).length, 1);
      delete ctx.deps._summaryStore;
      await runSummaryTick(ctx.deps, { now: NOW });
      assert.equal(sends(ctx).length, 1);
      assert.equal(new SummaryStore(ctx.db).get(ctx.shopId, FROM).last_sent_date, lagosDay(NOW));
    } finally {
      teardown(ctx);
    }
  });

  it("stays quiet before the hour and when opted out", async () => {
    const ctx = setup();
    try {
      const store = new SummaryStore(ctx.db);
      store.setEnabled(ctx.shopId, FROM, true, 23, NOW);
      sale(ctx);
      await runSummaryTick(ctx.deps, { now: NOW });
      assert.equal(sends(ctx).length, 0);
      store.setEnabled(ctx.shopId, FROM, false, null, NOW);
      await runSummaryTick(ctx.deps, { now: NOW + 4 * 3600 * 1000 });
      assert.equal(sends(ctx).length, 0);
    } finally {
      teardown(ctx);
    }
  });

  it("inside 24 hours sends free text", async () => {
    const ctx = setup();
    try {
      const store = new SummaryStore(ctx.db);
      store.setEnabled(ctx.shopId, FROM, true, 20, NOW);
      store.touchInbound(ctx.shopId, FROM, NOW - 3600 * 1000);
      sale(ctx);
      await runSummaryTick(ctx.deps, { now: NOW });
      const out = sends(ctx);
      assert.equal(out.length, 1);
      assert.equal(out[0].type, "text");
      assert.match(out[0].text.body, /Sales/);
      assert.ok(noLongDigits(out[0].text.body));
    } finally {
      teardown(ctx);
    }
  });

  it("outside 24 hours with a template sends the template", async () => {
    const ctx = setup({ env: { WHATSAPP_SUMMARY_TEMPLATE: "daily_summary" } });
    try {
      const store = new SummaryStore(ctx.db);
      store.setEnabled(ctx.shopId, FROM, true, 20, NOW);
      store.touchInbound(ctx.shopId, FROM, NOW - 25 * 3600 * 1000);
      sale(ctx);
      await runSummaryTick(ctx.deps, { now: NOW });
      const out = sends(ctx);
      assert.equal(out.length, 1);
      assert.equal(out[0].type, "template");
      assert.equal(out[0].template.name, "daily_summary");
      assert.equal(out[0].template.language.code, "en");
      assert.equal(out[0].template.components[0].parameters.length, 4);
    } finally {
      teardown(ctx);
    }
  });

  it("outside 24 hours with no template waits, then delivers on next inbound", async () => {
    const ctx = setup();
    try {
      const store = new SummaryStore(ctx.db);
      store.setEnabled(ctx.shopId, FROM, true, 20, NOW);
      store.touchInbound(ctx.shopId, FROM, NOW - 25 * 3600 * 1000);
      sale(ctx);
      await runSummaryTick(ctx.deps, { now: NOW });
      assert.equal(sends(ctx).length, 0);
      assert.ok(ctx.logs.some((l) => l.includes("summary waiting for template")));
      assert.ok(store.get(ctx.shopId, FROM).pending_text);
      await inbound(ctx, "profit");
      const bodies = textBodies(ctx);
      assert.equal(bodies.filter((b) => b.includes("Your summary from last evening")).length, 1);
      assert.match(bodies[0], /Your summary from last evening/);
      assert.equal(store.get(ctx.shopId, FROM).pending_text, null);
      await inbound(ctx, "profit");
      assert.equal(textBodies(ctx).filter((b) => b.includes("Your summary from last evening")).length, 1);
      for (const line of ctx.logs) assert.ok(noLongDigits(line));
    } finally {
      teardown(ctx);
    }
  });

  it("a quiet day marks sent without sending", async () => {
    const ctx = setup();
    try {
      const store = new SummaryStore(ctx.db);
      store.setEnabled(ctx.shopId, FROM, true, 20, NOW);
      store.touchInbound(ctx.shopId, FROM, NOW - 3600 * 1000);
      await runSummaryTick(ctx.deps, { now: NOW });
      assert.equal(sends(ctx).length, 0);
      assert.equal(store.get(ctx.shopId, FROM).last_sent_date, lagosDay(NOW));
    } finally {
      teardown(ctx);
    }
  });
});

describe("summary preview route", () => {
  it("returns the text for the logged-in shop, 404 on the webhook port", async () => {
    const ctx = setup();
    try {
      sale(ctx);
      const ok = await dispatch(ctx.deps, ctx.shopId, { method: "GET", url: "/summary/preview" });
      assert.equal(ok.status, 200);
      assert.match(ok.json.text, /Sales/);
      assert.ok(ok.json.text.length <= MAX_BODY_CHARS);
      const missing = await dispatchOnly(ctx.deps, { method: "GET", url: "/summary/preview" });
      assert.equal(missing.status, 404);
    } finally {
      teardown(ctx);
    }
  });

  it("needs a login like every other shop route", async () => {
    const ctx = setup();
    try {
      const req = fakeRequest({ method: "GET", url: "/summary/preview", headers: { "x-shop-id": ctx.shopId } });
      const res = fakeResponse();
      await handleVoiceRequest(req, res, ctx.deps);
      assert.equal(res.statusCode, 401);
    } finally {
      teardown(ctx);
    }
  });
});
