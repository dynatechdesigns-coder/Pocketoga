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
import { createMockModelClient, SYSTEM_PROMPT } from "./model.mjs";
import { renderProposalCard } from "./messages.mjs";
import {
  BASETEN_BASE_URL,
  SECOND_OPINION_TIMEOUT_MS,
  SecondOpinionStore,
  runSecondOpinion,
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
  { type: "sale", customer: "Ada", item: "rice", quantity: 2, unit: "bag", priceBasis: "total", amountNaira: 30000, amountKobo: 3000000, amountPhrase: "30k", eachNaira: null, eachKobo: null },
  { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, priceBasis: "total", amountNaira: 10000, amountKobo: 1000000, amountPhrase: "10k", eachNaira: null, eachKobo: null },
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

  it("a customer disagreement flags and keeps the primary name", async () => {
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
      assert.deepEqual(proposal.flags, [
        "Two readings differ: customer is Ada in one and Adaboy in the other. Which one na correct?",
      ]);
      assert.ok(proposal.entries.every((e) => e.customer === "Ada"));
      const row = statsRow(ctx, proposal.id);
      assert.equal(row.agreed, "no");
      assert.deepEqual(JSON.parse(row.differing_fields), ["customer"]);
    } finally {
      teardown(ctx);
    }
  });

  it("an entry-count mismatch flags", async () => {
    const ctx = setup();
    try {
      const second = { heard: PRIMARY.heard, entries: [PRIMARY.entries[0]], totals: null, promise: null, question: null };
      const { proposal } = await proposeWithSecond(ctx, PRIMARY, second);
      assert.deepEqual(proposal.flags, [
        "Two readings differ: one heard 2 entries and the other heard 1 entry. Which one na correct?",
      ]);
      assert.deepEqual(JSON.parse(statsRow(ctx, proposal.id).differing_fields), ["entries"]);
    } finally {
      teardown(ctx);
    }
  });

  it("a promise-date disagreement flags", async () => {
    const ctx = setup();
    try {
      const withPromise = { ...PRIMARY, promise: { customer: "Ada", datePhrase: "Friday", amountNaira: 20000 } };
      const second = { ...withPromise, promise: { customer: "Ada", datePhrase: "Saturday", amountNaira: 20000 } };
      const { proposal } = await proposeWithSecond(ctx, withPromise, second);
      assert.deepEqual(proposal.flags, [
        "Two readings differ: promise day is Friday in one and Saturday in the other. Which one na correct?",
      ]);
      assert.deepEqual(JSON.parse(statsRow(ctx, proposal.id).differing_fields), ["promise.date"]);
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
      const row = statsRow(ctx, proposal.id);
      assert.equal(row.agreed, "no_second_opinion");
      assert.deepEqual(JSON.parse(row.differing_fields), []);
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
      assert.equal(statsRow(ctx, proposal.id).agreed, "no_second_opinion");
    } finally {
      teardown(ctx);
    }
  });

  it("a non-JSON or error response still proposes cleanly", async () => {
    const ctx = setup();
    try {
      const badJson = await proposeWithSecond(ctx, PRIMARY, PRIMARY, {
        fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "not json{{{ " } }] }), text: async () => "" }),
      });
      assert.deepEqual(badJson.proposal.flags, []);
      assert.equal(statsRow(ctx, badJson.proposal.id).agreed, "no_second_opinion");

      const serverError = await proposeWithSecond(ctx, PRIMARY, PRIMARY, {
        fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" }),
      });
      assert.deepEqual(serverError.proposal.flags, []);
      assert.equal(statsRow(ctx, serverError.proposal.id).agreed, "no_second_opinion");
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
  it("sends only the note text with the primary schema, never audio, phones or ledger data", async () => {
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
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
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
  it("the default timeout is 6 seconds", () => {
    assert.equal(SECOND_OPINION_TIMEOUT_MS, 6000);
    assert.equal(BASETEN_BASE_URL, "https://inference.baseten.co/v1");
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
    assert.deepEqual(out, { agreed: "yes", differingFields: [], latencyMs: out.latencyMs, line: null });
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

  it("a category disagreement flags with the category line", async () => {
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
      const line = "Two readings differ: expense category is power in one and rent in the other. Which one na correct?";
      assert.deepEqual(proposal.flags, [line]);
      // The primary entry keeps its category.
      assert.equal(proposal.entries[0].item, "power");
      const row = statsRow(ctx, proposal.id);
      assert.equal(row.agreed, "no");
      assert.deepEqual(JSON.parse(row.differing_fields), ["category"]);
    } finally {
      teardown(ctx);
    }
  });
});
