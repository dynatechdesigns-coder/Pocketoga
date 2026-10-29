import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { PromiseStore } from "./promises.mjs";
import {
  AuthStore,
  DEMO_SHOP_ID,
  LOGIN_CODE_TTL_MS,
  SESSION_TTL_MS,
  hashSecret,
} from "./auth.mjs";
import { handleVoiceRequest } from "./server.mjs";

// Fake fixtures only. Passwordless login: WhatsApp codes in, session tokens
// out, every non-demo route gated on a token for exactly that shop.
const SHOP = "auth-shop";
const OTHER = "auth-other";
const SENDER = "2348000000001";
const NOW = Date.parse("2026-10-29T12:00:00.000Z");

function setup() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    ledger: new Ledger(db),
    promises: new PromiseStore(db),
    auths: new AuthStore(db),
  };
}

function teardown(ctx) {
  ctx.db.close();
}

function req({ method = "GET", url = "/", headers = {}, body } = {}) {
  const r = new EventEmitter();
  r.method = method;
  r.url = url;
  r.headers = headers;
  r.destroy = () => {};
  process.nextTick(() => {
    if (body !== undefined) r.emit("data", Buffer.from(JSON.stringify(body)));
    r.emit("end");
  });
  return r;
}

function res() {
  return {
    statusCode: null,
    chunks: "",
    headersSent: false,
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) this.chunks += chunk;
    },
  };
}

async function dispatch(deps, opts) {
  const r = res();
  try {
    await handleVoiceRequest(req(opts), r, deps);
  } catch (err) {
    if (!r.headersSent) {
      r.writeHead(err.status ?? 500);
      r.end(JSON.stringify({ error: err.message ?? "internal error" }));
    }
  }
  return { status: r.statusCode, json: JSON.parse(r.chunks) };
}

// One full login through the real store: the token tests hand to HTTP.
function login(auths, shop, sender) {
  const issued = auths.issueCode(shop, sender, { now: NOW });
  assert.equal(issued.limited, false);
  const out = auths.exchangeCode(shop, issued.code, { now: NOW });
  assert.equal(out.ok, true);
  return out.token;
}

describe("login codes (store)", () => {
  it("a fresh code exchanges once for a token bound to that shop", () => {
    const ctx = setup();
    try {
      const issued = ctx.auths.issueCode(SHOP, SENDER, { now: NOW });
      assert.equal(issued.limited, false);
      assert.match(issued.code, /^\d{6}$/);
      const out = ctx.auths.exchangeCode(SHOP, issued.code, { now: NOW });
      assert.equal(out.ok, true);
      assert.equal(out.shopId, SHOP);
      assert.equal(out.expiresAt, new Date(NOW + SESSION_TTL_MS).toISOString());
      const session = ctx.auths.verifyToken(out.token, { now: NOW });
      assert.equal(session.shopId, SHOP);
      assert.equal(typeof session.sessionId, "number");
    } finally {
      teardown(ctx);
    }
  });

  it("a code is one use: the second exchange fails as used", () => {
    const ctx = setup();
    try {
      const issued = ctx.auths.issueCode(SHOP, SENDER, { now: NOW });
      assert.equal(ctx.auths.exchangeCode(SHOP, issued.code, { now: NOW }).ok, true);
      const again = ctx.auths.exchangeCode(SHOP, issued.code, { now: NOW });
      assert.deepEqual([again.ok, again.reason], [false, "used"]);
    } finally {
      teardown(ctx);
    }
  });

  it("a code past its 10-minute expiry fails as expired", () => {
    const ctx = setup();
    try {
      const issued = ctx.auths.issueCode(SHOP, SENDER, { now: NOW });
      const late = ctx.auths.exchangeCode(SHOP, issued.code, { now: NOW + LOGIN_CODE_TTL_MS + 1000 });
      assert.deepEqual([late.ok, late.reason], [false, "expired"]);
    } finally {
      teardown(ctx);
    }
  });

  it("an unknown code fails as wrong, and a code is shop-scoped", () => {
    const ctx = setup();
    try {
      assert.deepEqual(
        [ctx.auths.exchangeCode(SHOP, "000000", { now: NOW }).reason],
        ["wrong"]
      );
      const issued = ctx.auths.issueCode(SHOP, SENDER, { now: NOW });
      const cross = ctx.auths.exchangeCode(OTHER, issued.code, { now: NOW });
      assert.deepEqual([cross.ok, cross.reason], [false, "wrong"]);
    } finally {
      teardown(ctx);
    }
  });

  it("issue is limited to 5 codes per number per hour", () => {
    const ctx = setup();
    try {
      for (let i = 0; i < 5; i++) {
        assert.equal(ctx.auths.issueCode(SHOP, SENDER, { now: NOW }).limited, false);
      }
      assert.equal(ctx.auths.issueCode(SHOP, SENDER, { now: NOW }).limited, true);
      // Another sender still has a full budget.
      assert.equal(ctx.auths.issueCode(SHOP, "2348000000002", { now: NOW }).limited, false);
    } finally {
      teardown(ctx);
    }
  });

  it("exchange guesses are limited to 5 per shop per hour", () => {
    const ctx = setup();
    try {
      const issued = ctx.auths.issueCode(SHOP, SENDER, { now: NOW });
      for (let i = 0; i < 5; i++) {
        assert.equal(ctx.auths.exchangeCode(SHOP, "000000", { now: NOW }).reason, "wrong");
      }
      const blocked = ctx.auths.exchangeCode(SHOP, issued.code, { now: NOW });
      assert.deepEqual([blocked.ok, blocked.reason], [false, "rate_limited"]);
    } finally {
      teardown(ctx);
    }
  });

  it("only hashes reach the tables: no code or token in plaintext", () => {
    const ctx = setup();
    try {
      const issued = ctx.auths.issueCode(SHOP, SENDER, { now: NOW });
      const out = ctx.auths.exchangeCode(SHOP, issued.code, { now: NOW });
      const dump = JSON.stringify([
        ctx.db.prepare("SELECT * FROM login_codes").all(),
        ctx.db.prepare("SELECT * FROM login_attempts").all(),
        ctx.db.prepare("SELECT * FROM sessions").all(),
      ]);
      assert.ok(!dump.includes(issued.code), "plaintext code stored");
      assert.ok(!dump.includes(out.token), "plaintext token stored");
      assert.ok(dump.includes(hashSecret(issued.code)), "code hash missing");
      assert.ok(dump.includes(hashSecret(out.token)), "token hash missing");
    } finally {
      teardown(ctx);
    }
  });
});

describe("sessions (store)", () => {
  it("a revoked token no longer verifies, and revoking twice reports false", () => {
    const ctx = setup();
    try {
      const token = login(ctx.auths, SHOP, SENDER);
      assert.ok(ctx.auths.verifyToken(token, { now: NOW }));
      assert.equal(ctx.auths.revokeToken(token, { now: NOW }), true);
      assert.equal(ctx.auths.verifyToken(token, { now: NOW }), null);
      assert.equal(ctx.auths.revokeToken(token, { now: NOW }), false);
      assert.equal(ctx.auths.revokeToken("no-such-token", { now: NOW }), false);
    } finally {
      teardown(ctx);
    }
  });

  it("an expired session no longer verifies", () => {
    const ctx = setup();
    try {
      const token = login(ctx.auths, SHOP, SENDER);
      assert.equal(ctx.auths.verifyToken(token, { now: NOW + SESSION_TTL_MS + 1000 }), null);
    } finally {
      teardown(ctx);
    }
  });
});

describe("POST /session", () => {
  function depsFor(ctx) {
    return { ledger: ctx.ledger, promises: ctx.promises, auths: ctx.auths };
  }

  it("exchanges a valid code for a token (201) that opens the shop", async () => {
    const ctx = setup();
    try {
      const deps = depsFor(ctx);
      const issued = ctx.auths.issueCode(SHOP, SENDER, {});
      const out = await dispatch(deps, {
        method: "POST",
        url: "/session",
        body: { shop: SHOP, code: issued.code },
      });
      assert.equal(out.status, 201);
      assert.equal(out.json.shop_id, SHOP);
      assert.equal(typeof out.json.token, "string");
      assert.equal(typeof out.json.expires_at, "string");
      const gated = await dispatch(deps, {
        url: "/report",
        headers: { "x-shop-id": SHOP, authorization: `Bearer ${out.json.token}` },
      });
      assert.equal(gated.status, 200);
    } finally {
      teardown(ctx);
    }
  });

  it("rejects missing fields (400) and bad codes (401)", async () => {
    const ctx = setup();
    try {
      const deps = depsFor(ctx);
      const naked = await dispatch(deps, { method: "POST", url: "/session", body: {} });
      assert.equal(naked.status, 400);
      const wrong = await dispatch(deps, {
        method: "POST",
        url: "/session",
        body: { shop: SHOP, code: "000000" },
      });
      assert.equal(wrong.status, 401);
      const issued = ctx.auths.issueCode(SHOP, SENDER, {});
      await dispatch(deps, { method: "POST", url: "/session", body: { shop: SHOP, code: issued.code } });
      const reused = await dispatch(deps, {
        method: "POST",
        url: "/session",
        body: { shop: SHOP, code: issued.code },
      });
      assert.equal(reused.status, 401);
    } finally {
      teardown(ctx);
    }
  });

  it("rate-limits guessing with 429 after 5 failures", async () => {
    const ctx = setup();
    try {
      const deps = depsFor(ctx);
      for (let i = 0; i < 5; i++) {
        const out = await dispatch(deps, {
          method: "POST",
          url: "/session",
          body: { shop: SHOP, code: "000000" },
        });
        assert.equal(out.status, 401);
      }
      const blocked = await dispatch(deps, {
        method: "POST",
        url: "/session",
        body: { shop: SHOP, code: "000000" },
      });
      assert.equal(blocked.status, 429);
    } finally {
      teardown(ctx);
    }
  });
});

describe("DELETE /session", () => {
  it("revokes the caller's token; the token then fails the gate", async () => {
    const ctx = setup();
    try {
      const deps = { ledger: ctx.ledger, promises: ctx.promises, auths: ctx.auths };
      const token = login(ctx.auths, SHOP, SENDER);
      const bye = await dispatch(deps, {
        method: "DELETE",
        url: "/session",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.deepEqual([bye.status, bye.json], [200, { revoked: true }]);
      const after = await dispatch(deps, {
        url: "/report",
        headers: { "x-shop-id": SHOP, authorization: `Bearer ${token}` },
      });
      assert.equal(after.status, 401);
      const naked = await dispatch(deps, { method: "DELETE", url: "/session" });
      assert.equal(naked.status, 401);
    } finally {
      teardown(ctx);
    }
  });
});

describe("session gate", () => {
  function depsFor(ctx) {
    return { ledger: ctx.ledger, promises: ctx.promises, auths: ctx.auths };
  }

  it("refuses a real shop without a token: no open by name", async () => {
    const ctx = setup();
    try {
      const out = await dispatch(depsFor(ctx), { url: "/report", headers: { "x-shop-id": SHOP } });
      assert.equal(out.status, 401);
    } finally {
      teardown(ctx);
    }
  });

  it("refuses a session used on another shop (403)", async () => {
    const ctx = setup();
    try {
      const deps = depsFor(ctx);
      const token = login(ctx.auths, SHOP, SENDER);
      const cross = await dispatch(deps, {
        url: "/report",
        headers: { "x-shop-id": OTHER, authorization: `Bearer ${token}` },
      });
      assert.equal(cross.status, 403);
      const home = await dispatch(deps, {
        url: "/report",
        headers: { "x-shop-id": SHOP, authorization: `Bearer ${token}` },
      });
      assert.equal(home.status, 200);
    } finally {
      teardown(ctx);
    }
  });

  it("fails closed when the auth store is missing", async () => {
    const ctx = setup();
    try {
      const out = await dispatch(
        { ledger: ctx.ledger, promises: ctx.promises },
        { url: "/report", headers: { "x-shop-id": SHOP, authorization: "Bearer x" } }
      );
      assert.equal(out.status, 500);
    } finally {
      teardown(ctx);
    }
  });

  it("the demo shop stays public, and a demo login cannot reach real shops", async () => {
    const ctx = setup();
    try {
      const deps = depsFor(ctx);
      const open = await dispatch(deps, { url: "/report", headers: { "x-shop-id": DEMO_SHOP_ID } });
      assert.equal(open.status, 200);
      const demoToken = login(ctx.auths, DEMO_SHOP_ID, "2348000000009");
      const leak = await dispatch(deps, {
        url: "/report",
        headers: { "x-shop-id": SHOP, authorization: `Bearer ${demoToken}` },
      });
      assert.equal(leak.status, 403);
    } finally {
      teardown(ctx);
    }
  });
});
