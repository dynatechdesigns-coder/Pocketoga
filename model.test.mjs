// Meta Model API client: length-cutoff salvage and retry. The fetch is
// always mocked — no network in tests. Fake data only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createModelClient, MODEL_TEXT_MAX_TOKENS, SYSTEM_PROMPT, TEXT_MODEL, AUDIO_MODEL, MODEL_TEMPERATURE, MODEL_SEED } from "./model.mjs";

const GOOD = { heard: "fake note", entries: [], totals: null, promise: null, question: null };

function chatResponse(content, finish) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content }, finish_reason: finish }] }),
    text: async () => "",
  };
}

function clientWith(responses) {
  const seen = [];
  let n = 0;
  const fetchFn = async (url, opts) => {
    seen.push({ url, opts });
    const next = responses[Math.min(n, responses.length - 1)];
    n++;
    return next;
  };
  const client = createModelClient({ apiKey: "fake-key", fetchFn });
  return { client, seen };
}

describe("length-cutoff retry (fake data)", () => {
  it("a truncated first attempt retries once with double budget and succeeds", async () => {
    const { client, seen } = clientWith([
      chatResponse('{"heard":"fake note","entries":[{"type":"sale"', "length"),
      chatResponse(JSON.stringify(GOOD), "stop"),
    ]);
    const out = await client.complete({ text: "fake note" });
    assert.deepEqual(out, GOOD);
    assert.equal(seen.length, 2);
    const first = JSON.parse(seen[0].opts.body);
    const retry = JSON.parse(seen[1].opts.body);
    assert.equal(first.max_tokens, MODEL_TEXT_MAX_TOKENS);
    assert.equal(retry.max_tokens, MODEL_TEXT_MAX_TOKENS * 2);
    assert.equal(first.messages[0].content, SYSTEM_PROMPT);
    assert.ok(retry.messages[0].content.startsWith(SYSTEM_PROMPT));
    assert.ok(retry.messages[0].content.includes("Keep reasoning minimal"), retry.messages[0].content.slice(-120));
    assert.equal(retry.reasoning_effort, "minimal");
  });

  it("two truncated attempts fail as MODEL_TRUNCATED, never bad JSON", async () => {
    const { client, seen } = clientWith([
      chatResponse('{"heard":"cut', "length"),
      chatResponse('{"heard":"cut again', "length"),
    ]);
    await assert.rejects(client.complete({ text: "fake note" }), (err) => {
      assert.equal(err.code, "MODEL_TRUNCATED");
      return true;
    });
    assert.equal(seen.length, 2);
  });

  it("complete JSON inside a length-cut response is used with no retry", async () => {
    const { client, seen } = clientWith([
      chatResponse(`${JSON.stringify(GOOD)} trailing cut off`, "length"),
    ]);
    const out = await client.complete({ text: "fake note" });
    assert.deepEqual(out, GOOD);
    assert.equal(seen.length, 1);
  });

  it("text and audio requests send temperature 0 with a fixed seed and no top_p", async () => {
    const { client, seen } = clientWith([chatResponse(JSON.stringify(GOOD), "stop")]);
    await client.complete({ text: "fake note" });
    await client.complete({ audio: { data: "ZmFrZQ==", format: "wav" } });
    assert.equal(seen.length, 2);
    assert.equal(JSON.parse(seen[0].opts.body).model, TEXT_MODEL);
    assert.equal(JSON.parse(seen[1].opts.body).model, AUDIO_MODEL);
    for (const call of seen) {
      const body = JSON.parse(call.opts.body);
      assert.equal(body.temperature, 0);
      assert.equal(body.temperature, MODEL_TEMPERATURE);
      assert.equal(body.seed, MODEL_SEED);
      assert.ok(!("top_p" in body), "top_p stays unset (docs: temperature or top_p, not both)");
    }
  });

  it("system prompt carries the Pidgin glossary, payment rule and hearing rule", () => {
    for (const phrase of ["don pay", "never a sale", "wey", "owe me", "remain am", "pay the balance", "the rest", "balance owed", "I buy", "known customers", "forty-five hundred", "two k", "mudu", "[unclear]", "computed by code"]) {
      assert.ok(SYSTEM_PROMPT.includes(phrase), `prompt is missing: ${phrase}`);
    }
  });

  it("text and audio requests carry the known-names context when given", async () => {
    const { client, seen } = clientWith([chatResponse(JSON.stringify(GOOD), "stop")]);
    await client.complete({ text: "fake note", context: "Known names (exact spellings): customers: Fake Ada." });
    await client.complete({ audio: { data: "ZmFrZQ==", format: "wav" }, context: "Known names (exact spellings): customers: Fake Ada." });
    assert.equal(seen.length, 2);
    assert.ok(JSON.parse(seen[0].opts.body).messages[1].content.includes("customers: Fake Ada"));
    const audioParts = JSON.parse(seen[1].opts.body).messages[1].content;
    assert.ok(audioParts[0].text.includes("customers: Fake Ada"), audioParts[0].text);
  });

  it("a non-length failure still fails fast with no retry", async () => {
    const { client, seen } = clientWith([chatResponse("not json {{{", "stop")]);
    await assert.rejects(client.complete({ text: "fake note" }), (err) => {
      assert.equal(err.code, "MODEL_BAD_JSON");
      return true;
    });
    assert.equal(seen.length, 1);
  });
});
