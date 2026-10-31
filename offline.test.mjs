// Offline queue: x-request-id idempotency plus occurred_at. Fake data only,
// mock model, no network. Covers the web app's retry contract: the same
// shop + id replays the stored proposal, never proposes or records twice.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { PromiseStore } from "./promises.mjs";
import { PhotoCheckStore } from "./photos.mjs";
import { AuthStore } from "./auth.mjs";
import { IdempotencyStore, IDEMPOTENCY_TTL_MS } from "./idempotency.mjs";
import { createMockModelClient } from "./model.mjs";
import { resolveOccurredAt } from "./voice.mjs";
import { handleVoiceRequest } from "./server.mjs";
import { lagosDay } from "./debts.mjs";

const SHOP_A = "shop-a";
const SHOP_B = "shop-b";
const FAKE_PHOTO = "RkFLRS1QSE9UTy1CWVRFUw==";

// Clean two-entry reading: proposes with no questions on an empty ledger.
const PART_PAYMENT = {
  heard: "Ada buy rice 2 bags, na 15k. She pay 10k, remain 5k.",
  entries: [
    { type: "sale", customer: "Test Customer Ada", item: "fake-rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" },
    { type: "payment", customer: "Test Customer Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
  ],
  totals: {
    totalNaira: 15000,
    totalPhrase: "15k",
    paidNaira: 10000,
    paidPhrase: "10k",
    remainderNaira: 5000,
    remainderPhrase: "remain 5k",
  },
  question: null,
};

function alertReading(over = {}) {
  return {
    photoType: "payment_alert",
    status: "successful",
    date: lagosDay(Date.now()),
    amountNaira: 12000,
    amountPhrase: "12k",
    sender: "Ada",
    reference: "REF-OFFLINE-1",
    ...over,
  };
}

function setup(modelHandler) {
  const db = new DatabaseSync(":memory:");
  const deps = {
    db,
    ledger: new Ledger(db),
    proposals: new ProposalStore(db),
    promises: new PromiseStore(db),
    photoChecks: new PhotoCheckStore(db),
    auths: new AuthStore(db),
    idempotency: new IdempotencyStore(db),
    model: createMockModelClient(modelHandler),
  };
  return deps;
}

function teardown(deps) {
  deps.db.close();
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
    text: "",
    writeHead(status) {
      this.statusCode = status;
    },
    end(chunk) {
      if (chunk) this.text += String(chunk);
    },
  };
}

async function dispatch(deps, { method = "GET", url = "/", shop = null, body, headers = {} } = {}) {
  const out = { ...headers };
  if (shop) out["x-shop-id"] = shop;
  if (shop && deps.auths) out.authorization = `Bearer ${tokenFor(deps, shop)}`;
  const res = fakeRes();
  try {
    await handleVoiceRequest(fakeReq({ method, url, headers: out, body }), res, deps);
  } catch (err) {
    res.writeHead(err.status ?? 500);
    res.end(JSON.stringify({ error: err.message ?? "internal error" }));
  }
  return { status: res.statusCode, json: JSON.parse(res.text) };
}

const post = (deps, url, shop, body, headers) =>
  dispatch(deps, { method: "POST", url, shop, body, headers });

describe("offline queue: x-request-id idempotency", () => {
  it("a duplicate id returns the same proposal and never proposes twice", async () => {
    const deps = setup(async () => PART_PAYMENT);
    try {
      const first = await post(deps, "/propose", SHOP_A, { text: "fake note" }, { "x-request-id": "queue-1" });
      assert.equal(first.status, 201);
      assert.equal(deps.proposals.listByShop(SHOP_A).length, 1);

      const replay = await post(deps, "/propose", SHOP_A, { text: "fake note" }, { "x-request-id": "queue-1" });
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.json.proposal, first.json.proposal);
      assert.equal(deps.proposals.listByShop(SHOP_A).length, 1);
    } finally {
      teardown(deps);
    }
  });

  it("a replayed proposal confirms once: no second proposal, no second ledger entry", async () => {
    const deps = setup(async () => PART_PAYMENT);
    try {
      const first = await post(deps, "/propose", SHOP_A, { text: "fake note" }, { "x-request-id": "queue-2" });
      const replay = await post(deps, "/propose", SHOP_A, { text: "fake note" }, { "x-request-id": "queue-2" });
      assert.equal(replay.json.proposal.id, first.json.proposal.id);

      const id = first.json.proposal.id;
      const confirmed = await post(deps, `/confirm/${id}`, SHOP_A, {});
      assert.equal(confirmed.json.alreadyConfirmed, false);
      const again = await post(deps, `/confirm/${id}`, SHOP_A, {});
      assert.equal(again.json.alreadyConfirmed, true);
      assert.equal(deps.ledger.list(SHOP_A).length, 2);
      assert.equal(deps.proposals.listByShop(SHOP_A).length, 1);
    } finally {
      teardown(deps);
    }
  });

  it("the same id on another shop gets its own proposal", async () => {
    const deps = setup(async () => PART_PAYMENT);
    try {
      const a = await post(deps, "/propose", SHOP_A, { text: "fake note" }, { "x-request-id": "shared-id" });
      const b = await post(deps, "/propose", SHOP_B, { text: "fake note" }, { "x-request-id": "shared-id" });
      assert.equal(a.status, 201);
      assert.equal(b.status, 201);
      assert.notEqual(a.json.proposal.id, b.json.proposal.id);
      assert.equal(b.json.proposal.shop_id, SHOP_B);

      const replayB = await post(deps, "/propose", SHOP_B, { text: "fake note" }, { "x-request-id": "shared-id" });
      assert.equal(replayB.status, 200);
      assert.equal(replayB.json.proposal.id, b.json.proposal.id);
      assert.equal(deps.proposals.listByShop(SHOP_A).length, 1);
      assert.equal(deps.proposals.listByShop(SHOP_B).length, 1);
    } finally {
      teardown(deps);
    }
  });

  it("an id already being processed conflicts instead of double-proposing", async () => {
    const deps = setup(async () => PART_PAYMENT);
    try {
      assert.equal(deps.idempotency.reserve(SHOP_A, "inflight-1", new Date().toISOString()), true);
      const res = await post(deps, "/propose", SHOP_A, { text: "fake note" }, { "x-request-id": "inflight-1" });
      assert.equal(res.status, 409);
      assert.equal(deps.proposals.listByShop(SHOP_A).length, 0);
    } finally {
      teardown(deps);
    }
  });

  it("an id older than 24 hours proposes fresh", async () => {
    const deps = setup(async () => PART_PAYMENT);
    try {
      const first = await post(deps, "/propose", SHOP_A, { text: "fake note" }, { "x-request-id": "stale-1" });
      assert.equal(first.status, 201);
      deps.db
        .prepare("UPDATE idempotency_keys SET created_at = ? WHERE shop_id = ? AND request_id = ?")
        .run(new Date(Date.now() - IDEMPOTENCY_TTL_MS - 1000).toISOString(), SHOP_A, "stale-1");

      const second = await post(deps, "/propose", SHOP_A, { text: "fake note" }, { "x-request-id": "stale-1" });
      assert.equal(second.status, 201);
      assert.notEqual(second.json.proposal.id, first.json.proposal.id);
      assert.equal(deps.proposals.listByShop(SHOP_A).length, 2);
    } finally {
      teardown(deps);
    }
  });

  it("a blank or overlong request id is a 400 and proposes nothing", async () => {
    const deps = setup(async () => PART_PAYMENT);
    try {
      for (const bad of ["", "   ", "x".repeat(200)]) {
        const res = await post(deps, "/propose", SHOP_A, { text: "fake note" }, { "x-request-id": bad });
        assert.equal(res.status, 400);
      }
      assert.equal(deps.proposals.listByShop(SHOP_A).length, 0);
    } finally {
      teardown(deps);
    }
  });

  it("manual proposals replay under the same id and confirm once", async () => {
    const deps = setup(async () => PART_PAYMENT);
    try {
      const body = { kind: "sale", customer: "Ada", item: "rice", quantity: 1, amount_naira: "2500.50" };
      const first = await post(deps, "/proposals/manual", SHOP_A, body, { "x-request-id": "manual-1" });
      assert.equal(first.status, 201);
      assert.equal(first.json.proposal.source, "manual");
      const replay = await post(deps, "/proposals/manual", SHOP_A, body, { "x-request-id": "manual-1" });
      assert.equal(replay.status, 200);
      assert.equal(replay.json.proposal.id, first.json.proposal.id);
      assert.equal(deps.proposals.listByShop(SHOP_A).length, 1);
      const id = first.json.proposal.id;
      const confirmed = await post(deps, `/confirm/${id}`, SHOP_A, {});
      assert.equal(confirmed.json.alreadyConfirmed, false);
      const again = await post(deps, `/confirm/${id}`, SHOP_A, {});
      assert.equal(again.json.alreadyConfirmed, true);
      assert.equal(deps.ledger.list(SHOP_A).length, 2);
      assert.equal(deps.proposals.listByShop(SHOP_A).length, 1);
    } finally {
      teardown(deps);
    }
  });

  it("form and photo routes replay under the same id", async () => {
    const deps = setup(async () => PART_PAYMENT);
    try {
      const form = { type: "sale", amountNaira: 15000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" };
      const f1 = await post(deps, "/propose-form", SHOP_A, form, { "x-request-id": "form-1" });
      const f2 = await post(deps, "/propose-form", SHOP_A, form, { "x-request-id": "form-1" });
      assert.equal(f1.status, 201);
      assert.equal(f2.status, 200);
      assert.equal(f2.json.proposal.id, f1.json.proposal.id);
      assert.equal(deps.proposals.listByShop(SHOP_A).length, 1);
    } finally {
      teardown(deps);
    }
  });

  it("a voice note replays under the same id", async () => {
    const deps = setup(async () => PART_PAYMENT);
    try {
      const audio = { audioBase64: "RkFLRS1BVURJTw==", audioFormat: "wav" };
      const v1 = await post(deps, "/propose", SHOP_A, audio, { "x-request-id": "voice-1" });
      const v2 = await post(deps, "/propose", SHOP_A, audio, { "x-request-id": "voice-1" });
      assert.equal(v1.status, 201);
      assert.equal(v2.status, 200);
      assert.equal(v1.json.proposal.source, "voice");
      assert.equal(v2.json.proposal.id, v1.json.proposal.id);
      assert.equal(deps.proposals.listByShop(SHOP_A).length, 1);
    } finally {
      teardown(deps);
    }
  });

  it("a photo check replays under the same id with no second proposal", async () => {
    const photoDeps = setup(async () => alertReading());
    try {
      const body = { photoBase64: FAKE_PHOTO, photoFormat: "png" };
      const p1 = await post(photoDeps, "/photo-checks", SHOP_A, body, { "x-request-id": "photo-1" });
      const p2 = await post(photoDeps, "/photo-checks", SHOP_A, body, { "x-request-id": "photo-1" });
      assert.equal(p1.status, 201);
      assert.equal(p2.status, 200);
      assert.equal(p2.json.proposal.id, p1.json.proposal.id);
      assert.equal(photoDeps.proposals.listByShop(SHOP_A).length, 1);
      assert.equal(photoDeps.photoChecks.listByShop(SHOP_A).length, 0);
    } finally {
      teardown(photoDeps);
    }
  });
});

describe("offline queue: occurred_at", () => {
  it("resolveOccurredAt keeps only ISO stamps within the last 7 days and not in the future", () => {
    const now = Date.parse("2026-10-31T12:00:00.000Z");
    const iso = (ms) => new Date(ms).toISOString();
    assert.equal(resolveOccurredAt(iso(now - 1000), now), iso(now - 1000));
    assert.equal(resolveOccurredAt(iso(now - 7 * 24 * 60 * 60 * 1000), now), iso(now - 7 * 24 * 60 * 60 * 1000));
    assert.equal(resolveOccurredAt(iso(now - 7 * 24 * 60 * 60 * 1000 - 1000), now), null);
    assert.equal(resolveOccurredAt(iso(now + 1000), now), null);
    assert.equal(resolveOccurredAt("not-a-date", now), null);
    assert.equal(resolveOccurredAt("yesterday", now), null);
    assert.equal(resolveOccurredAt(12345, now), null);
    assert.equal(resolveOccurredAt(null, now), null);
    assert.equal(resolveOccurredAt(undefined, now), null);
  });

  it("a valid occurred_at is kept; a bad, future or old one falls back to now", async () => {
    const deps = setup(async () => PART_PAYMENT);
    try {
      const form = { type: "sale", amountNaira: 15000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" };
      const valid = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const kept = await post(deps, "/propose-form", SHOP_A, { ...form, occurred_at: valid });
      assert.equal(kept.status, 201);
      assert.equal(kept.json.proposal.occurred_at, valid);

      const cases = [
        ["in the future", new Date(Date.now() + 60 * 60 * 1000).toISOString()],
        ["older than 7 days", new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()],
        ["not a timestamp", "not-a-date"],
        ["not a string", 12345],
        ["missing", undefined],
      ];
      for (const [label, occurred_at] of cases) {
        const before = Date.now();
        const body = { ...form };
        if (occurred_at !== undefined) body.occurred_at = occurred_at;
        const res = await post(deps, "/propose-form", SHOP_A, body);
        assert.equal(res.status, 201, label);
        const ms = Date.parse(res.json.proposal.occurred_at);
        assert.ok(Number.isFinite(ms), label);
        assert.ok(ms >= before - 1000 && ms <= Date.now() + 1000, `${label}: ${res.json.proposal.occurred_at}`);
      }
    } finally {
      teardown(deps);
    }
  });

  it("confirm keeps occurred_at on the reply while the ledger keeps recorded order and hashes", async () => {
    const deps = setup(async () => PART_PAYMENT);
    try {
      const valid = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const created = await post(deps, "/propose", SHOP_A, { text: "fake note", occurred_at: valid });
      assert.equal(created.status, 201);
      assert.equal(created.json.proposal.occurred_at, valid);

      const out = await post(deps, `/confirm/${created.json.proposal.id}`, SHOP_A, {});
      assert.equal(out.json.alreadyConfirmed, false);
      assert.equal(out.json.proposal.occurred_at, valid);

      const entries = deps.ledger.list(SHOP_A);
      assert.deepEqual(entries.map((e) => e.seq), [1, 2]);
      for (const e of entries) {
        assert.ok(Date.now() - Date.parse(e.created_at) < 60 * 1000);
      }
      assert.equal(deps.ledger.verify(SHOP_A).ok, true);

      const fetched = await dispatch(deps, { url: `/proposals/${created.json.proposal.id}`, shop: SHOP_A });
      assert.equal(fetched.json.proposal.occurred_at, valid);
    } finally {
      teardown(deps);
    }
  });

  it("occurred_at shows on the photo check and the report", async () => {
    const photoDeps = setup(async () => alertReading());
    try {
      const valid = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const created = await post(
        photoDeps, "/photo-checks", SHOP_A,
        { photoBase64: FAKE_PHOTO, photoFormat: "png", occurred_at: valid }
      );
      assert.equal(created.status, 201);
      assert.equal(created.json.proposal.occurred_at, valid);

      const confirmed = await post(photoDeps, `/confirm/${created.json.proposal.id}`, SHOP_A, {});
      assert.equal(confirmed.json.alreadyConfirmed, false);

      const report = await dispatch(photoDeps, { url: "/report", shop: SHOP_A });
      assert.equal(report.status, 200);
      assert.equal(report.json.report.unconfirmed.items.length, 1);
      assert.equal(report.json.report.unconfirmed.items[0].occurredAt, valid);

      const list = await dispatch(photoDeps, { url: "/photo-checks/unconfirmed", shop: SHOP_A });
      assert.equal(list.json.checks[0].occurred_at, valid);
    } finally {
      teardown(photoDeps);
    }
  });
});
