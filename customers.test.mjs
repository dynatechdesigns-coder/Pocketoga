// Customers directory: names, phones and consent live here — never in the
// ledger, hashes, logs or model prompts. Fake data only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { CustomerStore, normalizePhone, describeCustomers } from "./customers.mjs";
import { customerDebts } from "./debts.mjs";
import { handleVoiceRequest, handleWebhookOnlyRequest } from "./server.mjs";
import { AuthStore, DEMO_SHOP_ID } from "./auth.mjs";

const SHOP_A = "shop-a";
const SHOP_B = "shop-b";

function setup() {
  const db = new DatabaseSync(":memory:");
  return { db, ledger: new Ledger(db), customers: new CustomerStore(db), auths: new AuthStore(db) };
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

describe("normalizePhone", () => {
  it("stores digits with a country code; Nigerian 0-numbers become 234", () => {
    assert.equal(normalizePhone("0803 123 4567"), "2348031234567");
    assert.equal(normalizePhone("+2348031234567"), "2348031234567");
    assert.equal(normalizePhone("2348031234567"), "2348031234567");
    assert.equal(normalizePhone("8031234567"), "2348031234567");
    assert.equal(normalizePhone("(080) 3123-4567"), "2348031234567");
  });

  it("rejects empty and too-short numbers", () => {
    for (const bad of ["", "   ", "abc", "123", null, undefined, 8031234567]) {
      assert.throws(() => normalizePhone(bad), /phone/, `phone ${String(bad)}`);
    }
  });
});

describe("CustomerStore", () => {
  it("upserts by normalized name, keeping the first-seen spelling", () => {
    const ctx = setup();
    try {
      const first = ctx.customers.upsert({ shopId: SHOP_A, name: "Ada", phone: "08031234567", consent: true });
      assert.equal(first.name, "Ada");
      assert.equal(first.phone, "2348031234567");
      assert.ok(first.consent_at);

      const again = ctx.customers.upsert({ shopId: SHOP_A, name: "  ADA ", phone: "+2348098765432", consent: true });
      assert.equal(again.id, first.id);
      assert.equal(again.name, "Ada");
      assert.equal(again.phone, "2348098765432");
      assert.equal(ctx.customers.listByShop(SHOP_A).length, 1);

      // Same name in another shop is a different customer.
      const other = ctx.customers.upsert({ shopId: SHOP_B, name: "ada", phone: "08031234567", consent: true });
      assert.notEqual(other.id, first.id);
    } finally {
      teardown(ctx);
    }
  });

  it("refuses a phone without consent, but names alone are fine", () => {
    const ctx = setup();
    try {
      for (const consent of [false, null, undefined, "yes", 1]) {
        assert.throws(
          () => ctx.customers.upsert({ shopId: SHOP_A, name: "Bola", phone: "08031234567", consent }),
          /consent/,
          `consent ${String(consent)}`
        );
      }
      assert.equal(ctx.customers.listByShop(SHOP_A).length, 0);
      const named = ctx.customers.upsert({ shopId: SHOP_A, name: "Bola" });
      assert.equal(named.phone, null);
      assert.equal(named.consent_at, null);
    } finally {
      teardown(ctx);
    }
  });

  it("clearPhone forgets the phone and consent but keeps the customer", () => {
    const ctx = setup();
    try {
      const ada = ctx.customers.upsert({ shopId: SHOP_A, name: "Ada", phone: "08031234567", consent: true });
      const cleared = ctx.customers.clearPhone(ada.id);
      assert.equal(cleared.id, ada.id);
      assert.equal(cleared.name, "Ada");
      assert.equal(cleared.phone, null);
      assert.equal(cleared.consent_at, null);
      assert.throws(() => ctx.customers.clearPhone(9999), /not found/);
    } finally {
      teardown(ctx);
    }
  });

  it("requires a name and isolates shops", () => {
    const ctx = setup();
    try {
      for (const bad of ["", "   ", null, undefined]) {
        assert.throws(() => ctx.customers.upsert({ shopId: SHOP_A, name: bad }), /name/, `name ${String(bad)}`);
      }
      ctx.customers.upsert({ shopId: SHOP_A, name: "Ada" });
      assert.deepEqual(
        ctx.customers.listByShop(SHOP_A).map((c) => c.name),
        ["Ada"]
      );
      assert.deepEqual(ctx.customers.listByShop(SHOP_B), []);
    } finally {
      teardown(ctx);
    }
  });
});

describe("describeCustomers", () => {
  it("unions the directory with ledger-only names, owed from debts.mjs", () => {
    const ctx = setup();
    try {
      ctx.customers.upsert({ shopId: SHOP_A, name: "Ada", phone: "08031234567", consent: true });
      ctx.customers.upsert({ shopId: SHOP_A, name: "Ghost", phone: "08000000000", consent: true });
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada", createdAt: "2026-10-20T10:00:00.000Z" });
      ctx.ledger.append({ shopId: SHOP_A, type: "payment", amountKobo: 500000, customer: "ada", createdAt: "2026-10-25T10:00:00.000Z" });
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 700000, customer: "Bola", createdAt: "2026-10-21T10:00:00.000Z" });
      // Self-restock: the shop itself is not a customer.
      ctx.ledger.append({ shopId: SHOP_A, type: "restock", amountKobo: 1000000, customer: SHOP_A, item: "rice", quantity: 5, unit: "bag" });

      const rows = ctx.ledger.list(SHOP_A);
      const debts = customerDebts(rows, {});
      const out = describeCustomers(ctx.customers.listByShop(SHOP_A), rows, SHOP_A);
      assert.deepEqual(
        out.map((c) => [c.name, c.phone !== null]),
        [
          ["Ada", true],
          ["Bola", false],
          ["Ghost", true],
        ]
      );
      const ada = out.find((c) => c.name === "Ada");
      assert.equal(ada.owedKobo, debts.find((d) => d.customer === "Ada").owedKobo);
      assert.equal(ada.owedKobo, 1500000);
      assert.equal(ada.lastActivityAt, "2026-10-25T10:00:00.000Z");
      assert.ok(Number.isInteger(ada.id));

      const bola = out.find((c) => c.name === "Bola");
      assert.equal(bola.id, null);
      assert.equal(bola.phone, null);
      assert.equal(bola.owedKobo, 700000);
      assert.equal(bola.lastActivityAt, "2026-10-21T10:00:00.000Z");

      const ghost = out.find((c) => c.name === "Ghost");
      assert.equal(ghost.owedKobo, 0);
      assert.equal(ghost.lastActivityAt, null);
    } finally {
      teardown(ctx);
    }
  });
});

describe("customers routes", () => {
  function routeCtx() {
    const ctx = setup();
    return { ...ctx, deps: { ledger: ctx.ledger, customers: ctx.customers, auths: ctx.auths } };
  }

  it("GET /customers returns the directory plus ledger-only names, per shop", async () => {
    const ctx = routeCtx();
    try {
      ctx.customers.upsert({ shopId: SHOP_A, name: "Ada", phone: "08031234567", consent: true });
      ctx.ledger.append({ shopId: SHOP_A, type: "sale", amountKobo: 2000000, customer: "Ada", createdAt: "2026-10-20T10:00:00.000Z" });
      ctx.customers.upsert({ shopId: SHOP_B, name: "Zed", phone: "08099999999", consent: true });

      const out = await dispatch(ctx.deps, { url: "/customers", headers: { "x-shop-id": SHOP_A } });
      assert.equal(out.status, 200);
      assert.deepEqual(out.json, {
        customers: [{ id: out.json.customers[0].id, name: "Ada", phone: "2348031234567", owedKobo: 2000000, lastActivityAt: "2026-10-20T10:00:00.000Z" }],
      });
      assert.ok(Number.isInteger(out.json.customers[0].id));

      const other = await dispatch(ctx.deps, { url: "/customers", headers: { "x-shop-id": SHOP_B } });
      assert.equal(other.status, 200);
      assert.deepEqual(
        other.json.customers.map((c) => c.name),
        ["Zed"]
      );
    } finally {
      teardown(ctx);
    }
  });

  it("POST /customers creates or updates by name and needs consent for phones", async () => {
    const ctx = routeCtx();
    try {
      const created = await dispatch(ctx.deps, {
        method: "POST",
        url: "/customers",
        headers: { "x-shop-id": SHOP_A },
        body: { name: "Ada", phone: "0803 123 4567", consent: true },
      });
      assert.equal(created.status, 200);
      assert.equal(created.json.customer.name, "Ada");
      assert.equal(created.json.customer.phone, "2348031234567");
      assert.equal(created.json.customer.owedKobo, 0);
      const id = created.json.customer.id;

      const updated = await dispatch(ctx.deps, {
        method: "POST",
        url: "/customers",
        headers: { "x-shop-id": SHOP_A },
        body: { name: "ada", phone: "+2348098765432", consent: true },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.json.customer.id, id);
      assert.equal(updated.json.customer.phone, "2348098765432");

      for (const body of [
        { name: "Bola", phone: "08031234567" },
        { name: "Bola", phone: "08031234567", consent: false },
        { name: "Bola", phone: "12", consent: true },
        { name: "", phone: "08031234567", consent: true },
      ]) {
        const bad = await dispatch(ctx.deps, { method: "POST", url: "/customers", headers: { "x-shop-id": SHOP_A }, body });
        assert.equal(bad.status, 400, JSON.stringify(body));
      }
      const noShop = await dispatch(ctx.deps, { method: "POST", url: "/customers", body: { name: "Ada" } });
      assert.equal(noShop.status, 400);
    } finally {
      teardown(ctx);
    }
  });

  it("POST /customers/:id/clear-phone forgets the phone; cross-shop refused", async () => {
    const ctx = routeCtx();
    try {
      const ada = ctx.customers.upsert({ shopId: SHOP_A, name: "Ada", phone: "08031234567", consent: true });
      const cleared = await dispatch(ctx.deps, {
        method: "POST",
        url: `/customers/${ada.id}/clear-phone`,
        headers: { "x-shop-id": SHOP_A },
      });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.json.customer.phone, null);
      assert.equal(cleared.json.customer.name, "Ada");

      const cross = await dispatch(ctx.deps, {
        method: "POST",
        url: `/customers/${ada.id}/clear-phone`,
        headers: { "x-shop-id": SHOP_B },
      });
      assert.equal(cross.status, 403);
      assert.equal(
        (await dispatch(ctx.deps, { method: "POST", url: "/customers/9999/clear-phone", headers: { "x-shop-id": SHOP_A } })).status,
        404
      );
    } finally {
      teardown(ctx);
    }
  });

  it("the webhook port 404s every customers route", async () => {
    const ctx = routeCtx();
    try {
      const ada = ctx.customers.upsert({ shopId: SHOP_A, name: "Ada" });
      const headers = { "x-shop-id": SHOP_A };
      assert.equal((await dispatchOnly(ctx.deps, { url: "/customers", headers })).status, 404);
      assert.equal((await dispatchOnly(ctx.deps, { method: "POST", url: "/customers", headers, body: { name: "x" } })).status, 404);
      assert.equal((await dispatchOnly(ctx.deps, { method: "POST", url: `/customers/${ada.id}/clear-phone`, headers })).status, 404);
    } finally {
      teardown(ctx);
    }
  });

  it("phone numbers never reach the ledger", async () => {
    const ctx = routeCtx();
    try {
      await dispatch(ctx.deps, {
        method: "POST",
        url: "/customers",
        headers: { "x-shop-id": SHOP_A },
        body: { name: "Ada", phone: "08031234567", consent: true },
      });
      const dump = JSON.stringify(ctx.ledger.list(SHOP_A));
      assert.ok(!dump.includes("08031234567"), dump);
      assert.ok(!dump.includes("2348031234567"), dump);
    } finally {
      teardown(ctx);
    }
  });
});
