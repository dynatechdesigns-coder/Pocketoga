// Daily model-credit caps: config, sqlite store, route 429s, ledger and
// manual entry unaffected, request id in failure logs, WhatsApp sentence,
// second-opinion soft skip. Fake data only; the mock model stands in.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { PromiseStore } from "./promises.mjs";
import { ProductStore } from "./products.mjs";
import { SecondOpinionStore } from "./secondopinion.mjs";
import { PhotoCheckStore } from "./photos.mjs";
import { AuthStore, DEMO_SHOP_ID } from "./auth.mjs";
import { createMockModelClient } from "./model.mjs";
import { propose } from "./voice.mjs";
import { buildDeps, handleVoiceRequest, createVoiceServer } from "./server.mjs";
import { WhatsAppStore, drainWhatsAppJobs } from "./whatsapp.mjs";
import { setLogSink, formatRequestLog } from "./log.mjs";
import { lagosDay } from "./debts.mjs";
import {
  ModelCapStore,
  resolveDailyCaps,
  modelCapError,
  isModelCapError,
  withModelCap,
  withFetchCap,
  MODEL_DAILY_CAP_MESSAGE,
  DAILY_CAP_DEFAULTS,
} from "./modelcaps.mjs";

const FAKE_ENV = { LEDGER_DB: ":memory:", META_API_KEY: "fake-test-key" };
const CAPPED_ENV = { ...FAKE_ENV, DAILY_CAP_DEMO: "2", DAILY_CAP_SHOP: "2", DAILY_CAP_SERVICE: "50" };

const SHOP = "shop-cap";
const READING = {
  heard: "Ada don pay 5k for rice",
  entries: [
    { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 5000, amountPhrase: "5k", priceBasis: "total" },
  ],
  totals: null,
  question: null,
};

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

async function post(deps, url, body, { shop = SHOP } = {}) {
  const h = { "x-shop-id": shop };
  if (shop !== DEMO_SHOP_ID) h.authorization = `Bearer ${tokenFor(deps, shop)}`;
  return rawPost(deps, url, body, h);
}

async function rawPost(deps, url, body, headers) {
  const res = fakeRes();
  try {
    await handleVoiceRequest(fakeReq({ method: "POST", url, headers, body }), res, deps);
  } catch (err) {
    return { status: err.status ?? 500, json: { error: err.message ?? "internal error" } };
  }
  return { status: res.statusCode, json: res.text ? JSON.parse(res.text) : null };
}

describe("daily cap config", () => {
  it("defaults to 40 demo, 200 shop, 1500 service", () => {
    assert.deepEqual(resolveDailyCaps({}), DAILY_CAP_DEFAULTS);
    assert.deepEqual(DAILY_CAP_DEFAULTS, { demo: 40, shop: 200, service: 1500 });
  });

  it("reads env overrides and falls back on bad values", () => {
    assert.deepEqual(resolveDailyCaps({ DAILY_CAP_DEMO: "5", DAILY_CAP_SHOP: "10", DAILY_CAP_SERVICE: "20" }), {
      demo: 5,
      shop: 10,
      service: 20,
    });
    assert.deepEqual(resolveDailyCaps({ DAILY_CAP_DEMO: "0", DAILY_CAP_SHOP: "-3", DAILY_CAP_SERVICE: "abc" }), DAILY_CAP_DEFAULTS);
    assert.deepEqual(resolveDailyCaps({ DAILY_CAP_DEMO: "2.5", DAILY_CAP_SHOP: "", DAILY_CAP_SERVICE: null }), DAILY_CAP_DEFAULTS);
  });
});

describe("ModelCapStore", () => {
  it("counts shop and service calls and reports them", () => {
    const store = new ModelCapStore(":memory:");
    try {
      const out = store.charge("s1", { caps: { demo: 40, shop: 2, service: 50 } });
      assert.equal(out.shop, 1);
      assert.equal(out.service, 1);
      assert.equal(typeof out.day, "string");
      assert.deepEqual(store.counts("s1"), { day: out.day, shop: 1, service: 1 });
      assert.deepEqual(store.counts("other"), { day: out.day, shop: 0, service: 1 });
    } finally {
      store.close();
    }
  });

  it("throws 429 with the plain sentence on a spent shop budget, counting nothing", () => {
    const store = new ModelCapStore(":memory:");
    const caps = { demo: 40, shop: 2, service: 50 };
    try {
      store.charge("s1", { caps });
      store.charge("s1", { caps });
      assert.throws(() => store.charge("s1", { caps }), (err) => {
        assert.equal(err.status, 429);
        assert.equal(err.message, MODEL_DAILY_CAP_MESSAGE);
        assert.equal(err.message, "PocketOga has reached today's limit. Please try again tomorrow.");
        assert.ok(isModelCapError(err));
        return true;
      });
      assert.equal(store.counts("s1").shop, 2);
      assert.equal(store.counts("s1").service, 2);
    } finally {
      store.close();
    }
  });

  it("caps the service across shops and demos separately from shops", () => {
    const store = new ModelCapStore(":memory:");
    const caps = { demo: 1000, shop: 1000, service: 2 };
    try {
      store.charge("a", { caps });
      store.charge(DEMO_SHOP_ID, { caps, isDemo: true });
      assert.throws(() => store.charge("b", { caps }), (err) => err.status === 429 && isModelCapError(err));
    } finally {
      store.close();
    }
  });

  it("uses the demo budget for the demo shop only", () => {
    const store = new ModelCapStore(":memory:");
    const caps = { demo: 1, shop: 1000, service: 1000 };
    try {
      store.charge(DEMO_SHOP_ID, { caps, isDemo: true });
      assert.throws(() => store.charge(DEMO_SHOP_ID, { caps, isDemo: true }), isModelCapError);
      store.charge("real", { caps, isDemo: false });
    } finally {
      store.close();
    }
  });

  it("resets counts on the next Lagos day", () => {
    const store = new ModelCapStore(":memory:");
    const caps = { demo: 1, shop: 1000, service: 1000 };
    // 21:00 UTC is 22:00 Lagos; +4h crosses midnight Lagos.
    const t1 = Date.UTC(2026, 9, 26, 21, 0, 0);
    const t2 = t1 + 4 * 3600 * 1000;
    assert.notEqual(lagosDay(t1), lagosDay(t2));
    try {
      store.charge(DEMO_SHOP_ID, { caps, isDemo: true, now: t1 });
      assert.throws(() => store.charge(DEMO_SHOP_ID, { caps, isDemo: true, now: t1 }), isModelCapError);
      const out = store.charge(DEMO_SHOP_ID, { caps, isDemo: true, now: t2 });
      assert.equal(out.shop, 1);
      assert.equal(out.day, lagosDay(t2));
    } finally {
      store.close();
    }
  });

  it("survives a reopen within the same day", () => {
    let dir;
    try {
      dir = mkdtempSync(join(tmpdir(), "pocketoga-cap-test-"));
    } catch {
      dir = mkdtempSync("./.cap-test-tmp-");
    }
    const path = join(dir, "caps.db");
    const first = new ModelCapStore(path);
    const caps = { demo: 40, shop: 1, service: 50 };
    try {
      first.charge("s1", { caps });
    } finally {
      first.close();
    }
    const second = new ModelCapStore(path);
    try {
      assert.throws(() => second.charge("s1", { caps }), isModelCapError);
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("capped wrappers", () => {
  it("charges once per model call and propagates a spent cap", async () => {
    let charges = 0;
    let calls = 0;
    const model = withModelCap(createMockModelClient(async () => { calls++; return { heard: "x" }; }), async () => { charges++; });
    const out = await model.complete({ text: "hi" });
    assert.deepEqual(out, { heard: "x" });
    assert.equal(charges, 1);
    assert.equal(calls, 1);
    const capped = withModelCap(createMockModelClient(async () => { calls++; return {}; }), async () => { throw modelCapError(); });
    await assert.rejects(() => capped.complete({ text: "hi" }), (err) => err.status === 429 && isModelCapError(err));
    assert.equal(calls, 1);
  });

  it("passes models and fetches through untouched without a charge", async () => {
    const model = createMockModelClient(async () => ({ heard: "x" }));
    assert.equal(withModelCap(model), model);
    assert.equal(withModelCap(null, async () => {}), null);
    assert.equal(withFetchCap(undefined), fetch);
    let fetched = 0;
    const wrapped = withFetchCap(async () => { fetched++; return { ok: true }; }, async () => {});
    assert.equal((await wrapped("https://x", {})).ok, true);
    assert.equal(fetched, 1);
  });
});

describe("POST /propose under daily caps (mock model)", () => {
  function routeSetup(modelHandler, env = CAPPED_ENV) {
    const deps = buildDeps(env);
    let calls = 0;
    deps.model = createMockModelClient(async (req) => { calls++; return modelHandler(req); });
    return { deps, calls: () => calls };
  }

  it("returns 429 with the plain sentence when the cap is spent, without calling the model", async () => {
    let modelCalls = 0;
    const deps = buildDeps(CAPPED_ENV);
    deps.model = createMockModelClient(async () => { modelCalls++; return READING; });
    try {
      deps.modelCaps.charge(SHOP, { caps: deps.dailyCaps, isDemo: false });
      deps.modelCaps.charge(SHOP, { caps: deps.dailyCaps, isDemo: false });
      const res = await post(deps, "/propose", { text: "Ada don pay 5k" });
      assert.equal(res.status, 429);
      assert.deepEqual(res.json, { error: "PocketOga has reached today's limit. Please try again tomorrow." });
      assert.equal(modelCalls, 0);
    } finally {
      deps.db.close();
    }
  });

  it("counts each accepted propose and caps the third", async () => {
    const { deps } = routeSetup(async () => READING);
    try {
      for (const shop of ["cap-a", "cap-b"]) {
        const first = await post(deps, "/propose", { text: "Ada don pay 5k" }, { shop });
        assert.equal(first.status, 201);
      }
      // cap-a already spent one of its two; spend the second, then capped.
      const second = await post(deps, "/propose", { text: "Ada don pay 5k" }, { shop: "cap-a" });
      assert.equal(second.status, 201);
      const third = await post(deps, "/propose", { text: "Ada don pay 5k" }, { shop: "cap-a" });
      assert.equal(third.status, 429);
      assert.deepEqual(third.json, { error: MODEL_DAILY_CAP_MESSAGE });
    } finally {
      deps.db.close();
    }
  });

  it("caps the demo shop separately from real shops", async () => {
    const { deps } = routeSetup(async () => READING);
    try {
      const demoHeaders = () => ({ "x-shop-id": DEMO_SHOP_ID });
      assert.equal((await rawPost(deps, "/propose", { text: "hi" }, demoHeaders())).status, 201);
      assert.equal((await rawPost(deps, "/propose", { text: "hi" }, demoHeaders())).status, 201);
      const demoThird = await rawPost(deps, "/propose", { text: "hi" }, demoHeaders());
      assert.equal(demoThird.status, 429);
      assert.deepEqual(demoThird.json, { error: MODEL_DAILY_CAP_MESSAGE });
      const real = await post(deps, "/propose", { text: "Ada don pay 5k" }, { shop: "cap-real" });
      assert.equal(real.status, 201);
    } finally {
      deps.db.close();
    }
  });

  it("leaves manual entry, forms and ledger reads alone at a spent cap", async () => {
    const { deps } = routeSetup(async () => READING);
    try {
      const shop = "cap-manual";
      const token = tokenFor(deps, shop);
      deps.modelCaps.charge(shop, { caps: deps.dailyCaps, isDemo: false });
      deps.modelCaps.charge(shop, { caps: deps.dailyCaps, isDemo: false });
      const manual = await post(
        deps,
        "/proposals/manual",
        { kind: "sale", customer: "Ada", item: "rice", quantity: 1, amount_naira: "2500.50" },
        { shop }
      );
      assert.equal(manual.status, 201);
      const form = await post(
        deps,
        "/propose-form",
        { type: "sale", amountNaira: 5000, customer: "Ada", item: "rice" },
        { shop }
      );
      assert.equal(form.status, 201);
      const res = fakeRes();
      await handleVoiceRequest(
        fakeReq({ method: "GET", url: "/ledger", headers: { "x-shop-id": shop, authorization: `Bearer ${token}` } }),
        res,
        deps
      );
      assert.equal(res.statusCode, 200);
    } finally {
      deps.db.close();
    }
  });
});

describe("request id in failure logs", () => {
  it("adds rid to the failure line only, scrubbed, never the note", () => {
    const line = formatRequestLog({ method: "POST", path: "/propose", status: 400, ms: 3, shop: "wa-abcdef", rid: "req-abc-123", error: new Error("bad hint") });
    assert.ok(line.includes("rid=req-abc-123"), line);
    const ok = formatRequestLog({ method: "GET", path: "/health", status: 200, ms: 1, shop: null });
    assert.ok(!ok.includes("rid="), ok);
    const masked = formatRequestLog({ method: "POST", path: "/x", status: 400, ms: 1, shop: null, rid: "call-08031234567", error: new Error("bad") });
    assert.ok(!masked.includes("08031234567"), masked);
  });
});

describe("WhatsApp daily cap (mocked fetch, no network)", () => {
  const WA_ENV = {
    WHATSAPP_TOKEN: "test-token-abcdef123456",
    WHATSAPP_PHONE_NUMBER_ID: "15550001111",
    WHATSAPP_APP_SECRET: "test-app-secret-xyz",
    WHATSAPP_VERIFY_TOKEN: "test-verify-token",
    WHATSAPP_ALLOWED_NUMBERS: "2348012345678",
  };
  const FROM = "2348012345678";
  let nextMsg = 1;

  function waSetup() {
    const db = new DatabaseSync(":memory:");
    const model = createMockModelClient(async () => READING);
    const calls = [];
    const fetch = async (url, opts = {}) => {
      calls.push({ url, opts });
      if (url.endsWith("/messages")) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    mkdirSync("test-wa-cap-tmp", { recursive: true });
    const deps = {
      ledger: new Ledger(db),
      proposals: new ProposalStore(db),
      promises: new PromiseStore(db),
      products: new ProductStore(db),
      secondOpinions: new SecondOpinionStore(db),
      auths: new AuthStore(db),
      model,
      whatsapp: new WhatsAppStore(db),
      fetch,
      log: () => {},
      waTmpDir: "test-wa-cap-tmp",
      env: { ...WA_ENV, DAILY_CAP_SHOP: "1" },
      nowMs: null,
    };
    deps.modelCaps = new ModelCapStore(db);
    deps.dailyCaps = resolveDailyCaps(deps.env);
    return { db, deps, calls };
  }

  async function postNote(ctx, text) {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: "e1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [{ from: FROM, id: `wamid-cap-${nextMsg++}`, type: "text", text: { body: text } }] } }] }],
    };
    const raw = JSON.stringify(payload);
    const req = new EventEmitter();
    req.method = "POST";
    req.url = "/webhook";
    req.headers = { "x-hub-signature-256": `sha256=${createHmac("sha256", WA_ENV.WHATSAPP_APP_SECRET).update(raw).digest("hex")}` };
    req.destroy = () => {};
    const res = fakeRes();
    process.nextTick(() => {
      req.emit("data", Buffer.from(raw));
      req.emit("end");
    });
    await handleVoiceRequest(req, res, ctx.deps);
    await drainWhatsAppJobs();
    return res;
  }

  function sentTexts(ctx) {
    return ctx.calls
      .filter((c) => c.url.endsWith("/messages"))
      .map((c) => JSON.parse(c.opts.body));
  }

  it("sends the plain cap sentence on WhatsApp when the budget is spent", async () => {
    const ctx = waSetup();
    try {
      await postNote(ctx, "Ada don pay 5k");
      const first = sentTexts(ctx);
      assert.equal(first.length, 1);
      assert.notEqual(first[0].text?.body, MODEL_DAILY_CAP_MESSAGE);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS c FROM proposals").get().c, 1);
      await postNote(ctx, "Ada don pay 5k");
      const all = sentTexts(ctx);
      assert.equal(all.length, 2);
      assert.equal(all[1].text?.body, MODEL_DAILY_CAP_MESSAGE);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS c FROM proposals").get().c, 1);
    } finally {
      await drainWhatsAppJobs();
      ctx.db.close();
      rmSync("test-wa-cap-tmp", { recursive: true, force: true });
    }
  });

  it("skips the second opinion quietly when its call is capped", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const proposals = new ProposalStore(db);
      const ledger = new Ledger(db);
      const products = new ProductStore(db);
      const secondOpinions = new SecondOpinionStore(db);
      const model = createMockModelClient(async () => READING);
      const proposal = await propose("shop-x", "Ada don pay 5k", {
        proposals,
        model,
        ledger,
        products,
        secondOpinions,
        secondOpinionFetch: async () => {
          throw modelCapError();
        },
        secondOpinionEnv: { BASETEN_API_KEY: "k", BASETEN_MODEL: "m" },
      });
      assert.ok(proposal.id);
      const rows = secondOpinions.listByProposal(proposal.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].agreed, "no_second_opinion");
    } finally {
      db.close();
    }
  });
});

describe("request id on the failure line (integration)", () => {
  it("logs rid on a failed request through the server, without the body", async () => {
    const deps = buildDeps(FAKE_ENV);
    const lines = [];
    setLogSink((line) => lines.push(String(line)));
    try {
      const requestId = "test-req-7";
      const res = await rawPost(
        deps,
        "/propose",
        { text: "secret note body", hint: "bogus-hint-zzz" },
        { "x-shop-id": SHOP, "x-request-id": requestId, authorization: `Bearer ${tokenFor(deps, SHOP)}` }
      );
      assert.equal(res.status, 400);
      await new Promise((done) => {
        const server = createVoiceServer(deps);
        const req = new EventEmitter();
        req.method = "POST";
        req.url = "/propose";
        req.headers = { "x-shop-id": SHOP, "x-request-id": requestId, authorization: `Bearer ${tokenFor(deps, SHOP)}` };
        req.destroy = () => {};
        const emitRes = new EventEmitter();
        emitRes.headersSent = false;
        emitRes.writeHead = () => {
          emitRes.headersSent = true;
        };
        emitRes.end = () => done();
        server.emit("request", req, emitRes);
        process.nextTick(() => {
          req.emit("data", Buffer.from(JSON.stringify({ text: "secret note body", hint: "bogus-hint-zzz" })));
          req.emit("end");
        });
      });
      const combined = lines.join("\n");
      assert.ok(combined.includes(`rid=${requestId}`), combined);
      assert.ok(!combined.includes("secret note body"), combined);
    } finally {
      setLogSink();
      deps.db.close();
    }
  });
});
