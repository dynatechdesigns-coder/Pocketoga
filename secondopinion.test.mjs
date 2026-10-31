// Second-opinion check: a Baseten-hosted text model re-reads the note and
// plain code compares the two readings. The second model never changes an
// entry; any failure degrades to "no second opinion". Fake data only, and
// the Baseten call is always mocked — no network in tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ProposalStore } from "./proposals.mjs";
import { Ledger } from "./ledger.mjs";
import { CustomerStore } from "./customers.mjs";
import { propose } from "./voice.mjs";
import { createMockModelClient } from "./model.mjs";
import { renderProposalCard } from "./messages.mjs";
import {
  BASETEN_BASE_URL,
  SECOND_OPINION_TIMEOUT_MS,
  SECOND_OPINION_MAX_TOKENS,
  SECOND_OPINION_SYSTEM_PROMPT,
  SECOND_CHECK_UNAVAILABLE,
  SECOND_CHECK_CREDIT,
  NORMALISED_AMOUNT,
  SecondOpinionStore,
  runSecondOpinion,
  fetchSecondReading,
} from "./secondopinion.mjs";

const SHOP = "shop-a";
const FAKE_ENV = { BASETEN_API_KEY: "fake-baseten-key", BASETEN_MODEL: "fake-model-slug" };
// Wednesday 28 Oct 2026 in Lagos: "Friday" resolves to 30 Oct.
const NOW = Date.parse("2026-10-28T10:00:00+01:00");

// Clean primary reading: 30k sale, 10k paid, 20k remainder stated and exact.
const PRIMARY = {
  heard: "Ada buy rice 2 bags, na 30k. She pay 10k, remain 20k.",
  entries: [
    { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 30000, amountPhrase: "30k", priceBasis: "total" },
    { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
  ],
  totals: { totalNaira: 30000, totalPhrase: "30k", paidNaira: 10000, paidPhrase: "10k", remainderNaira: 20000, remainderPhrase: "remain 20k" },
  promise: null,
  question: null,
};

const EXPECTED_ENTRIES = [
  { type: "sale", customer: "Ada", item: "rice", quantity: 2, unit: "bag", priceBasis: "total", amountNaira: 30000, amountKobo: 3000000, amountPhrase: "30k", eachNaira: null, eachKobo: null, amountOptions: null },
  { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, priceBasis: "total", amountNaira: 10000, amountKobo: 1000000, amountPhrase: "10k", eachNaira: null, eachKobo: null, amountOptions: null },
];

function setup() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    ledger: new Ledger(db),
    proposals: new ProposalStore(db),
    customers: new CustomerStore(db),
    secondOpinions: new SecondOpinionStore(db),
  };
}

function teardown(ctx) {
  ctx.db.close();
}

// Canned Baseten chat-completion response carrying one structured reading.
function basetenOk(reading) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(reading) } }] }),
    text: async () => "",
  };
}

function captureFetch(reading) {
  const seen = [];
  const fetchFn = async (url, opts) => {
    seen.push({ url, opts });
    return basetenOk(reading);
  };
  return { seen, fetchFn };
}

async function proposeWithSecond(ctx, primaryReading, secondReading, opts = {}) {
  const { seen, fetchFn } = captureFetch(secondReading);
  const proposal = await propose(SHOP, opts.input ?? "fake note text", {
    proposals: ctx.proposals,
    model: createMockModelClient(async () => primaryReading),
    ledger: opts.ledger ?? null,
    now: NOW,
    secondOpinions: ctx.secondOpinions,
    secondOpinionFetch: opts.fetchFn ?? fetchFn,
    secondOpinionEnv: opts.env ?? FAKE_ENV,
    secondOpinionMode: opts.secondOpinionMode ?? "always",
    ...(opts.timeoutMs !== undefined ? { secondOpinionTimeoutMs: opts.timeoutMs } : {}),
  });
  return { proposal, seen };
}

function statsRow(ctx, proposalId) {
  const rows = ctx.secondOpinions.listByProposal(proposalId);
  assert.equal(rows.length, 1);
  return rows[0];
}

describe("second-opinion agreement", () => {
  it("an agreeing second reading stays silent and records yes", async () => {
    const ctx = setup();
    try {
      const second = {
        heard: "worded differently but the same note",
        entries: JSON.parse(JSON.stringify(PRIMARY.entries)),
        totals: JSON.parse(JSON.stringify(PRIMARY.totals)),
        promise: null,
        question: "the second model's own question must never leak in",
      };
      const { proposal } = await proposeWithSecond(ctx, PRIMARY, second);
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      assert.deepEqual(proposal.entries, EXPECTED_ENTRIES);
      const row = statsRow(ctx, proposal.id);
      assert.equal(row.agreed, "yes");
      assert.deepEqual(JSON.parse(row.differing_fields), []);
      assert.ok(Number.isInteger(row.latency_ms) && row.latency_ms >= 0);
    } finally {
      teardown(ctx);
    }
  });

  it("casing and wording differences are ignored", async () => {
    const ctx = setup();
    try {
      const second = {
        heard: "ADA buy RICE 2 BAGS na 30k she pay 10k remain 20k",
        entries: [
          { type: "sale", customer: "  ada ", item: "RICE", unit: "Bag", quantity: 2, amountNaira: 30000, amountPhrase: "30k", priceBasis: "total" },
          { type: "payment", customer: "ADA", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
        ],
        totals: null,
        promise: null,
        question: null,
      };
      const { proposal } = await proposeWithSecond(ctx, PRIMARY, second);
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      assert.equal(statsRow(ctx, proposal.id).agreed, "yes");
    } finally {
      teardown(ctx);
    }
  });

  it("the same promise in different words stays silent", async () => {
    const ctx = setup();
    try {
      const withPromise = { ...PRIMARY, promise: { customer: "Ada", datePhrase: "Friday", amountNaira: 20000 } };
      const second = { ...withPromise, heard: "ada go pay 20k friday", promise: { customer: "ada", datePhrase: "friday", amountNaira: 20000 } };
      const { proposal } = await proposeWithSecond(ctx, withPromise, second);
      assert.deepEqual(proposal.flags, []);
      assert.equal(statsRow(ctx, proposal.id).agreed, "yes");
    } finally {
      teardown(ctx);
    }
  });

  it("a reading wrapped in reasoning channels still parses", async () => {
    const ctx = setup();
    try {
      const wrapped = `<think>checking the amounts</think>${JSON.stringify(PRIMARY)}`;
      const { proposal } = await proposeWithSecond(ctx, PRIMARY, PRIMARY, {
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: wrapped }, finish_reason: "stop" }] }),
          text: async () => "",
        }),
      });
      assert.deepEqual(proposal.flags, []);
      assert.equal(statsRow(ctx, proposal.id).agreed, "yes");
    } finally {
      teardown(ctx);
    }
  });
});

describe("second-opinion disagreement", () => {
  it("an amount disagreement flags with one code-built line, shown once, no Save", async () => {
    const ctx = setup();
    try {
      const second = {
        heard: PRIMARY.heard,
        entries: [
          { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 25000, amountPhrase: "25k", priceBasis: "total" },
          { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
        ],
        totals: null,
        promise: null,
        question: null,
      };
      const { proposal } = await proposeWithSecond(ctx, PRIMARY, second);
      const line = "Two readings differ: amount is ₦30,000 in one and ₦25,000 in the other. Which one na correct?";
      assert.deepEqual(proposal.flags, [line]);
      assert.equal(proposal.question, line);
      assert.ok(proposal.assumptions.includes(SECOND_CHECK_CREDIT), proposal.assumptions.join("; "));
      // The second model cannot change an entry.
      assert.deepEqual(proposal.entries, EXPECTED_ENTRIES);

      const card = renderProposalCard(proposal, { existing: [], shopId: SHOP });
      assert.equal(card.text.split(line).length - 1, 1);
      assert.deepEqual(
        card.buttons.map((b) => b.reply.id),
        [`fix:${proposal.id}`, `reject:${proposal.id}`]
      );

      const row = statsRow(ctx, proposal.id);
      assert.equal(row.agreed, "no");
      assert.deepEqual(JSON.parse(row.differing_fields), ["amount"]);
    } finally {
      teardown(ctx);
    }
  });

  it("a customer disagreement is a soft line and keeps the primary name", async () => {
    const ctx = setup();
    try {
      const second = {
        heard: PRIMARY.heard,
        entries: [
          { type: "sale", customer: "Adaboy", item: "rice", unit: "bag", quantity: 2, amountNaira: 30000, amountPhrase: "30k", priceBasis: "total" },
          { type: "payment", customer: "Adaboy", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
        ],
        totals: null,
        promise: null,
        question: null,
      };
      const { proposal } = await proposeWithSecond(ctx, PRIMARY, second);
      const line = "Two readings differ: customer is Ada in one and Adaboy in the other. Which one na correct?";
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      assert.ok(proposal.assumptions.includes(line), proposal.assumptions.join("; "));
      assert.ok(proposal.assumptions.includes(SECOND_CHECK_CREDIT));
      assert.ok(proposal.entries.every((e) => e.customer === "Ada"));
      const card = renderProposalCard(proposal, { existing: [], shopId: SHOP });
      assert.equal(card.text.split(line).length - 1, 1);
      assert.ok(card.buttons.some((b) => b.reply.title === "Save"), "Save stays enabled");
      const row = statsRow(ctx, proposal.id);
      assert.equal(row.agreed, "no");
      assert.deepEqual(JSON.parse(row.differing_fields), ["customer"]);
    } finally {
      teardown(ctx);
    }
  });

  it("an entry-count mismatch is a soft line", async () => {
    const ctx = setup();
    try {
      const second = { heard: PRIMARY.heard, entries: [PRIMARY.entries[0]], totals: null, promise: null, question: null };
      const { proposal } = await proposeWithSecond(ctx, PRIMARY, second);
      const line = "Two readings differ: one heard 2 entries and the other heard 1 entry. Which one na correct?";
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      assert.ok(proposal.assumptions.includes(line), proposal.assumptions.join("; "));
      const card = renderProposalCard(proposal, { existing: [], shopId: SHOP });
      assert.ok(card.buttons.some((b) => b.reply.title === "Save"), "Save stays enabled");
      assert.deepEqual(JSON.parse(statsRow(ctx, proposal.id).differing_fields), ["entries"]);
    } finally {
      teardown(ctx);
    }
  });

  it("a promise-date disagreement is a soft line", async () => {
    const ctx = setup();
    try {
      const withPromise = { ...PRIMARY, promise: { customer: "Ada", datePhrase: "Friday", amountNaira: 20000 } };
      const second = { ...withPromise, promise: { customer: "Ada", datePhrase: "Saturday", amountNaira: 20000 } };
      const { proposal } = await proposeWithSecond(ctx, withPromise, second);
      const line = "Two readings differ: promise day is Friday in one and Saturday in the other. Which one na correct?";
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      assert.ok(proposal.assumptions.includes(line), proposal.assumptions.join("; "));
      const card = renderProposalCard(proposal, { existing: [], shopId: SHOP });
      assert.ok(card.buttons.some((b) => b.reply.title === "Save"), "Save stays enabled");
      assert.deepEqual(JSON.parse(statsRow(ctx, proposal.id).differing_fields), ["promise.date"]);
    } finally {
      teardown(ctx);
    }
  });

  it("an amount disagreement merges with a code question instead of adding a second", async () => {
    const ctx = setup();
    try {
      const primary = { ...PRIMARY, question: "How much remain?" };
      const second = {
        heard: PRIMARY.heard,
        entries: [
          { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 25000, amountPhrase: "25k", priceBasis: "total" },
          { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
        ],
        totals: null,
        promise: null,
        question: null,
      };
      const { proposal } = await proposeWithSecond(ctx, primary, second);
      const merged = "How much remain? Two readings differ: amount is ₦30,000 in one and ₦25,000 in the other. Which one na correct?";
      assert.deepEqual(proposal.flags, [merged]);
      assert.equal(proposal.question, merged);
      const card = renderProposalCard(proposal, { existing: [], shopId: SHOP });
      assert.equal(card.text.split(merged).length - 1, 1);
      assert.ok(card.buttons.every((b) => !b.reply.id.startsWith("confirm:")), "amount disagreement asks");
      assert.deepEqual(JSON.parse(statsRow(ctx, proposal.id).differing_fields), ["amount"]);
    } finally {
      teardown(ctx);
    }
  });
});

describe("second-opinion crossed-basis normalisation", () => {
  it("total versus unit agree: same figure, crossed basis, Save enabled", async () => {
    const ctx = setup();
    try {
      const primary = {
        heard: "Ada buy rice 2 bags, 15k each. She pay 10k, remain 20k.",
        entries: [
          { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "each" },
          { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
        ],
        totals: null,
        promise: null,
        question: null,
      };
      const second = {
        entries: [
          { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" },
          { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
        ],
        totals: null,
        promise: null,
        question: null,
      };
      const { proposal } = await proposeWithSecond(ctx, primary, second);
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      assert.ok(!proposal.assumptions.some((a) => /Two readings differ/.test(a)), proposal.assumptions.join("; "));
      const card = renderProposalCard(proposal, { existing: [], shopId: SHOP });
      assert.ok(!card.text.includes("Two readings differ"), card.text);
      assert.ok(card.buttons.some((b) => b.reply.title === "Save"), "Save stays enabled");
      const row = statsRow(ctx, proposal.id);
      assert.equal(row.agreed, "yes");
      assert.deepEqual(JSON.parse(row.differing_fields), [NORMALISED_AMOUNT]);
    } finally {
      teardown(ctx);
    }
  });

  it("a real crossed-basis total difference flags once and merges", async () => {
    const ctx = setup();
    try {
      const primary = {
        heard: "Ada buy rice 2 bags, 15k each. She pay 10k, remain 20k.",
        entries: [
          { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "each" },
          { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
        ],
        totals: null,
        promise: null,
        question: "How much remain?",
      };
      const second = {
        entries: [
          { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 25000, amountPhrase: "25k", priceBasis: "total" },
          { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
        ],
        totals: null,
        promise: null,
        question: null,
      };
      const { proposal } = await proposeWithSecond(ctx, primary, second);
      const merged = "How much remain? Two readings differ: amount is ₦30,000 in one and ₦25,000 in the other. Which one na correct?";
      assert.deepEqual(proposal.flags, [merged]);
      assert.equal(proposal.question, merged);
      const card = renderProposalCard(proposal, { existing: [], shopId: SHOP });
      assert.equal(card.text.split(merged).length - 1, 1);
      assert.ok(card.buttons.every((b) => !b.reply.id.startsWith("confirm:")), "amount disagreement asks");
      const row = statsRow(ctx, proposal.id);
      assert.equal(row.agreed, "no");
      assert.deepEqual(JSON.parse(row.differing_fields), ["amount", "priceBasis"]);
    } finally {
      teardown(ctx);
    }
  });
});

describe("second-opinion failures never block", () => {
  it("a rejected call still proposes cleanly and records no_second_opinion", async () => {
    const ctx = setup();
    try {
      const { proposal } = await proposeWithSecond(ctx, PRIMARY, PRIMARY, {
        fetchFn: async () => {
          throw new Error("baseten is down");
        },
      });
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      assert.deepEqual(proposal.entries, EXPECTED_ENTRIES);
      assert.ok(proposal.assumptions.includes(SECOND_CHECK_UNAVAILABLE), proposal.assumptions.join("; "));
      const row = statsRow(ctx, proposal.id);
      assert.equal(row.agreed, "no_second_opinion");
      assert.deepEqual(JSON.parse(row.differing_fields), []);
      const card = renderProposalCard(proposal, { existing: [], shopId: SHOP });
      assert.ok(card.buttons.some((b) => b.reply.title === "Save"), "Save stays enabled when second check fails");
    } finally {
      teardown(ctx);
    }
  });

  it("a timeout still proposes cleanly", async () => {
    const ctx = setup();
    try {
      const hanging = (url, opts) =>
        new Promise((_, reject) => {
          opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      const { proposal } = await proposeWithSecond(ctx, PRIMARY, PRIMARY, { fetchFn: hanging, timeoutMs: 20 });
      assert.deepEqual(proposal.flags, []);
      assert.ok(proposal.assumptions.includes(SECOND_CHECK_UNAVAILABLE));
      assert.equal(statsRow(ctx, proposal.id).agreed, "no_second_opinion");
    } finally {
      teardown(ctx);
    }
  });

  it("the timing log separates timeout from error responses", async () => {
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    const prev = process.env.POCKETOGA_TIMING;
    process.env.POCKETOGA_TIMING = "1";
    try {
      const timeoutFetch = (url, opts) =>
        new Promise((_, reject) => {
          opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
        });
      const timedOut = await fetchSecondReading("fake note", { apiKey: "k", model: "m", fetchFn: timeoutFetch, timeoutMs: 20 });
      assert.equal(timedOut.reading, null);
      assert.equal(timedOut.failure, "timeout");
      const errorFetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" });
      const errored = await fetchSecondReading("fake note", { apiKey: "k", model: "m", fetchFn: errorFetch, timeoutMs: 1000 });
      assert.equal(errored.reading, null);
      assert.equal(errored.failure, "error");
    } finally {
      console.log = origLog;
      if (prev === undefined) delete process.env.POCKETOGA_TIMING;
      else process.env.POCKETOGA_TIMING = prev;
    }
    const fails = lines.filter((l) => l.startsWith("secondopinion ")).map((l) => /fail=(\S+)/.exec(l)?.[1]);
    assert.deepEqual(fails, ["timeout", "error"]);
  });

  it("a non-JSON or error response still proposes cleanly", async () => {
    const ctx = setup();
    try {
      const badJson = await proposeWithSecond(ctx, PRIMARY, PRIMARY, {
        fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "not json{{{ " } }] }), text: async () => "" }),
      });
      assert.deepEqual(badJson.proposal.flags, []);
      assert.ok(badJson.proposal.assumptions.includes(SECOND_CHECK_UNAVAILABLE));
      assert.equal(statsRow(ctx, badJson.proposal.id).agreed, "no_second_opinion");

      const serverError = await proposeWithSecond(ctx, PRIMARY, PRIMARY, {
        fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }),
      });
      assert.deepEqual(serverError.proposal.flags, []);
      assert.ok(serverError.proposal.assumptions.includes(SECOND_CHECK_UNAVAILABLE));
      assert.equal(statsRow(ctx, serverError.proposal.id).agreed, "no_second_opinion");
      assert.equal(statsRow(ctx, serverError.proposal.id).outcome, "error");
    } finally {
      teardown(ctx);
    }
  });

  it("missing env vars skip without calling", async () => {
    const ctx = setup();
    try {
      for (const env of [{}, { BASETEN_API_KEY: "k" }, { BASETEN_MODEL: "m" }]) {
        let calls = 0;
        const { proposal } = await proposeWithSecond(ctx, PRIMARY, PRIMARY, {
          env,
          fetchFn: async () => {
            calls++;
            throw new Error("must not be called");
          },
        });
        assert.equal(calls, 0, JSON.stringify(env));
        assert.deepEqual(proposal.flags, []);
        assert.ok(!proposal.assumptions.includes(SECOND_CHECK_UNAVAILABLE), "silent without keys");
        const row = statsRow(ctx, proposal.id);
        assert.equal(row.agreed, "no_second_opinion");
        assert.equal(row.latency_ms, 0);
      }
    } finally {
      teardown(ctx);
    }
  });

  it("callers without the store never call out, even with keys set", async () => {
    const ctx = setup();
    try {
      let calls = 0;
      const proposal = await propose(SHOP, "fake note text", {
        proposals: ctx.proposals,
        model: createMockModelClient(async () => PRIMARY),
        now: NOW,
        secondOpinionFetch: async () => {
          calls++;
          throw new Error("must not be called");
        },
        secondOpinionEnv: FAKE_ENV,
      });
      assert.equal(calls, 0);
      assert.deepEqual(proposal.flags, []);
      assert.deepEqual(ctx.secondOpinions.listByProposal(proposal.id), []);
    } finally {
      teardown(ctx);
    }
  });
});

describe("second-opinion request privacy", () => {
  it("sends only the note text with the minimal prompt, never audio, phones or ledger data", async () => {
    const ctx = setup();
    try {
      // Ledger and directory hold data the note never mentions.
      ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: 999900, customer: "Zed", item: "beans", quantity: 1, unit: "tin" });
      ctx.customers.upsert({ shopId: SHOP, name: "Zed", phone: "08055556666", consent: true });
      const { seen } = await proposeWithSecond(ctx, PRIMARY, PRIMARY, {
        input: { audioBase64: "ZmFrZS1hdWRpby1ieXRlcw==", audioFormat: "wav" },
        ledger: ctx.ledger,
      });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, `${BASETEN_BASE_URL}/chat/completions`);
      assert.equal(seen[0].opts.method, "POST");
      assert.equal(seen[0].opts.headers.Authorization, "Bearer fake-baseten-key");
      assert.deepEqual(JSON.parse(seen[0].opts.body), {
        model: "fake-model-slug",
        reasoning_effort: "minimal",
        temperature: 0,
        seed: 7,
        max_tokens: SECOND_OPINION_MAX_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SECOND_OPINION_SYSTEM_PROMPT },
          { role: "user", content: PRIMARY.heard },
        ],
      });
      const bodyText = String(seen[0].opts.body);
      for (const leak of ["ZmFrZS1hdWRpby1ieXRlcw==", "input_audio", "image", "08055556666", "2348055556666", "Zed", "beans", "999900"]) {
        assert.ok(!bodyText.includes(leak), `request body leaks ${leak}`);
      }
    } finally {
      teardown(ctx);
    }
  });

  it("stats rows never store the note text", async () => {
    const ctx = setup();
    try {
      const { proposal } = await proposeWithSecond(ctx, PRIMARY, PRIMARY);
      const dump = JSON.stringify(statsRow(ctx, proposal.id));
      assert.ok(!dump.includes(PRIMARY.heard), dump);
    } finally {
      teardown(ctx);
    }
  });
});

describe("second-opinion plumbing", () => {
  it("the default timeout is 4 seconds with room for a short thought plus JSON", () => {
    assert.equal(SECOND_OPINION_TIMEOUT_MS, 4000);
    assert.equal(SECOND_OPINION_MAX_TOKENS, 1000);
    assert.equal(BASETEN_BASE_URL, "https://inference.baseten.co/v1");
    assert.ok(SECOND_OPINION_SYSTEM_PROMPT.length < 800, `prompt too long: ${SECOND_OPINION_SYSTEM_PROMPT.length}`);
    assert.ok(!SECOND_OPINION_SYSTEM_PROMPT.includes("totals"), "minimal prompt has no totals");
  });

  it("runSecondOpinion compares without stores or network", async () => {
    const { seen, fetchFn } = captureFetch(PRIMARY);
    const out = await runSecondOpinion({
      heardText: PRIMARY.heard,
      entries: EXPECTED_ENTRIES,
      promise: null,
      shopId: SHOP,
      now: NOW,
      fetchFn,
      env: FAKE_ENV,
    });
    assert.deepEqual(out, { agreed: "yes", differingFields: [], latencyMs: out.latencyMs, line: null, shownField: null });
    assert.ok(Number.isInteger(out.latencyMs) && out.latencyMs >= 0);
    assert.equal(seen.length, 1);
  });

  it("the store validates its rows", () => {
    const ctx = setup();
    try {
      assert.throws(() => ctx.secondOpinions.record({ proposalId: 1, agreed: "maybe", differingFields: [], latencyMs: 3 }), /agreed/);
      assert.throws(() => ctx.secondOpinions.record({ proposalId: 1, agreed: "yes", differingFields: [], latencyMs: -1 }), /latency/);
      const proposal = ctx.proposals.create({
        shopId: SHOP,
        envelope: { version: 1, entries: [], totals: null, flags: [], notes: [] },
        heard: "fake note",
      });
      const row = ctx.secondOpinions.record({ proposalId: proposal.id, agreed: "no", differingFields: ["amount"], latencyMs: 12 });
      assert.equal(row.proposal_id, proposal.id);
      assert.deepEqual(JSON.parse(row.differing_fields), ["amount"]);
    } finally {
      teardown(ctx);
    }
  });
});

describe("second-opinion expense comparison", () => {
  const EXPENSE_PRIMARY = {
    heard: "Paid NEPA 5k for power.",
    entries: [
      { type: "expense", customer: "NEPA", item: "power", quantity: null, unit: null, amountNaira: 5000, amountPhrase: "5k", priceBasis: "total" },
    ],
    totals: null,
    promise: null,
    question: null,
  };

  it("agreeing expense readings stay silent", async () => {
    const ctx = setup();
    try {
      const second = {
        heard: "nepa power 5k",
        entries: [
          { type: "expense", customer: "nepa", item: "Power", quantity: null, unit: null, amountNaira: 5000, amountPhrase: "5k", priceBasis: "total" },
        ],
        totals: null,
        promise: null,
        question: null,
      };
      const { proposal } = await proposeWithSecond(ctx, EXPENSE_PRIMARY, second);
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      assert.equal(statsRow(ctx, proposal.id).agreed, "yes");
    } finally {
      teardown(ctx);
    }
  });

  it("a category disagreement records in the stats and never shows", async () => {
    const ctx = setup();
    try {
      const second = {
        heard: EXPENSE_PRIMARY.heard,
        entries: [
          { type: "expense", customer: "NEPA", item: "rent", quantity: null, unit: null, amountNaira: 5000, amountPhrase: "5k", priceBasis: "total" },
        ],
        totals: null,
        promise: null,
        question: null,
      };
      const { proposal } = await proposeWithSecond(ctx, EXPENSE_PRIMARY, second);
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      // The primary entry keeps its category.
      assert.equal(proposal.entries[0].item, "power");
      assert.ok(!proposal.assumptions.some((a) => /Two readings differ/.test(a)), proposal.assumptions.join("; "));
      assert.ok(!proposal.assumptions.includes(SECOND_CHECK_CREDIT));
      const card = renderProposalCard(proposal, { existing: [], shopId: SHOP });
      assert.ok(!card.text.includes("Two readings differ"), card.text);
      assert.ok(card.buttons.some((b) => b.reply.title === "Save"), "Save stays enabled");
      const row = statsRow(ctx, proposal.id);
      assert.equal(row.agreed, "no");
      assert.deepEqual(JSON.parse(row.differing_fields), ["category"]);
    } finally {
      teardown(ctx);
    }
  });

  it("a unit-spelling disagreement records in the stats and never shows", async () => {
    const ctx = setup();
    try {
      const second = {
        heard: PRIMARY.heard,
        entries: [
          { type: "sale", customer: "Ada", item: "rice", unit: "sack", quantity: 2, amountNaira: 30000, amountPhrase: "30k", priceBasis: "total" },
          { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
        ],
        totals: null,
        promise: null,
        question: null,
      };
      const { proposal } = await proposeWithSecond(ctx, PRIMARY, second);
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      assert.equal(proposal.entries[0].unit, "bag");
      assert.ok(!proposal.assumptions.some((a) => /Two readings differ/.test(a)), proposal.assumptions.join("; "));
      const card = renderProposalCard(proposal, { existing: [], shopId: SHOP });
      assert.ok(!card.text.includes("Two readings differ"), card.text);
      const row = statsRow(ctx, proposal.id);
      assert.equal(row.agreed, "no");
      assert.deepEqual(JSON.parse(row.differing_fields), ["unit"]);
    } finally {
      teardown(ctx);
    }
  });
});

describe("second-opinion cap and parallel", () => {
  it("the 4 s cap fires with one network retry, and the card stays soft", async () => {
    const ctx = setup();
    try {
      let calls = 0;
      const hanging = (url, opts) => {
        calls++;
        return new Promise((_, reject) => {
          // A real timeout aborts with TimeoutError (the AbortSignal.timeout
          // reason), which is retryable; a generic Error would never retry.
          opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
        });
      };
      const t0 = Date.now();
      const { proposal } = await proposeWithSecond(ctx, PRIMARY, PRIMARY, { fetchFn: hanging, timeoutMs: 30 });
      const elapsed = Date.now() - t0;
      assert.equal(calls, 2, "one retry on timeout");
      assert.ok(elapsed < 1000, `cap fired fast, took ${elapsed}ms`);
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      assert.ok(proposal.assumptions.includes(SECOND_CHECK_UNAVAILABLE));
      const row = statsRow(ctx, proposal.id);
      assert.equal(row.agreed, "no_second_opinion");
      assert.ok(row.latency_ms >= 30 && row.latency_ms < 1000, `latency ${row.latency_ms}ms`);
      assert.equal(row.outcome, "timeout");
      const card = renderProposalCard(proposal, { existing: [], shopId: SHOP });
      assert.ok(card.buttons.some((b) => b.reply.title === "Save"), "Save enabled on cap");
    } finally {
      teardown(ctx);
    }
  });

  it("a late arrival after the cap is ignored, never blocks", async () => {
    const ctx = setup();
    try {
      // Returns a disagreeing reading after 120 ms, but the cap is 20 ms:
      // the abort wins, the late payload is dropped, the card stays clean.
      const late = (url, opts) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(basetenOk({
            heard: PRIMARY.heard,
            entries: [
              { type: "sale", customer: "Nobody", item: "rice", unit: "bag", quantity: 2, amountNaira: 99999, amountPhrase: "99999", priceBasis: "total" },
              PRIMARY.entries[1],
            ],
            totals: null, promise: null, question: null,
          })), 120);
          opts.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      const { proposal } = await proposeWithSecond(ctx, PRIMARY, PRIMARY, { fetchFn: late, timeoutMs: 20 });
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      assert.deepEqual(proposal.entries, EXPECTED_ENTRIES);
      assert.ok(proposal.assumptions.includes(SECOND_CHECK_UNAVAILABLE));
      assert.equal(statsRow(ctx, proposal.id).agreed, "no_second_opinion");
    } finally {
      teardown(ctx);
    }
  });

  it("a valid-but-slow second reading past 1 s is recorded late and never shown", async () => {
    const ctx = setup();
    try {
      // Disagreeing reading after 1500 ms: Baseten's own 4 s cap would
      // allow it, but the voice path only waits 1 s past the primary.
      const slow = async () => {
        await new Promise((r) => setTimeout(r, 1500));
        return basetenOk({
          heard: PRIMARY.heard,
          entries: [
            { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 25000, amountPhrase: "25k", priceBasis: "total" },
            PRIMARY.entries[1],
          ],
          totals: null, promise: null, question: null,
        });
      };
      const t0 = Date.now();
      const { proposal } = await proposeWithSecond(ctx, PRIMARY, PRIMARY, { fetchFn: slow });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 1000 && elapsed < 2500, `cut off near 1 s, took ${elapsed}ms`);
      assert.deepEqual(proposal.flags, []);
      assert.equal(proposal.question, null);
      assert.ok(!proposal.assumptions.some((a) => a.includes("Two readings differ")), proposal.assumptions.join("; "));
      assert.ok(!proposal.assumptions.includes(SECOND_CHECK_UNAVAILABLE), "late shows nothing");
      assert.deepEqual(proposal.entries, EXPECTED_ENTRIES);
      const card = renderProposalCard(proposal, { existing: [], shopId: SHOP });
      assert.ok(card.buttons.some((b) => b.reply.title === "Save"), "Save enabled when late");
      const row = statsRow(ctx, proposal.id);
      assert.equal(row.agreed, "no_second_opinion");
      assert.equal(row.outcome, "late");
    } finally {
      teardown(ctx);
    }
  });

  it("text runs the second fetch in parallel with classification, never after", async () => {
    const ctx = setup();
    try {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      // Primary takes ~120 ms, second takes ~120 ms: parallel finishes near
      // 120 ms, sequential would take ~240 ms.
      const slowModel = createMockModelClient(async () => {
        await delay(120);
        return PRIMARY;
      });
      const slowSecond = async () => {
        await delay(120);
        return basetenOk(PRIMARY);
      };
      const t0 = Date.now();
      const proposal = await propose(SHOP, "fake note text", {
        proposals: ctx.proposals,
        model: slowModel,
        ledger: null,
        now: NOW,
        secondOpinions: ctx.secondOpinions,
        secondOpinionFetch: slowSecond,
        secondOpinionEnv: FAKE_ENV,
        secondOpinionMode: "always",
      });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 220, `parallel took ${elapsed}ms, expected under 220ms`);
      assert.deepEqual(proposal.flags, []);
      assert.equal(statsRow(ctx, proposal.id).agreed, "yes");
    } finally {
      teardown(ctx);
    }
  });
});
