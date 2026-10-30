// Meta Model API client: length-cutoff salvage and retry. The fetch is
// always mocked — no network in tests. Fake data only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createModelClient, MODEL_TEXT_MAX_TOKENS, SYSTEM_PROMPT } from "./model.mjs";

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

  it("a non-length failure still fails fast with no retry", async () => {
    const { client, seen } = clientWith([chatResponse("not json {{{", "stop")]);
    await assert.rejects(client.complete({ text: "fake note" }), (err) => {
      assert.equal(err.code, "MODEL_BAD_JSON");
      return true;
    });
    assert.equal(seen.length, 1);
  });
});
