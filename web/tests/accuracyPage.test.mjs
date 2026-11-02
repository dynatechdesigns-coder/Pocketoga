// Web tests for the public "How accurate is PocketOga?" page: the exact numbers,
// the plain words, the one CSS bar, the links to it and the narrow-phone rules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const D = await import("../src/accuracyData.js");
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const page = src("screens/AccuracyPage.jsx");
const everyWord = JSON.stringify(D);

describe("the numbers", () => {
  test("96 runs from 16 notes, 3 times each, in two setups", () => {
    assert.equal(D.TESTED.runs, 96);
    assert.match(D.TESTED.text, /16 spoken notes/);
    assert.match(D.TESTED.text, /English, Pidgin and one Yoruba/);
    assert.match(D.TESTED.text, /3 times/);
    assert.match(D.TESTED.text, /new shop with no history/);
    assert.match(D.TESTED.text, /established shop with known customers/);
    assert.match(D.TESTED.text, /96 runs in total/);
    assert.equal(16 * 3 * 2, D.TESTED.runs); // 16 notes x 3 runs x 2 setups
  });

  test("72 correct (75%), 24 flagged (25%), 0 silent of 96", () => {
    const [correct, flagged, silent] = D.RESULTS.parts;
    assert.deepEqual([correct.count, correct.percent], [72, 75]);
    assert.deepEqual([flagged.count, flagged.percent], [24, 25]);
    assert.deepEqual([silent.count, silent.percent], [0, 0]);
    assert.equal(correct.count + flagged.count + silent.count, D.RESULTS.total);
    assert.equal(D.RESULTS.total, 96);
  });

  test("established shop 37 / 11 / 0, new shop 35 / 13 / 0, and they add up to the totals", () => {
    const [est, fresh] = D.SETUPS.rows;
    assert.deepEqual([est.label, est.correct, est.flagged, est.silent], ["Established shop", 37, 11, 0]);
    assert.deepEqual([fresh.label, fresh.correct, fresh.flagged, fresh.silent], ["New shop", 35, 13, 0]);
    assert.equal(est.correct + fresh.correct, 72);
    assert.equal(est.flagged + fresh.flagged, 24);
  });

  test("by detail: item type 86, amounts 78, customer names 86, item counts 92, each of 96", () => {
    assert.deepEqual(D.FIELDS.rows.map((r) => [r.label, r.right]), [["Item type", 86], ["Amounts", 78], ["Customer names", 86], ["Item counts", 92]]);
    assert.equal(D.FIELDS.of, 96);
  });

  test("speed and limits are stated as given", () => {
    assert.match(D.SPEED.items[0], /median of 5\.4 seconds/);
    assert.match(D.SPEED.items[0], /slowest took 6\.9 seconds/);
    assert.match(D.SPEED.items[1], /2 to 8 seconds/);
    assert.match(D.LIMITS.items[0], /one speaker and a small sample/);
    assert.match(D.LIMITS.items[0], /guide, not a guarantee/);
    assert.match(D.LIMITS.items[1], /12 of 12 typed notes/);
    assert.equal(D.ACCURACY_DATE, "2 Nov 2026");
  });

  test("what flagged means, and where it struggles", () => {
    assert.match(D.FLAGGED.text, /asks you a question or shows a check card/);
    assert.match(D.FLAGGED.text, /nothing is saved until you confirm/);
    const s = D.STRUGGLES.items.join(" ");
    assert.match(s, /pay the remain 2500/);
    assert.match(s, /"each" and several items/);
    assert.match(s, /Mama Bisi.*Mama busy/);
    assert.match(s, /Yoruba is experimental/);
    assert.match(s, /nothing is saved without a check/);
  });

  test("plain words only: no developer terms", () => {
    assert.doesNotMatch(everyWord, /\b(api|json|token|latency|p95|f1|precision|recall|llm|payload|endpoint)\b/i);
  });
});

describe("the page", () => {
  test("renders every number from the data, with the words written next to the bar", () => {
    assert.match(page, /\{p\.label\}: \{p\.count\} of \{RESULTS\.total\} \(\{p\.percent\}%\)/);
    assert.match(page, /\{r\.right\} of \{FIELDS\.of\}/);
    assert.match(page, /\{r\.correct\} correct, \{r\.flagged\} flagged, \{r\.silent\} silent/);
    for (const part of ["TESTED.text", "FLAGGED.text", "STRUGGLES.items", "SPEED.items", "LIMITS.items", "ACCURACY_TITLE", "ACCURACY_DATE"]) assert.match(page, new RegExp(part.replace(".", "\\.")));
  });

  test("one simple bar made with CSS only: segments sized by percent, no chart library", () => {
    assert.match(page, /data-part="accuracy-bar"/);
    assert.match(page, /style=\{\{ width: `\$\{p\.percent\}%` \}\}/);
    assert.doesNotMatch(page, /recharts|chart\.js|d3|<svg|<canvas/i);
    assert.match(page, /role="img"\s+aria-label=\{SUMMARY\}/);
    assert.equal(D.SUMMARY, "72 of 96 fully correct. 24 of 96 wrong but flagged. 0 of 96 wrong and not flagged.");
  });

  test("works in light and dark: only the app's colour tokens, never fixed colours", () => {
    assert.doesNotMatch(page, /#[0-9a-f]{3,8}\b|rgb\(|bg-white|bg-black|text-black/i);
    assert.match(page, /correct: "bg-teal", flagged: "bg-amber", silent: "bg-coral"/);
  });

  test("fits 320, 360 and 390px: one shrinking column, wrapping text, no fixed widths", () => {
    assert.match(page, /<main [^>]*min-w-0 max-w-\[640px\]/);
    assert.match(page, /w-full min-w-0 overflow-hidden/);
    assert.match(page, /\[overflow-wrap:anywhere\]/);
    assert.match(page, /grid-cols-\[auto_minmax\(0,1fr\)\]/);
    assert.doesNotMatch(page, /(^|[\s"])(min-)?w-\[\d+|\bw-screen\b/);
  });

  test("is static and public: no requests, no sign-in needed", () => {
    assert.doesNotMatch(page, /api\.js|fetch\(|useLoad|localStorage/);
    assert.match(src("Root.jsx"), /location\.pathname === "\/accuracy"\) return <AccuracyPage \/>;/);
  });
});

describe("where it is linked from", () => {
  test("the landing page footer", () => {
    assert.match(src("landing/Footer.jsx"), /href=\{ACCURACY_PATH\} data-part="accuracy-link"[^]*?\{ACCURACY_LINK\}/);
  });

  test("the More list in the app (a row at least 44px tall)", () => {
    const app = src("App.jsx");
    assert.match(app, /data-part="more-accuracy"\s+href=\{ACCURACY_PATH\}/);
    assert.match(app, /data-part="more-accuracy"[^]*?min-h-16/);
    assert.match(app, /\{ACCURACY_LINK\}/);
  });

  test("the path and the link text", () => {
    assert.equal(D.ACCURACY_PATH, "/accuracy");
    assert.equal(D.ACCURACY_LINK, "How accurate is PocketOga?");
  });
});
