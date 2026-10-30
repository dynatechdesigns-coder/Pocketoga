import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseNaira, nairaToKobo, formatKobo, extractNairaAmounts } from "./money.mjs";

describe("parseNaira (deterministic money parser)", () => {
  it("parses the required cases", () => {
    assert.deepEqual(parseNaira("15k"), { kobo: 1500000, remainder: false });
    assert.deepEqual(parseNaira("N2,500"), { kobo: 250000, remainder: false });
    assert.deepEqual(parseNaira("5 hundred"), { kobo: 50000, remainder: false });
    assert.deepEqual(parseNaira("fifteen thousand"), { kobo: 1500000, remainder: false });
    assert.deepEqual(parseNaira("2.5k"), { kobo: 250000, remainder: false });
    assert.deepEqual(parseNaira("remain 3k"), { kobo: 300000, remainder: true });
  });

  it("parses variants", () => {
    assert.equal(parseNaira("₦1,000").kobo, 100000);
    assert.equal(parseNaira("twenty-five thousand").kobo, 2500000);
    assert.equal(parseNaira("forty-five hundred").kobo, 450000);
    assert.equal(parseNaira("one thousand five hundred").kobo, 150000);
    assert.equal(parseNaira("one hundred and five").kobo, 10500);
    assert.equal(parseNaira("100").kobo, 10000);
    assert.equal(parseNaira("2,500 naira").kobo, 250000);
    assert.equal(parseNaira("N 3,000").kobo, 300000);
    assert.equal(parseNaira("five k").kobo, 500000);
    assert.equal(parseNaira("two k").kobo, 200000);
    assert.equal(parseNaira("2.55k").kobo, 255000);
    assert.equal(parseNaira("0.5").kobo, 50);
    assert.deepEqual(parseNaira("3k remain"), { kobo: 300000, remainder: true });
  });

  it("rejects what it cannot read", () => {
    for (const bad of ["", "abc", "fifteen apples", "k", "1.2.3k"]) {
      assert.throws(() => parseNaira(bad), /could not parse/, JSON.stringify(bad));
    }
    assert.throws(() => parseNaira("0.005"), /whole kobo/);
    assert.throws(() => parseNaira("-5k"), /negative/);
    assert.throws(() => parseNaira("minus 2k"), /negative/);
    assert.throws(() => parseNaira(123), /could not parse/);
  });

  it("nairaToKobo converts whole naira only", () => {
    assert.equal(nairaToKobo(15), 1500);
    assert.equal(nairaToKobo(0), 0);
    assert.throws(() => nairaToKobo(15.5), /whole naira/);
    assert.throws(() => nairaToKobo(-1), /negative/);
    assert.throws(() => nairaToKobo("15"), /whole naira/);
  });

  it("extractNairaAmounts finds digits and number words", () => {
    assert.deepEqual(extractNairaAmounts("Bola don pay the remain 2500"), [2500]);
    assert.deepEqual(extractNairaAmounts("8 crates of eggs for seventeen thousand"), [8, 17000]);
    assert.deepEqual(extractNairaAmounts("Ada pay five k"), [5000]);
    assert.deepEqual(extractNairaAmounts("forty-five hundred and 15k"), [4500, 15000]);
    assert.deepEqual(extractNairaAmounts("2 crates egg, 8 thousand 5 hundred each"), [2, 8500]);
    assert.deepEqual(extractNairaAmounts("no numbers here"), []);
  });

  it("formatKobo prints naira for questions", () => {
    assert.equal(formatKobo(1500000), "₦15,000");
    assert.equal(formatKobo(50), "₦0.50");
  });
});
