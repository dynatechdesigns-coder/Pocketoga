// Monthly CSV export: rows, totals, filename, auth and caps. Fake data only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { AuthStore, DEMO_SHOP_ID } from "./auth.mjs";
import { lagosDay } from "./debts.mjs";
import { handleVoiceRequest, handleWebhookOnlyRequest } from "./server.mjs";
import { monthBounds, parseReportMonth, koboToNaira, csvCell, buildMonthlyCsv, CSV_BOM } from "./reports.mjs";

const SHOP_A = "shop-a";
const SHOP_B = "shop-b";
const OCT = "2026-10";

function setup() {
  const db = new DatabaseSync(":memory:");
  const ctx = {
    db,
    ledger: new Ledger(db),
    proposals: new ProposalStore(db),
    auths: new AuthStore(db),
  };
  // Caps that explode if the route ever charges: the export is plain code.
  ctx.deps = {
    ledger: ctx.ledger,
    proposals: ctx.proposals,
    auths: ctx.auths,
    modelCaps: { charge() { throw new Error("monthly csv must not charge model caps"); } },
    dailyCaps: {},
  };
  return ctx;
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
  return { status: res.statusCode, headers: res.headers, text: res.text };
}

async function dispatchOnly(deps, opts) {
  const res = fakeRes();
  await handleWebhookOnlyRequest(fakeReq(opts), res, deps);
  return { status: res.statusCode, headers: res.headers, text: res.text };
}

// Noon UTC stamps land on the same calendar day in Lagos (UTC+1).
const stamp = (day, time = "12:00:00") => `${day}T${time}Z`;

function seedOctober(ctx) {
  const L = ctx.ledger;
  L.append({ shopId: SHOP_A, type: "restock", amountKobo: 5000000, customer: SHOP_A, item: "rice", quantity: 10, unit: "bag", createdAt: stamp("2026-10-03") });
  const adaSale = L.append({ shopId: SHOP_A, type: "sale", amountKobo: 1500000, customer: "Ada", item: "rice", quantity: 2, unit: "bag", createdAt: stamp("2026-10-05") });
  L.append({ shopId: SHOP_A, type: "payment", amountKobo: 1500000, customer: "Ada", createdAt: stamp("2026-10-06") });
  L.append({ shopId: SHOP_A, type: "sale", amountKobo: 700000, customer: "Funmi", item: "gari", quantity: 1, unit: "mudu", createdAt: stamp("2026-10-07") });
  L.append({ shopId: SHOP_A, type: "payment", amountKobo: 700000, customer: "Funmi", createdAt: stamp("2026-10-08") });
  L.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Bola", item: "beans", quantity: 1, unit: "derica", createdAt: stamp("2026-10-10") });
  L.append({ shopId: SHOP_A, type: "payment", amountKobo: 500000, customer: "Bola", createdAt: stamp("2026-10-11") });
  L.append({ shopId: SHOP_A, type: "expense", amountKobo: 250000, customer: SHOP_A, item: "transport", createdAt: stamp("2026-10-12") });
  L.append({ shopId: SHOP_A, type: "sale", amountKobo: 100000, customer: "=cmd", item: 'red, "big" rice', createdAt: stamp("2026-10-15") });
  L.append({ shopId: SHOP_A, type: "sale", amountKobo: 5, customer: "Chidi", createdAt: stamp("2026-10-20") });
  // Corrected upward the same month: the original must not double-count.
  L.appendCorrection(adaSale.id, { amountKobo: 1600000, createdAt: stamp("2026-10-05", "15:00:00") });
  // Previous month (unpaid, counts toward debts owed) and next month rows.
  L.append({ shopId: SHOP_A, type: "sale", amountKobo: 300000, customer: "Dele", item: "rice", createdAt: stamp("2026-09-28") });
  L.append({ shopId: SHOP_A, type: "sale", amountKobo: 999999, customer: "Emeka", item: "rice", createdAt: stamp("2026-11-01") });
  // Another shop's October sale never appears in shop A's file.
  L.append({ shopId: SHOP_B, type: "sale", amountKobo: 111111, customer: "Zed", item: "rice", createdAt: stamp("2026-10-09") });
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function csvLines(text) {
  return stripBom(text).split("\r\n");
}

describe("month maths", () => {
  it("bounds months in Lagos days, December rolls the year", () => {
    assert.deepEqual(monthBounds("2026-10"), { month: "2026-10", from: "2026-10-01", to: "2026-10-31" });
    assert.deepEqual(monthBounds("2026-12"), { month: "2026-12", from: "2026-12-01", to: "2026-12-31" });
    assert.deepEqual(monthBounds("2026-02"), { month: "2026-02", from: "2026-02-01", to: "2026-02-28" });
  });

  it("bad months throw a plain 400", () => {
    for (const bad of ["october", "2026-13", "2026-1", "2026-10-05", "  ", 202610, null]) {
      assert.throws(() => monthBounds(bad), (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.message, "month must look like 2026-10");
        return true;
      }, JSON.stringify(bad));
    }
  });

  it("a missing month reads as the current Lagos month", () => {
    assert.deepEqual(parseReportMonth(null, Date.parse("2026-10-15T12:00:00Z")).month, "2026-10");
    assert.deepEqual(parseReportMonth("  ", Date.parse("2025-12-31T22:30:00Z")).month, "2025-12");
  });

  it("kobo renders exact naira with integer maths, signed", () => {
    assert.equal(koboToNaira(5), "0.05");
    assert.equal(koboToNaira(0), "0.00");
    assert.equal(koboToNaira(1500000), "15000.00");
    assert.equal(koboToNaira(-1549995), "-15499.95");
    assert.throws(() => koboToNaira(1.5), /integer/);
  });

  it("cells guard formulas and escape commas and quotes", () => {
    assert.equal(csvCell("=cmd"), "\"'=cmd\"");
    assert.equal(csvCell("+234801"), "\"'+234801\"");
    assert.equal(csvCell("-5"), "\"'-5\"");
    assert.equal(csvCell("@x"), "\"'@x\"");
    assert.equal(csvCell('red, "big" rice'), '"red, ""big"" rice"');
    assert.equal(csvCell("plain"), "plain");
    assert.equal(csvCell(1500000), "1500000");
  });

  it("the file opens with a UTF-8 BOM", () => {
    assert.equal(CSV_BOM, "﻿");
    assert.equal(CSV_BOM.charCodeAt(0), 0xfeff);
    assert.equal(buildMonthlyCsv([], OCT).csv.charCodeAt(0), 0xfeff);
  });
});

describe("monthly csv rows and totals", () => {
  it("correct rows and totals for a fake month", () => {
    const ctx = setup();
    try {
      seedOctober(ctx);
      const { csv } = buildMonthlyCsv(ctx.ledger.list(SHOP_A), OCT);
      const lines = csvLines(csv);
      assert.deepEqual(lines.slice(0, 9), [
        "Date,Type,Customer,Item,Amount (Naira),Note",
        "2026-10-03,expense,shop-a,rice,50000.00,",
        "2026-10-05,debt,Ada,rice,16000.00,",
        "2026-10-06,payment,Ada,,15000.00,",
        "2026-10-07,sale,Funmi,gari,7000.00,",
        "2026-10-08,payment,Funmi,,7000.00,",
        "2026-10-10,debt,Bola,beans,20000.00,",
        "2026-10-11,payment,Bola,,5000.00,",
        "2026-10-12,expense,shop-a,transport,2500.00,",
      ]);
      assert.deepEqual(lines.slice(9, 15), [
        "2026-10-15,debt,\"'=cmd\",\"red, \"\"big\"\" rice\",1000.00,",
        "2026-10-20,debt,Chidi,,0.05,",
        "",
        "Total sales,44000.05",
        "Total expenses,52500.00",
        "Profit,-8499.95",
      ]);
      assert.deepEqual(lines.slice(15), ["Debts still owed,20000.05", "Number of entries,10", ""]);
      const text = lines.join("\n");
      assert.ok(!text.includes("Dele"), "September rows stay out");
      assert.ok(!text.includes("Emeka"), "November rows stay out");
      assert.ok(!text.includes("Zed"), "another shop stays out");
    } finally {
      teardown(ctx);
    }
  });

  it("unconfirmed and rejected proposals never appear", () => {
    const ctx = setup();
    try {
      seedOctober(ctx);
      ctx.proposals.create({ shopId: SHOP_A, envelope: { version: 1, entries: [] }, heard: "unconfirmed" });
      ctx.proposals.create({ shopId: SHOP_A, status: "rejected", envelope: { version: 1, entries: [] }, heard: "rejected" });
      const { csv } = buildMonthlyCsv(ctx.ledger.list(SHOP_A), OCT);
      assert.ok(!csv.includes("unconfirmed"));
      assert.ok(!csv.includes("rejected"));
      assert.ok(csv.includes("Number of entries,10"));
    } finally {
      teardown(ctx);
    }
  });

  it("an empty month is a valid file with a zero summary", () => {
    const ctx = setup();
    try {
      const { csv } = buildMonthlyCsv(ctx.ledger.list(SHOP_A), OCT);
      assert.deepEqual(csvLines(csv), [
        "Date,Type,Customer,Item,Amount (Naira),Note",
        "",
        "Total sales,0.00",
        "Total expenses,0.00",
        "Profit,0.00",
        "Debts still owed,0.00",
        "Number of entries,0",
        "",
      ]);
    } finally {
      teardown(ctx);
    }
  });
});

describe("GET /reports/monthly.csv", () => {
  it("serves the file with csv headers, BOM and shop filename", async () => {
    const ctx = setup();
    try {
      seedOctober(ctx);
      const out = await dispatch(ctx.deps, {
        method: "GET",
        url: "/reports/monthly.csv?month=2026-10",
        headers: { "x-shop-id": SHOP_A },
      });
      assert.equal(out.status, 200);
      assert.equal(out.headers["Content-Type"], "text/csv; charset=utf-8");
      assert.equal(out.headers["Content-Disposition"], 'attachment; filename="pocketoga-2026-10.csv"');
      assert.equal(out.text.charCodeAt(0), 0xfeff);
      assert.ok(out.text.includes("Total sales,44000.05"));
      assert.ok(out.text.includes("Number of entries,10"));
      assert.ok(!out.text.includes("Zed"));
    } finally {
      teardown(ctx);
    }
  });

  it("the demo shop works with no login", async () => {
    const ctx = setup();
    try {
      ctx.ledger.append({ shopId: DEMO_SHOP_ID, type: "sale", amountKobo: 100000, customer: "Ada", item: "rice", createdAt: stamp("2026-10-04") });
      const out = await dispatch(ctx.deps, {
        method: "GET",
        url: "/reports/monthly.csv?month=2026-10",
        headers: { "x-shop-id": DEMO_SHOP_ID },
      });
      assert.equal(out.status, 200);
      assert.ok(out.text.includes("Ada"));
    } finally {
      teardown(ctx);
    }
  });

  it("a missing month uses the current Lagos month", async () => {
    const ctx = setup();
    try {
      const out = await dispatch(ctx.deps, {
        method: "GET",
        url: "/reports/monthly.csv",
        headers: { "x-shop-id": SHOP_A },
      });
      assert.equal(out.status, 200);
      const want = lagosDay(Date.now()).slice(0, 7);
      assert.equal(out.headers["Content-Disposition"], `attachment; filename="pocketoga-${want}.csv"`);
    } finally {
      teardown(ctx);
    }
  });

  it("bad months are plain 400s", async () => {
    const ctx = setup();
    try {
      for (const month of ["october", "2026-13", "2026-1"]) {
        const out = await dispatch(ctx.deps, {
          method: "GET",
          url: `/reports/monthly.csv?month=${month}`,
          headers: { "x-shop-id": SHOP_A },
        });
        assert.equal(out.status, 400, month);
        assert.deepEqual(JSON.parse(out.text), { error: "month must look like 2026-10" });
      }
    } finally {
      teardown(ctx);
    }
  });

  it("needs a login, and another shop's token is refused", async () => {
    const ctx = setup();
    try {
      const anon = await dispatch(ctx.deps, {
        method: "GET",
        url: "/reports/monthly.csv?month=2026-10",
        headers: { "x-shop-id": SHOP_A, authorization: "Bearer not-a-token" },
      });
      assert.equal(anon.status, 401);
      const crossed = await dispatch(ctx.deps, {
        method: "GET",
        url: "/reports/monthly.csv?month=2026-10",
        headers: { "x-shop-id": SHOP_B, authorization: `Bearer ${tokenFor(ctx.deps, SHOP_A)}` },
      });
      assert.equal(crossed.status, 403);
    } finally {
      teardown(ctx);
    }
  });

  it("404s on the webhook-only listener", async () => {
    const ctx = setup();
    try {
      const out = await dispatchOnly(ctx.deps, { method: "GET", url: "/reports/monthly.csv?month=2026-10" });
      assert.equal(out.status, 404);
    } finally {
      teardown(ctx);
    }
  });
});
