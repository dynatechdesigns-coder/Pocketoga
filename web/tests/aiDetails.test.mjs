// Web tests for "How the AI did this" on the confirm card. Fake data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const A = await import("../src/aiDetails.js");
const card = readFileSync(new URL("../src/screens/ConfirmCard.jsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("../src/AiDetails.jsx", import.meta.url), "utf8");

const full = (result = "agreed") => ({
  ai: {
    heard: { model: "whisper-large", ms: 1234 },
    understood: { model: "llama-4", ms: 2050 },
    secondOpinion: { model: "gemma-3", ms: 900, result },
  },
});

describe("the three rows", () => {
  test("Heard, Understood and Second opinion, in that order, in plain words", () => {
    const rows = A.aiRows(full());
    assert.deepEqual(rows.map((r) => `${r.label}: ${r.text}`), [
      "Heard: whisper-large (1.2 s)",
      "Understood: llama-4 (2.1 s)",
      "Second opinion: agreed",
    ]);
    assert.equal(rows.at(-1).sub, "gemma-3"); // the model name goes on a smaller second line
    assert.ok(rows.every((r) => !r.warn));
  });

  test("one row 'Heard and understood' when the same model did both; the times are added", () => {
    const same = { ai: { heard: { model: "muse-spark-1.2", ms: 700 }, understood: { model: "muse-spark-1.2", ms: 1000 }, secondOpinion: { model: null, ms: 0, result: "off" } } };
    const rows = A.aiRows(same);
    assert.deepEqual(rows.map((r) => `${r.label}: ${r.text}`), ["Heard and understood: muse-spark-1.2 (1.7 s)"]);
  });

  test("two rows only when the models differ", () => {
    assert.deepEqual(A.aiRows(full()).filter((r) => r.key !== "second").map((r) => r.key), ["heard", "understood"]);
  });

  test("the second opinion result in plain words", () => {
    const second = (result) => A.aiRows(full(result)).find((r) => r.key === "second");
    assert.equal(second("agreed").text, "agreed");
    assert.equal(second("differs").text, "differs, please check");
    assert.equal(second("not ready").text, "didn't answer in time (nothing was blocked)");
    assert.equal(second("off"), undefined); // off: the row is hidden
    for (const r of ["agreed", "differs", "not ready"]) assert.equal(second(r).sub, "gemma-3");
  });

  test("seconds come from whole milliseconds", () => {
    assert.equal(A.secondsText(1234), "1.2 s");
    assert.equal(A.secondsText(40), "0.1 s");
    assert.equal(A.secondsText(60000), "60.0 s");
    assert.equal(A.secondsText(0), "");
    assert.equal(A.secondsText(null), "");
  });
});

describe("a missing field hides its row", () => {
  test("a typed note has no Heard row; no model means no row", () => {
    const ai = { heard: { model: null, ms: 0 }, understood: { model: "llama-4", ms: 2000 }, secondOpinion: { model: null, ms: 0, result: "off" } };
    assert.deepEqual(A.aiRows({ ai }).map((r) => r.key), ["understood"]);
    assert.equal(A.aiRows({ ai }).at(-1).key, "understood"); // a second opinion that is off is not shown
  });

  test("no ai block, or nothing usable in it, means no section", () => {
    assert.deepEqual(A.aiRows({}), []);
    assert.deepEqual(A.aiRows({ ai: null }), []);
    assert.deepEqual(A.aiRows({ ai: {} }), []);
    assert.deepEqual(A.aiRows({ ai: { secondOpinion: { result: "mystery" } } }), []);
  });

  test("a model without a time shows the name alone", () => {
    assert.equal(A.aiRows({ ai: { understood: { model: "llama-4" } } })[0].text, "llama-4");
  });
});

describe("only plain labels: never text, ids or keys", () => {
  test("a long or odd model value is not shown; extra fields are ignored", () => {
    const ai = { heard: { model: "x".repeat(61), ms: 10 }, understood: { model: "sk-live key=1 2", ms: 10, text: "secret words", id: "p_1" }, secondOpinion: { model: "gemma-3", ms: 5, result: "agreed", key: "abc" } };
    const rows = A.aiRows({ ai });
    assert.deepEqual(rows.map((r) => r.key), ["second"]);
    assert.doesNotMatch(JSON.stringify(rows), /secret|p_1|abc|sk-live/);
  });
});

describe("the card", () => {
  test("a second opinion that differs is flagged in the warning colour", () => {
    assert.equal(A.aiRows(full("differs")).at(-1).warn, true);
    assert.match(panel, /r\.warn && "[^"]*border-amber bg-amber-soft[^"]*text-amber-ink/);
  });

  test("the section is expanded by default, titled 'How the AI did this', and Save and Fix stay", () => {
    assert.equal(A.AI_TITLE, "How the AI did this");
    assert.match(panel, /<details data-part="ai-details" open /);
    assert.match(panel, /AI_TITLE/);
    assert.match(card, /<AiDetails proposal=\{proposal\} \/>/);
    assert.match(card, /data-part="save"/);
    assert.match(card, /<Pencil aria-hidden="true" \/> Fix/);
    // a differing second opinion does not lock Save
    assert.doesNotMatch(card, /canSave[^\n]*aiList|aiList[^\n]*canSave/);
  });

  test("fits 320px: the section can shrink, rows wrap, the summary is 44px tall", () => {
    assert.match(panel, /<details [^>]*min-w-0/);
    assert.match(panel, /summary className="flex min-h-11/);
    assert.match(panel, /flex min-w-0 flex-wrap gap-x-1\.5[^"]*\[overflow-wrap:anywhere\]/);
  });
});

describe("the smaller model line", () => {
  test("the panel prints the second line smaller and wrapped, inside the row", () => {
    assert.match(panel, /data-part=\{`ai-\$\{r\.key\}-model`\}/);
    assert.match(panel, /basis-full text-xs/);
  });
});
