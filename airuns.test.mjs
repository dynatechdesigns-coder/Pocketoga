// Visible model runs (metadata only) + the proposal "ai" block + judge
// boot with only the main key. No network, no real keys — every provider
// call is stubbed and every secret below is fake.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { SecondOpinionStore, runSecondOpinion, fetchSecondReading, SECOND_CHECK_UNAVAILABLE } from "./secondopinion.mjs";
import { createModelClient, createMockModelClient, TEXT_MODEL, AUDIO_MODEL } from "./model.mjs";
import { propose, proposeFromForm, confirmProposal } from "./voice.mjs";
import { proposePhotoCheck, PhotoCheckStore } from "./photos.mjs";
import { setLogSink, startupEnvLines } from "./log.mjs";
import { parseEnvText, loadEnvFile } from "./envfile.mjs";
import { buildDeps } from "./server.mjs";
import { seedDemoShop } from "./demo-seed.mjs";
import { lagosDay } from "./debts.mjs";

const SHOP = "shop-a";
const SECOND_MODEL = "test-second-model";
const SECOND_ENV = { BASETEN_API_KEY: "fake-baseten-key", BASETEN_MODEL: SECOND_MODEL };
const NOTE = "Ada buy rice 2 bags, na 15k.";

const PRIMARY = {
  heard: NOTE,
  entries: [
    { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" },
  ],
  totals: null,
  promise: null,
  question: null,
};

function setup() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    ledger: new Ledger(db),
    proposals: new ProposalStore(db),
    secondOpinions: new SecondOpinionStore(db),
  };
}

function teardown(ctx) {
  ctx.db.close();
}

function capture() {
  const lines = [];
  setLogSink((line) => lines.push(String(line)));
  return { lines, restore: () => setLogSink() };
}

function chatResponse(content, finish = "stop") {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content }, finish_reason: finish }] }),
    text: async () => "",
  };
}

function basetenOk(reading) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(reading) } }] }),
    text: async () => "",
  };
}

function assertClean(joined, secrets) {
  for (const secret of secrets) assert.ok(!joined.includes(secret), `leaked: ${secret}`);
}

describe("model-call log lines (fake data)", () => {
  it("every Meta call logs kind, model, status, ms and rid — never text or keys", async () => {
    const cap = capture();
    try {
      const ok = createModelClient({ apiKey: "META-SECRET-KEY-999", fetchFn: async () => chatResponse(JSON.stringify(PRIMARY)) });
      await ok.complete({ text: NOTE });
      const failing = createModelClient({ apiKey: "META-SECRET-KEY-999", fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }) });
      await assert.rejects(failing.complete({ text: NOTE }), /model API error 500/);
      const timingOut = createModelClient({
        apiKey: "META-SECRET-KEY-999",
        fetchFn: async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; },
      });
      await assert.rejects(timingOut.complete({ text: NOTE }), /model API request failed/);
    } finally {
      cap.restore();
    }
    const calls = cap.lines.filter((l) => l.startsWith("model-call "));
    assert.equal(calls.length, 3, calls.join("\n"));
    const [okLine, failLine, timeoutLine] = calls;
    assert.ok(/^model-call kind=text model=muse-spark-1\.3 status=ok ms=\d+ rid=[0-9a-f]{8}$/.test(okLine), okLine);
    assert.ok(failLine.includes("status=failed") && failLine.includes("rid="), failLine);
    assert.ok(timeoutLine.includes("status=timeout") && timeoutLine.includes("rid="), timeoutLine);
    assertClean(calls.join("\n"), [NOTE, "META-SECRET-KEY-999", "boom"]);
  });

  it("second-opinion ok and skipped lines stay metadata-only", async () => {
    const cap = capture();
    try {
      const out = await fetchSecondReading(NOTE, {
        apiKey: "BASETEN-SECRET-KEY-999",
        model: SECOND_MODEL,
        fetchFn: async () => basetenOk({ entries: [], promise: null }),
      });
      assert.ok(out.reading);
      const quiet = await runSecondOpinion({ heardText: NOTE, entries: [], promise: null, shopId: SHOP, env: {} });
      assert.equal(quiet.agreed, "no_second_opinion");
    } finally {
      cap.restore();
    }
    const calls = cap.lines.filter((l) => l.startsWith("model-call kind=second-opinion"));
    assert.equal(calls.length, 2, calls.join("\n"));
    assert.ok(calls[0].includes(`model=${SECOND_MODEL}`) && calls[0].includes("status=ok"), calls[0]);
    assert.ok(calls[1].includes("status=skipped"), calls[1]);
    assertClean(calls.join("\n"), [NOTE, "BASETEN-SECRET-KEY-999"]);
  });
});

describe("proposal ai block (fake data)", () => {
  function proposeText(ctx, primary, second, opts = {}) {
    return propose(SHOP, NOTE, {
      proposals: ctx.proposals,
      model: createMockModelClient(async () => primary),
      ledger: null,
      secondOpinions: opts.off ? null : ctx.secondOpinions,
      secondOpinionFetch: async () => basetenOk(second),
      secondOpinionEnv: opts.off ? {} : SECOND_ENV,
    });
  }

  it("agreed: models and times recorded, outcome agreed", async () => {
    const ctx = setup();
    try {
      const second = { ...PRIMARY, heard: "worded differently but the same note" };
      const proposal = await proposeText(ctx, PRIMARY, second, {});
      assert.deepEqual(proposal.ai.heard, { model: null, ms: 0 });
      assert.equal(proposal.ai.understood.model, TEXT_MODEL);
      assert.ok(Number.isInteger(proposal.ai.understood.ms) && proposal.ai.understood.ms >= 0);
      assert.equal(proposal.ai.secondOpinion.model, SECOND_MODEL);
      assert.ok(Number.isInteger(proposal.ai.secondOpinion.ms) && proposal.ai.secondOpinion.ms >= 0);
      assert.equal(proposal.ai.secondOpinion.result, "agreed");
    } finally {
      teardown(ctx);
    }
  });

  it("differs: saved only after confirm, then confirms cleanly", async () => {
    const ctx = setup();
    try {
      const second = {
        ...PRIMARY,
        heard: "worded differently but the same customer",
        entries: [
          { type: "sale", customer: "Bola", item: "rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" },
        ],
      };
      const proposal = await proposeText(ctx, PRIMARY, second, {});
      assert.equal(proposal.ai.secondOpinion.result, "differs");
      // Nothing recorded yet: draft only, ledger untouched.
      assert.equal(proposal.recorded_ids, null);
      assert.equal(ctx.ledger.list(SHOP).length, 0);
      const done = confirmProposal(proposal.id, SHOP, { proposals: ctx.proposals, ledger: ctx.ledger });
      assert.equal(done.alreadyConfirmed, false);
      assert.equal(ctx.ledger.list(SHOP).length, 1);
    } finally {
      teardown(ctx);
    }
  });

  it("not ready: failed check degrades softly with the outcome recorded", async () => {
    const ctx = setup();
    try {
      const proposal = await propose(SHOP, NOTE, {
        proposals: ctx.proposals,
        model: createMockModelClient(async () => PRIMARY),
        ledger: null,
        secondOpinions: ctx.secondOpinions,
        secondOpinionFetch: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" }),
        secondOpinionEnv: SECOND_ENV,
      });
      assert.equal(proposal.ai.secondOpinion.result, "not ready");
      assert.equal(proposal.ai.secondOpinion.model, SECOND_MODEL);
      assert.ok(proposal.assumptions.includes(SECOND_CHECK_UNAVAILABLE));
    } finally {
      teardown(ctx);
    }
  });

  it("off: no keys means no check and the off-shape block", async () => {
    const ctx = setup();
    try {
      const proposal = await proposeText(ctx, PRIMARY, PRIMARY, { off: true });
      assert.deepEqual(proposal.ai, {
        heard: { model: null, ms: 0 },
        understood: { model: TEXT_MODEL, ms: proposal.ai.understood.ms },
        secondOpinion: { model: null, ms: 0, result: "off" },
      });
      const form = proposeFromForm(SHOP, { type: "sale", amountNaira: 15000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" }, { proposals: ctx.proposals });
      assert.deepEqual(form.ai, {
        heard: { model: null, ms: 0 },
        understood: { model: null, ms: 0 },
        secondOpinion: { model: null, ms: 0, result: "off" },
      });
    } finally {
      teardown(ctx);
    }
  });

  it("audio: heard and understood name the audio model", async () => {
    const ctx = setup();
    try {
      const audioReading = { ...PRIMARY, heard: "ada buy rice two bags fifteen k" };
      const proposal = await propose(SHOP, { audioBase64: "RkFLRS1BVURJTw==", audioFormat: "wav" }, {
        proposals: ctx.proposals,
        model: createMockModelClient(async () => audioReading),
        ledger: null,
        secondOpinions: null,
        secondOpinionEnv: {},
      });
      assert.equal(proposal.ai.heard.model, AUDIO_MODEL);
      assert.equal(proposal.ai.understood.model, AUDIO_MODEL);
      assert.ok(Number.isInteger(proposal.ai.heard.ms) && proposal.ai.heard.ms >= 0);
      assert.equal(proposal.ai.secondOpinion.result, "off");
    } finally {
      teardown(ctx);
    }
  });

  it("photo: understood names the photo model, no second opinion", async () => {
    const ctx = setup();
    const photoChecks = new PhotoCheckStore(ctx.db);
    try {
      const proposal = await proposePhotoCheck(SHOP, { photoBase64: "RkFLRS1QSE9UTw==", photoFormat: "png" }, {
        proposals: ctx.proposals,
        model: createMockModelClient(async () => ({
          photoType: "payment_alert",
          status: "successful",
          date: lagosDay(Date.now()),
          amountNaira: 12000,
          amountPhrase: "12k",
          sender: "Ada",
          reference: "REF-AI-1",
        })),
        ledger: ctx.ledger,
        photoChecks,
      });
      assert.deepEqual(proposal.ai.heard, { model: null, ms: 0 });
      assert.equal(proposal.ai.understood.model, TEXT_MODEL);
      assert.deepEqual(proposal.ai.secondOpinion, { model: null, ms: 0, result: "off" });
    } finally {
      photoChecks.close();
      teardown(ctx);
    }
  });
});

describe("judge boot with only the main key (fake data)", () => {
  it("buildDeps + demo seed work with no optional settings", () => {
    const deps = buildDeps({ META_API_KEY: "judge-dummy-key", LEDGER_DB: ":memory:" });
    try {
      const seed = seedDemoShop(deps);
      assert.equal(seed.seeded, true);
      assert.equal(seed.entries, 27);
      assert.equal(deps.ledger.list("demo").length, 27);
      assert.deepEqual(deps.ledger.verify("demo"), { ok: true, count: 27, shopId: "demo" });
    } finally {
      deps.db.close();
    }
  });

  it("startup lines show model reads on and everything else off, values never", () => {
    const lines = startupEnvLines({ META_API_KEY: "judge-dummy-key-999" });
    assert.ok(lines.some((l) => l.startsWith("model reads: on")), lines.join("\n"));
    assert.ok(lines.includes("second opinion: off (no BASETEN_API_KEY)"), lines.join("\n"));
    assert.ok(lines.includes("whatsapp: off (no WHATSAPP_ALLOWED_NUMBERS)"), lines.join("\n"));
    assert.ok(lines.includes("feedback forward: off (no FEEDBACK_WEBHOOK_URL)"), lines.join("\n"));
    assert.ok(lines.some((l) => l.startsWith("daily caps: on")), lines.join("\n"));
    assertClean(lines.join("\n"), ["judge-dummy-key-999"]);
  });
});

describe("env file loader (fake data)", () => {
  it("parses names, strips quotes and export, ignores comments and junk", () => {
    const parsed = parseEnvText([
      "# comment",
      "",
      "META_API_KEY=dummy-1",
      "export QUOTED=\"hello world\"",
      "SINGLE='abc'",
      "SPACED = spaced-value ",
      "not-a-line",
      "9BAD=nope",
      "=empty",
    ].join("\n"));
    assert.deepEqual(parsed, {
      META_API_KEY: "dummy-1",
      QUOTED: "hello world",
      SINGLE: "abc",
      SPACED: "spaced-value",
    });
  });

  it("fills only unset vars and tolerates a missing file", () => {
    let dir;
    try {
      dir = mkdtempSync(join(tmpdir(), "pocketoga-env-"));
    } catch {
      dir = mkdtempSync("./.airuns-tmp-");
    }
    try {
      const path = join(dir, ".env.local");
      writeFileSync(path, "META_API_KEY=file-key\nSHARED=file-wins\n");
      const env = { SHARED: "env-wins" };
      const out = loadEnvFile(path, env);
      assert.equal(out.loaded, 1);
      assert.equal(env.META_API_KEY, "file-key");
      assert.equal(env.SHARED, "env-wins");
      assert.deepEqual(loadEnvFile(join(dir, "missing"), {}), { path: join(dir, "missing"), loaded: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
