// Web tests for the debt line, part-paid rows, the two-amount choice card, the
// date on a Debts row and the rename of a customer label. Shapes are the ones the
// server sends (see .muse-report.md). Source-text checks for the screens, since
// there is no browser here. Fake data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const V = await import("../src/debtView.js");
const { ApiError, renameCustomer, setShop } = await import("../src/api.js");
const { lagosToday, formatDueDay } = await import("../src/format.js");

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const confirm = src("screens/ConfirmCard.jsx");
const debts = src("screens/DebtsScreen.jsx");

describe("the debt line on the confirm card", () => {
  test("a customer debt reads 'Debt: Customer 1 owes ₦20,000', from whole kobo", () => {
    const lines = V.debtLines({ debts: [{ customer: "Customer 1", amountKobo: 2000000, direction: "customer_owes" }] });
    assert.deepEqual(lines.map((l) => l.text), ["Debt: Customer 1 owes ₦20,000"]);
  });

  test("a debt the trader owes says so; bad or empty debts are skipped; none means no line", () => {
    assert.equal(V.debtLines({ debts: [{ customer: "Ada", amountKobo: 150050, direction: "trader_owes" }] })[0].text, "Debt: you owe Ada ₦1,500.50");
    assert.deepEqual(V.debtLines({ debts: [{ customer: "Ada", amountKobo: 0, direction: "customer_owes" }, { customer: "Bo", amountKobo: 1.5 }, null] }), []);
    assert.deepEqual(V.debtLines({}), []);
    assert.deepEqual(V.debtLines({ debts: [] }), []);
  });

  test("the card shows each debt as its own highlighted line with the debt icon", () => {
    assert.match(confirm, /debtLines\(proposal\)/);
    assert.match(confirm, /data-part="debt-line"[^>]*bg-amber-soft/);
    assert.match(confirm, /<HandCoins aria-hidden="true" \/>/);
  });
});

describe("a part-paid sale shows three lines", () => {
  const partPaid = { customer: "Ada", totalKobo: 4500000, paidKobo: 2500000, owedKobo: 2000000 };

  test("sale total, paid and debt left, in that order", () => {
    assert.deepEqual(V.partPaidRows({ partPaid }), [
      { key: "total", label: "Sale total", kobo: 4500000 },
      { key: "paid", label: "Paid", kobo: 2500000 },
      { key: "owed", label: "Debt left", kobo: 2000000 },
    ]);
  });

  test("nothing when the sale is not part-paid or the numbers are not whole kobo", () => {
    assert.equal(V.partPaidRows({ partPaid: null }), null);
    assert.equal(V.partPaidRows({}), null);
    assert.equal(V.partPaidRows({ partPaid: { ...partPaid, paidKobo: 25000.5 } }), null);
  });

  test("the card prints them with the money formatter, in place of the plain totals", () => {
    assert.match(confirm, /partPaidRows\(proposal\)/);
    assert.match(confirm, /\(partRows \|\| t\)/);
    assert.match(confirm, /formatKobo\(kobo\)/);
  });
});

describe("the two-amount choice card", () => {
  const withOptions = { heard: "sold rice 63", entries: [{ type: "sale", amountKobo: 6300, amountOptions: [6300, 630000] }] };

  test("asks 'Did you mean ₦63 or ₦6,300?' from the two amounts", () => {
    const c = V.amountChoice(withOptions);
    assert.equal(c.question, "Did you mean ₦63 or ₦6,300?");
    assert.deepEqual(c.options, [6300, 630000]);
    assert.equal(c.index, 0);
  });

  test("only when an entry really has two whole-kobo options", () => {
    assert.equal(V.amountChoice({ entries: [{ amountOptions: null }] }), null);
    assert.equal(V.amountChoice({ entries: [{ amountOptions: [6300] }] }), null);
    assert.equal(V.amountChoice({ entries: [{ amountOptions: [63.5, 6300] }] }), null);
    assert.equal(V.amountChoice({ entries: [] }), null);
  });

  test("a tap sends the answer '1' or '2' to the fix route and shows the next card; no Save on the choice card", () => {
    assert.equal(V.choiceFix(1), "1");
    assert.equal(V.choiceFix(2), "2");
    const card = confirm.slice(confirm.indexOf("if (choice) {"), confirm.indexOf('data-part="confirm"'));
    assert.match(card, /fixProposal\(proposal\.id, choiceFix\(n\)\)/);
    assert.match(card, /onUpdate\(/);
    assert.match(card, /choice\.options\.map/);
    assert.doesNotMatch(card, /data-part="save"|Check aria-hidden|confirmProposal|save\(/);
  });

  test("both choices are large buttons that can shrink; they stack on the narrowest phones", () => {
    const card = confirm.slice(confirm.indexOf("if (choice) {"), confirm.indexOf('data-part="confirm"'));
    assert.match(card, /size="lg"/);
    assert.match(card, /grid-cols-2[^"]*max-\[359px\]:grid-cols-1/);
    assert.match(card, /min-w-0/);
  });
});

describe("the date on a Debts row", () => {
  test("is today minus the age, in Lagos time: 'Since Fri 30 Oct'", () => {
    assert.equal(V.debtSince(0), formatDueDay(lagosToday()));
    assert.equal(V.debtSince(3), formatDueDay(lagosToday(-3)));
    assert.equal(V.debtDateLine(3), `Since ${formatDueDay(lagosToday(-3))}`);
    assert.equal(V.debtDateLine(0), "Since today");
  });

  test("two unnamed customers of different ages read differently", () => {
    assert.notEqual(V.debtDateLine(2), V.debtDateLine(9));
  });

  test("an unknown age shows no date", () => {
    assert.equal(V.debtDateLine(undefined), "");
    assert.equal(V.debtSince(-1), null);
  });

  test("the row shows label, amount and date, and nothing in it can push past the edge", () => {
    assert.match(debts, /data-part="debt-name" className="truncate/);
    assert.match(debts, /data-part="debt-date"/);
    assert.match(debts, /debtDateLine\(c\.ageDays\)/);
    assert.match(debts, /formatKobo\(c\.owedKobo\)/);
    assert.match(debts, /<li key=\{c\.customer\} className="flex min-w-0 items-center">/);
  });
});

describe("renaming a label", () => {
  test("checks the new name in plain words", () => {
    assert.equal(V.validateRename("Customer 1", "  Ada   Obi ").to, "Ada Obi");
    assert.match(V.validateRename("Customer 1", "   ").error, /Type the new name/);
    assert.match(V.validateRename("Customer 1", "customer 1").error, /same name/);
    assert.match(V.validateRename("Customer 1", "x".repeat(101)).error, /at most 100/);
    assert.equal(V.validateRename("Customer 1", "x".repeat(100)).to.length, 100);
  });

  test("the server's refusals become plain sentences, not developer text", () => {
    assert.match(V.renameError(new ApiError(409, "the new name is already used in this shop")), /already have a customer with that name/);
    assert.match(V.renameError(new ApiError(404, "customer not found")), /could not find that customer/);
    assert.match(V.renameError(new ApiError(0, "")), /Cannot reach PocketOga/);
    assert.match(V.renameError(new ApiError(500, "boom")), /Could not change the name/);
    for (const status of [0, 400, 404, 409, 500]) assert.doesNotMatch(V.renameError(new ApiError(status, "x")), /from is required|ledger|json/i);
  });

  test("sends POST /customers/rename { from, to }", async () => {
    setShop("demo");
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ renamed: 1, customer: null }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const out = await renameCustomer("Customer 1", "Ada");
      assert.equal(out.renamed, 1);
      assert.match(calls[0].url, /\/customers\/rename$/);
      assert.equal(calls[0].init.method, "POST");
      assert.deepEqual(JSON.parse(calls[0].init.body), { from: "Customer 1", to: "Ada" });
    } finally {
      globalThis.fetch = real;
    }
  });

  test("each row has a 44px Edit button; it opens a form, and the list reloads after a rename", () => {
    assert.match(debts, /data-part="debt-edit"[^]*?aria-label=\{`Rename \$\{c\.customer\}`\}[^]*?size-11 shrink-0/);
    assert.match(debts, /renameCustomer\(from, out\.to\)/);
    assert.match(debts, /setRenaming\(null\);\s*reload\(\);/);
    assert.match(debts, /data-part="rename-form"[^>]*className="grid min-w-0 gap-4"/);
  });
});
