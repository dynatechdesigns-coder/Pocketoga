// Shelf-count spike checks: parsing and pure-code flags with a stubbed
// model response. No network, fake photo bytes only.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROMPTS,
  MAX_OPEN_TYPES,
  OPEN_SYSTEM_PROMPT,
  buildMessages,
  buildOpenMessages,
  checkCounts,
  checkOpenCounts,
  compareRuns,
  countShelf,
  extractJsonObject,
  loadImageData,
  mergeDuplicates,
  normalizeName,
  parseCounts,
  parseOpenCounts,
  proposeRestock,
  readContent,
  reasoningDiag,
  scrubBodyForDebug,
  tryParseOpenReply,
  tryParseReply,
} from "./scripts/shelf-spike.mjs";

let scratch;
before(() => {
  try {
    scratch = mkdtempSync(join(tmpdir(), "pocketoga-shelf-test-"));
  } catch {
    scratch = mkdtempSync("./.shelf-test-tmp-");
  }
});
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// 1x1 PNG, fake bytes for a test photo only.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function fakePhoto(name = "shelf.png") {
  const path = join(scratch, name);
  writeFileSync(path, TINY_PNG);
  return path;
}

function chatResponse(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: "stop" }] }),
    text: async () => "",
  };
}

describe("shelf-spike parsing (stubbed model)", () => {
  it("normalises a good answer and rejects a bad shape", () => {
    const out = parseCounts({ counts: [{ prompt: "bottle", count: 12, confidence: 0.8 }] });
    assert.deepEqual(out, [{ prompt: "bottle", count: 12, confidence: 0.8 }]);
    assert.throws(() => parseCounts({}), /not usable/);
    assert.throws(() => parseCounts({ counts: "twelve" }), /not usable/);
  });

  it("builds an image_url message carrying every prompt", () => {
    const messages = buildMessages("data:image/png;base64,AAA", ["bottle", "tin"]);
    const user = messages.find((m) => m.role === "user");
    const image = user.content.find((p) => p.type === "image_url");
    assert.equal(image.image_url.url, "data:image/png;base64,AAA");
    assert.ok(user.content[0].text.includes("bottle") && user.content[0].text.includes("tin"));
  });

  it("loads fake photo bytes with the right mime", () => {
    const { data, mime } = loadImageData(fakePhoto());
    assert.equal(mime, "image/png");
    assert.ok(data.length > 0);
    assert.throws(() => loadImageData(join(scratch, "note.txt")), /unsupported image type/);
  });
});

describe("shelf-spike checks (no AI)", () => {
  it("flags zero, huge, non-integer and low-confidence counts", () => {
    const { items, flags } = checkCounts([
      { prompt: "bottle", count: 12, confidence: 0.8 },
      { prompt: "tin", count: 0, confidence: 0.9 },
      { prompt: "carton", count: 201, confidence: 0.9 },
      { prompt: "sachet", count: 2.5, confidence: 0.9 },
      { prompt: "cup", count: 3, confidence: 0.2 },
    ]);
    assert.equal(items[0].ok, true);
    assert.deepEqual(items[0].reasons, []);
    assert.ok(items[1].reasons.some((r) => r.includes("none seen")), JSON.stringify(items[1]));
    assert.ok(items[2].reasons.some((r) => r.includes("suspicious")), JSON.stringify(items[2]));
    assert.ok(items[3].reasons.some((r) => r.includes("not an integer")), JSON.stringify(items[3]));
    assert.ok(items[4].reasons.some((r) => r.includes("low confidence")), JSON.stringify(items[4]));
    assert.ok(flags.length >= 4);
  });

  it("a proposal is unsaved and says a trader must confirm", () => {
    const proposal = proposeRestock("shelf.png", [{ prompt: "bottle", count: 1, confidence: 0.9, ok: true, reasons: [] }], []);
    assert.equal(proposal.saved, false);
    assert.ok(proposal.note.includes("confirm"));
  });
});

describe("shelf-spike run (stubbed fetch)", () => {
  it("counts through the whole path with no network", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return chatResponse({ counts: [{ prompt: "bottle", count: 4, confidence: 0.7 }] });
    };
    const proposal = await countShelf({
      imagePath: fakePhoto(),
      prompts: ["bottle"],
      fetchFn,
      env: { SHELF_API_KEY: "fake-key", SHELF_MODEL: "fake-model", SHELF_API_URL: "https://x.test/v1" },
    });
    assert.equal(calls, 1);
    assert.equal(proposal.proposal, "shelf-restock");
    assert.equal(proposal.saved, false);
    assert.deepEqual(proposal.items, [{ prompt: "bottle", count: 4, confidence: 0.7, ok: true, reasons: [] }]);
    assert.deepEqual(proposal.flags, []);
  });

  it("a missing key and an HTTP error fail loudly", async () => {
    await assert.rejects(countShelf({ imagePath: fakePhoto(), env: {} }), /SHELF_API_KEY is not set/);
    await assert.rejects(
      countShelf({
        imagePath: fakePhoto(),
        fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "" }),
        env: { SHELF_API_KEY: "fake-key" },
      }),
      /shelf API error 401/
    );
  });

  it("defaults to the bottle/tin/carton prompts", async () => {
    assert.deepEqual(DEFAULT_PROMPTS, ["bottle", "tin", "carton"]);
  });
});

describe("shelf-spike tolerant replies (stubbed fetch)", () => {
  const GOOD = { counts: [{ prompt: "bottle", count: 4, confidence: 0.7 }] };
  const reply = (content, { finish = "stop", usage = undefined, extra = undefined } = {}) => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content, ...(extra ?? {}) }, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    }),
    text: async () => "",
  });
  const run = (contents) => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return reply(contents[Math.min(calls - 1, contents.length - 1)]);
    };
    return { calls: () => calls, fetchFn };
  };
  const env = { SHELF_API_KEY: "fake-key", SHELF_MODEL: "fake-model", SHELF_API_URL: "https://x.test/v1" };

  it("extracts the balanced object and ignores the fence", () => {
    const fenced = '```json\n{"counts": [{"prompt": "bottle", "count": 4, "confidence": 0.7}]}\n```';
    assert.equal(extractJsonObject(fenced), '{"counts": [{"prompt": "bottle", "count": 4, "confidence": 0.7}]}');
    assert.equal(extractJsonObject("no braces here"), null);
    assert.equal(extractJsonObject('{"counts": []} trailing } junk'), '{"counts": []}');
    assert.ok(tryParseReply(fenced).ok);
  });

  it("parses fenced JSON in one call", async () => {
    const stub = run(['```json\n{"counts": [{"prompt": "bottle", "count": 4, "confidence": 0.7}]}\n```']);
    const proposal = await countShelf({ imagePath: fakePhoto(), prompts: ["bottle"], fetchFn: stub.fetchFn, env });
    assert.equal(stub.calls(), 1);
    assert.equal(proposal.items[0].count, 4);
  });

  it("parses JSON with surrounding text in one call", async () => {
    const stub = run(['Here you go: {"counts": [{"prompt": "tin", "count": 2, "confidence": 0.6}]} hope this helps }']);
    const proposal = await countShelf({ imagePath: fakePhoto(), prompts: ["tin"], fetchFn: stub.fetchFn, env });
    assert.equal(stub.calls(), 1);
    assert.equal(proposal.items[0].count, 2);
  });

  it("retries once with a stricter instruction when the first reply has no JSON", async () => {
    let secondBody = null;
    let calls = 0;
    const fetchFn = async (url, opts) => {
      calls++;
      if (calls === 2) secondBody = JSON.parse(opts.body);
      return reply(calls === 1 ? "I cannot see the shelf clearly." : JSON.stringify(GOOD));
    };
    const proposal = await countShelf({ imagePath: fakePhoto(), prompts: ["bottle"], fetchFn, env });
    assert.equal(calls, 2);
    assert.ok(secondBody.messages.at(-1).content.includes("JSON only"), JSON.stringify(secondBody.messages.at(-1)));
    assert.equal(proposal.items[0].count, 4);
  });

  it("fails with the first 200 reply characters when neither attempt has JSON", async () => {
    const junk = `sorry ${"x".repeat(300)}`;
    const stub = run([`first: ${junk}`, `second: ${junk}`]);
    await assert.rejects(
      countShelf({ imagePath: fakePhoto(), prompts: ["bottle"], fetchFn: stub.fetchFn, env }),
      (err) => {
        assert.equal(stub.calls(), 2);
        assert.ok(err.message.startsWith("shelf response was not usable (no JSON): second: "), err.message);
        assert.ok(err.message.length <= "shelf response was not usable (no JSON): ".length + 200, err.message);
        return true;
      }
    );
  });

  it("--debug prints status and reply, never key, URL or image data", async () => {
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const stub = run([JSON.stringify(GOOD)]);
      await countShelf({ imagePath: fakePhoto(), prompts: ["bottle"], fetchFn: stub.fetchFn, env, debug: true });
    } finally {
      console.log = origLog;
    }
    const joined = lines.join("\n");
    assert.ok(joined.includes("status: 200"), joined);
    assert.ok(joined.includes('"count":4') || joined.includes('"count": 4'), joined);
    assert.ok(!joined.includes("fake-key"), joined);
    assert.ok(!joined.includes("x.test"), joined);
    assert.ok(!joined.includes("base64"), joined);
  });

  it("reads array-style content parts as the answer", () => {
    assert.equal(readContent({ content: [{ type: "text", text: '{"a":1}' }, { type: "text", text: '{"b":2}' }] }), '{"a":1}{"b":2}');
    assert.equal(readContent({ content: "plain" }), "plain");
    assert.equal(readContent({}), "");
    assert.equal(readContent(null), "");
  });

  it("parses an array-style content reply in one call", async () => {
    const stub = run([
      [{ type: "text", text: 'Count: {"counts": [{"prompt": "bottle", "count": 6, "confidence": 0.75}]}' }],
    ]);
    const proposal = await countShelf({ imagePath: fakePhoto(), prompts: ["bottle"], fetchFn: stub.fetchFn, env });
    assert.equal(stub.calls(), 1);
    assert.equal(proposal.items[0].count, 6);
  });

  it("fails clearly on an empty reply with no crash", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return reply("");
    };
    await assert.rejects(
      countShelf({ imagePath: fakePhoto(), prompts: ["bottle"], fetchFn, env }),
      (err) => {
        assert.equal(calls, 2);
        assert.equal(err.message, "shelf response was not usable (empty reply)");
        return true;
      }
    );
  });

  it("doubles the budget when the first reply is cut off by length", async () => {
    const bodies = [];
    let calls = 0;
    const fetchFn = async (url, opts) => {
      calls++;
      bodies.push(JSON.parse(opts.body));
      if (calls === 1) return reply('{"counts": [{"prompt": "bottle", "count":', { finish: "length" });
      return reply(JSON.stringify(GOOD));
    };
    const proposal = await countShelf({ imagePath: fakePhoto(), prompts: ["bottle"], fetchFn, env });
    assert.equal(calls, 2);
    assert.equal(bodies[0].max_tokens, 500);
    assert.equal(bodies[1].max_tokens, 1000);
    assert.equal(proposal.items[0].count, 4);
  });

  it("--debug shows finish, message keys, usage and reasoning diagnostics", async () => {
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const fetchFn = async () =>
        reply(JSON.stringify(GOOD), {
          finish: "stop",
          usage: { prompt_tokens: 1200, completion_tokens: 40 },
          extra: { reasoning_content: "some thinking" },
        });
      const proposal = await countShelf({ imagePath: fakePhoto(), prompts: ["bottle"], fetchFn, env, debug: true });
      assert.equal(proposal.items[0].count, 4);
    } finally {
      console.log = origLog;
    }
    const joined = lines.join("\n");
    assert.ok(joined.includes("finish: stop"), joined);
    assert.ok(joined.includes("messageKeys: content,reasoning_content"), joined);
    assert.ok(joined.includes('"prompt_tokens":1200'), joined);
    assert.ok(joined.includes("some thinking"), joined);
    const diag = reasoningDiag({ reasoning_content: "some thinking" }, {});
    assert.deepEqual(diag, { reasoning_content: "some thinking" });
    assert.ok(scrubBodyForDebug({ x: `data:image/jpeg;base64,${"A".repeat(300)}` }).includes("[image data omitted]"));
  });
});

describe("shelf-spike open mode (stubbed fetch)", () => {
  const env = { SHELF_API_KEY: "fake-key", SHELF_MODEL: "fake-model", SHELF_API_URL: "https://x.test/v1" };
  const reply = (content) => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }),
    text: async () => "",
  });
  const runBoth = (first, second) => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return reply(calls === 1 ? first : second);
    };
    return { calls: () => calls, fetchFn };
  };

  it("parses an open answer, fenced or bare", () => {
    const fenced = '```json\n{"items": [{"name": "Coke", "count": 12, "confidence": 0.8, "legible": true}]}\n```';
    const out = tryParseOpenReply(fenced);
    assert.ok(out.ok);
    assert.deepEqual(out.entries, [{ name: "Coke", count: 12, confidence: 0.8, legible: true }]);
    assert.ok(tryParseOpenReply('[{"name": "Milo", "count": 3, "confidence": 0.7, "legible": false}]').ok);
    assert.ok(!tryParseOpenReply("no braces here").ok);
    assert.throws(() => parseOpenCounts({ nope: 1 }), /not usable/);
    assert.ok(OPEN_SYSTEM_PROMPT.includes("Reply with JSON only"));
    assert.ok(buildOpenMessages("data:image/png;base64,AAA")[0].content.includes("legible"));
  });

  it("runs open mode with no prompts and proposes, unsaved", async () => {
    const stub = runBoth(JSON.stringify({ items: [{ name: "Coke", count: 12, confidence: 0.8, legible: true }] }), JSON.stringify({ items: [{ name: "Coke", count: 12, confidence: 0.8, legible: true }] }));
    const proposal = await countShelf({ imagePath: fakePhoto(), open: true, fetchFn: stub.fetchFn, env });
    assert.equal(stub.calls(), 2);
    assert.equal(proposal.saved, false);
    assert.deepEqual(proposal.items, [{ name: "Coke", count: 12, confidence: 0.8, legible: true, ok: true, reasons: [] }]);
    assert.deepEqual(proposal.flags, []);
  });

  it("merges duplicate names case-insensitively", () => {
    const { items, flags } = checkOpenCounts([
      { name: "Coke", count: 5, confidence: 0.9, legible: true },
      { name: " coke ", count: 3, confidence: 0.6, legible: false },
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].count, 8);
    assert.equal(items[0].confidence, 0.6);
    assert.equal(items[0].legible, false);
    assert.ok(items[0].reasons.some((r) => r.includes('merged 2 duplicate rows named "Coke"')), JSON.stringify(items[0]));
    assert.ok(flags.some((f) => f.includes("merged 2 duplicate rows")), flags.join("\n"));
    assert.equal(normalizeName("  Coke "), "coke");
    const solo = mergeDuplicates([{ name: "Milo", count: 2, confidence: 0.9, legible: true, ok: true, reasons: [] }], []);
    assert.equal(solo.length, 1);
    assert.equal(solo[0].ok, true);
  });

  it("compares two runs by name with a 20% bar", () => {
    assert.deepEqual(compareRuns([{ name: "Coke", count: 10 }], [{ name: "Coke", count: 12 }]), []);
    const flags = compareRuns(
      [{ name: "Coke", count: 10 }, { name: "Milo", count: 5 }],
      [{ name: "Coke", count: 13 }, { name: "Peak", count: 4 }]
    );
    assert.ok(flags.some((f) => f.includes("Coke") && f.includes("10 vs 13")), flags.join("\n"));
    assert.ok(flags.some((f) => f.includes("Milo") && f.includes("only in run 1")), flags.join("\n"));
    assert.ok(flags.some((f) => f.includes("Peak") && f.includes("only in run 2")), flags.join("\n"));
  });

  it("flags illegible labels, low confidence and crowded shelves", () => {
    const { items, flags } = checkOpenCounts([
      { name: "Coke", count: 4, confidence: 0.4, legible: false },
      { name: "Milo", count: 2, confidence: 0.9, legible: true },
    ]);
    assert.ok(items[0].reasons.some((r) => r.includes("check the label")), JSON.stringify(items[0]));
    assert.ok(items[0].reasons.some((r) => r.includes("low confidence")), JSON.stringify(items[0]));
    assert.equal(items[1].ok, true);
    const many = Array.from({ length: MAX_OPEN_TYPES + 1 }, (_, i) => ({ name: `item-${i}`, count: 1, confidence: 0.9, legible: true }));
    const crowded = checkOpenCounts(many);
    assert.equal(crowded.items.length, MAX_OPEN_TYPES + 1);
    assert.ok(crowded.flags.some((f) => f.includes("too crowded, try a closer photo")), crowded.flags.join("\n"));
  });

  it("flags run-to-run differences end to end", async () => {
    const run1 = JSON.stringify({ items: [{ name: "Coke", count: 10, confidence: 0.8, legible: true }, { name: "Milo", count: 5, confidence: 0.8, legible: true }] });
    const run2 = JSON.stringify({ items: [{ name: "Coke", count: 13, confidence: 0.8, legible: true }, { name: "Peak", count: 4, confidence: 0.8, legible: true }] });
    const stub = runBoth(run1, run2);
    const proposal = await countShelf({ imagePath: fakePhoto(), open: true, fetchFn: stub.fetchFn, env });
    assert.equal(stub.calls(), 2);
    assert.equal(proposal.items.length, 2);
    assert.ok(proposal.flags.some((f) => f.includes("counts differ between runs (10 vs 13)")), proposal.flags.join("\n"));
    assert.ok(proposal.flags.some((f) => f.includes("only in run 1")), proposal.flags.join("\n"));
    assert.ok(proposal.flags.some((f) => f.includes("only in run 2")), proposal.flags.join("\n"));
  });
});
