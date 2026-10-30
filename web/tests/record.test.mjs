// Web tests for the record-from-anywhere flow. Run: npm test (in web/).
// They cover the logic behind the screens (the API calls, the form, the
// confirm card's words and Save rule, and the refresh signal) with a fake
// fetch; no browser and no server. Fake data only.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

const { ApiError, confirmProposal, proposeAudio, proposeForm, proposeText, setShop } = await import("../src/api.js");
const { canSave, describeEntry, hintLine, problemsOf } = await import("../src/entryWords.js");
const { buildFormPayload, emptyForm, submitRecordForm } = await import("../src/recordForm.js");
const { notifyDataChanged, onDataChanged } = await import("../src/refresh.js");

const realFetch = globalThis.fetch;
let calls;

// A proposal as the server returns it (fake data).
const proposal = (extra = {}) => ({
  id: 7,
  shop_id: "demo",
  status: "pending",
  heard: "Ada buy 2 bags of rice, 45k",
  question: null,
  created_at: "2026-10-29T10:00:00.000Z",
  entries: [{ type: "sale", customer: "Ada", item: "rice", quantity: 2, unit: "bag", priceBasis: "total", amountKobo: 4500000 }],
  totals: null,
  flags: [],
  notes: [],
  effects: [{ destination: "Sales", stockBefore: 10, stockAfter: 8, stockItem: "rice", stockUnit: "bag", negativeStock: false, costUnknown: false }],
  source: "text",
  hint: null,
  hintNote: null,
  ...extra,
});

// Records every request and answers like the routes in PROJECT.md.
function fakeServer(proposalFor = () => proposal()) {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body });
    const json = (status, data) => ({ ok: status < 400, status, json: async () => data });
    if (path === "/propose" || path === "/propose-form") return json(201, { proposal: proposalFor(path, body) });
    if (path.startsWith("/confirm/")) return json(200, { proposal: proposal({ status: "confirmed" }), recordedIds: [1], alreadyConfirmed: false });
    return json(404, { error: "not found" });
  };
}

beforeEach(() => {
  calls = [];
  setShop("demo");
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the hint goes to the route", () => {
  test("a typed note sends the hint with the text", async () => {
    fakeServer();
    await proposeText("Ada buy rice 45k", "sale");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/propose");
    assert.deepEqual(calls[0].body, { text: "Ada buy rice 45k", hint: "sale" });
  });

  test("a voice note sends the hint with the audio", async () => {
    fakeServer();
    await proposeAudio("QUJD", "wav", "expense");
    assert.deepEqual(calls[0].body, { audioBase64: "QUJD", audioFormat: "wav", hint: "expense" });
  });

  test("with no hint, none is sent (the hint is optional)", async () => {
    fakeServer();
    await proposeText("Ada buy rice 45k");
    await proposeAudio("QUJD");
    assert.deepEqual(calls[0].body, { text: "Ada buy rice 45k" });
    assert.ok(!("hint" in calls[1].body));
  });
});

describe("the typed form", () => {
  test("a sale builds whole-naira fields and an extra payment", () => {
    const out = buildFormPayload("sale", { ...emptyForm(), customer: " Ada ", item: "rice", quantity: "2", unit: "bag", amount: "45,000", amountPaid: "25000" });
    assert.deepEqual(out.fields, { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 45000, amountPaidNaira: 25000 });
  });

  test("price each sends the unit cost and needs a quantity", () => {
    const values = { ...emptyForm(), customer: "Ada", item: "rice", amount: "22500", amountMode: "each" };
    assert.equal(buildFormPayload("sale", values).field, "quantity");
    const ok = buildFormPayload("sale", { ...values, quantity: "2" });
    assert.equal(ok.fields.unitCostNaira, 22500);
    assert.ok(!("amountNaira" in ok.fields));
  });

  test("each kind asks for its own fields", () => {
    assert.deepEqual(buildFormPayload("payment", { ...emptyForm(), customer: "Ada", amount: "10000" }).fields, { type: "payment", customer: "Ada", amountNaira: 10000 });
    assert.deepEqual(buildFormPayload("expense", { ...emptyForm(), category: "transport", amount: "1500", item: "ignored", amountPaid: "5" }).fields, {
      type: "expense",
      category: "transport",
      amountNaira: 1500,
    });
    assert.equal(buildFormPayload("purchase", { ...emptyForm(), item: "rice", quantity: "10", unit: "bag", amount: "300000" }).fields.type, "purchase");
  });

  test("missing or odd values are named, not sent", () => {
    assert.equal(buildFormPayload("sale", { ...emptyForm(), amount: "100" }).field, "customer");
    assert.equal(buildFormPayload("payment", { ...emptyForm(), customer: "Ada" }).field, "amount");
    assert.equal(buildFormPayload("payment", { ...emptyForm(), customer: "Ada", amount: "10.50" }).field, "amount");
    assert.equal(buildFormPayload("payment", { ...emptyForm(), customer: "Ada", amount: "ten" }).field, "amount");
    assert.equal(buildFormPayload("sale", { ...emptyForm(), customer: "Ada", amount: "100", quantity: "1.5" }).field, "quantity");
    assert.equal(buildFormPayload("nope", emptyForm()).field, "type");
  });

  test("submitting reaches the confirm card, and sends nothing else", async () => {
    fakeServer(() => proposal({ source: "form" }));
    const out = await submitRecordForm("sale", { ...emptyForm(), customer: "Ada", item: "rice", quantity: "2", unit: "bag", amount: "45000" }, proposeForm);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/propose-form");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body.amountNaira, 45000);
    // The proposal is what the confirm card shows, with Save ready.
    assert.equal(out.proposal.status, "pending");
    assert.equal(canSave(out.proposal), true);
    const words = describeEntry(out.proposal, 0);
    assert.equal(words.type, "Sale");
    assert.equal(words.destination, "Goes to Sales");
  });

  test("a form with a mistake never calls the route", async () => {
    fakeServer();
    const out = await submitRecordForm("payment", emptyForm(), proposeForm);
    assert.ok(out.error);
    assert.equal(calls.length, 0);
  });

  test("a route error reaches the form as an error", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: "amount is required" }) });
    await assert.rejects(submitRecordForm("sale", { ...emptyForm(), customer: "Ada", amount: "5" }, proposeForm), (err) => err instanceof ApiError && err.status === 400);
  });
});

describe("nothing is saved before Save", () => {
  test("proposing by text, voice and form never calls confirm", async () => {
    fakeServer();
    await proposeText("Ada buy rice 45k", "sale");
    await proposeAudio("QUJD", "wav", "sale");
    await submitRecordForm("expense", { ...emptyForm(), category: "transport", amount: "1500" }, proposeForm);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => !c.path.startsWith("/confirm")));
  });

  test("Save stays locked while something needs checking", () => {
    assert.equal(canSave(proposal()), true);
    assert.equal(canSave(proposal({ flags: ["entry 1: missing customer name"] })), false);
    assert.equal(canSave(proposal({ question: "Which Ada?" })), false);
    assert.equal(canSave(proposal({ entries: [] })), false);
    assert.equal(canSave(proposal({ status: "confirmed" })), false);
    assert.deepEqual(problemsOf(proposal({ flags: ["needs clarification: entry 1: missing customer name"] })), ["Line 1: missing customer name"]);
  });

  test("only an explicit confirm writes, once", async () => {
    fakeServer();
    await proposeText("Ada buy rice 45k");
    assert.equal(calls.filter((c) => c.path.startsWith("/confirm")).length, 0);
    await confirmProposal(7);
    assert.deepEqual(
      calls.map((c) => c.path),
      ["/propose", "/confirm/7"],
    );
  });
});

describe("the confirm card's words", () => {
  test("each entry says its type and where it goes", () => {
    const p = proposal({
      entries: [
        { type: "sale", customer: "Ada", item: "rice", quantity: 2, unit: "bag", amountKobo: 4500000 },
        { type: "payment", customer: "Ada", amountKobo: 2500000 },
        { type: "restock", customer: null, item: "rice", quantity: 10, unit: "bag", amountKobo: 30000000 },
        { type: "expense", customer: null, item: "transport", amountKobo: 150000 },
      ],
      effects: [
        { destination: "Sales" },
        { destination: "Debts" },
        { destination: "Products", stockItem: "rice", stockBefore: 2, stockAfter: 12, stockUnit: "bag", costUnknown: true },
        { destination: "Expenses", negativeStock: false },
      ],
    });
    assert.deepEqual([0, 1, 2, 3].map((i) => describeEntry(p, i).type), ["Sale", "Payment received", "Stock bought", "Expense"]);
    assert.deepEqual([0, 1, 2, 3].map((i) => describeEntry(p, i).destination), [
      "Goes to Sales",
      "Goes to Debts: it changes what the customer owes",
      "Goes to Products: it changes your stock",
      "Goes to Expenses",
    ]);
    assert.equal(describeEntry(p, 2).stock, "Stock of rice: 2 → 12 bag");
    assert.equal(describeEntry(p, 2).notes.length, 1);
  });

  test("an older server with no effects still shows the type", () => {
    const p = proposal({ effects: undefined });
    const w = describeEntry(p, 0);
    assert.equal(w.type, "Sale");
    assert.equal(w.destination, null);
  });

  test("the 'you said X but it sounds like Y' line shows when the route sends it", () => {
    const note = "You said this was an expense, but it sounds like a sale. Saving it as a sale.";
    assert.equal(hintLine(proposal({ hint: "expense", hintNote: note })), note);
    assert.equal(hintLine(proposal()), null);
    assert.equal(hintLine(proposal({ hintNote: "  " })), null);
  });
});

describe("lists refresh after a confirm", () => {
  test("a save tells every open screen once", async () => {
    fakeServer();
    let reloads = 0;
    const stop = onDataChanged(() => reloads++);
    await confirmProposal(7);
    assert.equal(reloads, 1);
    stop();
    await confirmProposal(7);
    assert.equal(reloads, 1);
  });

  test("a note that was already saved changes nothing, so nothing reloads", async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ proposal: proposal({ status: "confirmed" }), recordedIds: [1], alreadyConfirmed: true }) });
    let reloads = 0;
    const stop = onDataChanged(() => reloads++);
    await confirmProposal(7);
    stop();
    assert.equal(reloads, 0);
  });

  test("proposing, and a failed save, do not reload anything", async () => {
    fakeServer();
    let reloads = 0;
    const stop = onDataChanged(() => reloads++);
    await proposeText("Ada buy rice 45k");
    globalThis.fetch = async () => ({ ok: false, status: 410, json: async () => ({ error: "proposal expired" }) });
    await assert.rejects(confirmProposal(7));
    stop();
    assert.equal(reloads, 0);
  });

  test("a listener that stops is not called again", () => {
    let n = 0;
    const stop = onDataChanged(() => n++);
    notifyDataChanged();
    stop();
    notifyDataChanged();
    assert.equal(n, 1);
  });
});
