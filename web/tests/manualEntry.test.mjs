// Web tests for "Enter it by hand": when it is offered, the checks, naira to
// request conversion, the queue item and how it is sent. Fake data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";

const M = await import("../src/manualEntry.js");
const { buildManualRequest, MANUAL_ROUTE } = await import("../src/manualFormat.js");
const { createConnection } = await import("../src/connection.js");
const { createQueue } = await import("../src/offlineQueue.js");
const { sendItem } = await import("../src/shopQueue.js");
const { queuedRow } = await import("../src/queuedRow.js");
const { setShop } = await import("../src/api.js");

const values = (extra = {}) => ({ ...M.emptyManual(), ...extra });
const ok = (extra) => {
  const out = M.validateManual(values(extra));
  assert.equal(out.error, undefined, out.error);
  return out.entry;
};
const bad = (extra) => {
  const out = M.validateManual(values(extra));
  assert.ok(out.error, "expected an error");
  return out;
};

describe("visibility", () => {
  test("shown only while offline: device offline, or the last request failed", () => {
    const online = createConnection({ isOnline: () => true });
    assert.equal(M.showManualEntry(online.get()), false);
    online.reportFailed();
    assert.equal(M.showManualEntry(online.get()), true);
    online.reportReached();
    assert.equal(M.showManualEntry(online.get()), false);
    const offline = createConnection({ isOnline: () => false });
    assert.equal(M.showManualEntry(offline.get()), true);
    offline.setDeviceOnline(true);
    assert.equal(M.showManualEntry(offline.get()), false); // the button goes; an open form is not tied to this
  });

  test("the entry is on the Record screen only, not in the menu", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    assert.match(read("src/screens/RecordScreen.jsx"), /showManualEntry\(conn\)/);
    assert.doesNotMatch(read("src/App.jsx"), /ManualEntry|manual/i);
    // the form's own open state is not derived from the connection
    assert.doesNotMatch(read("src/ManualEntry.jsx"), /showManualEntry|connection/);
  });
});

describe("typed amounts", () => {
  test("shows ₦ and thousands separators, keeps at most 2 decimals", () => {
    assert.equal(M.showAmountInput("15000"), "₦15,000");
    assert.equal(M.showAmountInput("1500000.5"), "₦1,500,000.5");
    assert.equal(M.showAmountInput("0.505"), "₦0.50");
    assert.equal(M.showAmountInput(""), "");
  });

  test("cleaning drops letters, symbols, a second dot and leading zeros", () => {
    assert.equal(M.cleanAmountInput("₦15,0a0.505"), "1500.50");
    assert.equal(M.cleanAmountInput("1.2.3"), "1.23");
    assert.equal(M.cleanAmountInput("007"), "7");
    assert.equal(M.cleanAmountInput(".5"), "0.5");
    assert.equal(M.cleanAmountInput(""), "");
  });
});

describe("validation", () => {
  test("a plain full-paid sale needs only an amount", () => {
    const e = ok({ amount: "15000" });
    assert.deepEqual(e, { kind: "sale", amountKobo: 1500000, paidKobo: 1500000 });
  });

  test("Paid now follows the amount until the trader changes it; Owes shows automatically", () => {
    const v = values({ amount: "15000" });
    assert.equal(M.paidText(v), "15000");
    assert.equal(M.owesKobo(v), 0);
    const part = values({ amount: "15000", paid: "10000", paidTouched: true });
    assert.equal(M.owesKobo(part), 500000);
    assert.equal(M.owesKobo(values({ amount: "15000", paid: "20000", paidTouched: true })), null); // not readable as an owed amount
    assert.equal(M.owesKobo(values({ kind: "payment", amount: "5" })), null);
  });

  test("amounts must be positive numbers", () => {
    assert.equal(bad({ amount: "" }).field, "amount");
    assert.equal(bad({ amount: "abc" }).field, "amount");
    assert.match(bad({ amount: "0" }).error, /more than ₦0/);
    assert.equal(bad({ amount: "-5" }).field, "amount");
  });

  test("paid cannot be above the amount", () => {
    const out = bad({ amount: "15000", paid: "15000.01", paidTouched: true, customer: "Ada" });
    assert.equal(out.field, "paid");
    assert.match(out.error, /cannot be more than the amount \(₦15,000\)/);
  });

  test("the customer name is optional for every kind: nobody is ever asked for it", () => {
    assert.deepEqual(ok({ amount: "15000", paid: "5000", paidTouched: true }), { kind: "sale", amountKobo: 1500000, paidKobo: 500000 });
    assert.deepEqual(ok({ amount: "15000", paid: "", paidTouched: true }), { kind: "sale", amountKobo: 1500000, paidKobo: 0 }); // all on credit, no name
    assert.deepEqual(ok({ kind: "payment", amount: "5000" }), { kind: "payment", amountKobo: 500000 });
    assert.deepEqual(ok({ kind: "payment", amount: "5000", customer: " Ada " }), { kind: "payment", amountKobo: 500000, customer: "Ada" });
    assert.deepEqual(ok({ kind: "expense", amount: "1200.50" }), { kind: "expense", amountKobo: 120050 });
  });

  test("no error message asks for a customer name", () => {
    const src = readFileSync(new URL("../src/manualEntry.js", import.meta.url), "utf8") + readFileSync(new URL("../src/ManualEntry.jsx", import.meta.url), "utf8");
    assert.doesNotMatch(src, /Who owes you|Type the customer|needed if not fully paid/);
    assert.match(src, /Customer \(optional\)/);
    assert.match(src, /Who paid you\? \(optional\)/);
  });

  test("quantity is a whole number, and only for sales", () => {
    assert.equal(bad({ amount: "100", quantity: "2.5" }).field, "quantity");
    assert.equal(bad({ amount: "100", quantity: "0" }).field, "quantity");
    assert.equal(ok({ amount: "100", quantity: "3" }).quantity, 3);
    assert.equal(ok({ kind: "expense", amount: "100", quantity: "3" }).quantity, undefined);
  });

  test("the note is at most 200 characters", () => {
    assert.equal(ok({ amount: "100", note: "x".repeat(200) }).note.length, 200);
    assert.equal(bad({ amount: "100", note: "x".repeat(201) }).field, "note");
  });

  test("server limits: at most ₦1,000,000, names under 100 characters", () => {
    assert.equal(ok({ kind: "expense", amount: "1000000" }).amountKobo, 100000000);
    const big = bad({ kind: "expense", amount: "1000000.01" });
    assert.equal(big.field, "amount");
    assert.match(big.error, /at most ₦1,000,000/);
    assert.equal(ok({ amount: "100", customer: "x".repeat(100), item: "y".repeat(100) }).customer.length, 100);
    assert.equal(bad({ amount: "100", customer: "x".repeat(101) }).field, "customer");
    assert.equal(bad({ amount: "100", item: "y".repeat(101) }).field, "item");
  });

  test("the amount never goes through floating point", () => {
    // 0.1 + 0.2 style traps: 19.99 stays 1999 kobo, 4.35 * 100 would be 434.99999 in floats
    assert.equal(ok({ kind: "expense", amount: "4.35" }).amountKobo, 435);
    assert.equal(ok({ kind: "expense", amount: "19.99" }).amountKobo, 1999);
    assert.equal(ok({ kind: "expense", amount: "0.07" }).amountKobo, 7);
  });
});

describe("naira to request conversion", () => {
  const meta = { requestId: "req-1", spokenAt: "2026-10-31T08:00:00.000Z" };

  test("a sale: decimal strings, header and occurred_at", () => {
    const req = buildManualRequest({ kind: "sale", customer: "Ada", item: "Rice", quantity: 2, amountKobo: 1500050, paidKobo: 1000000, note: "bag" }, meta);
    assert.equal(req.path, "/proposals/manual");
    assert.equal(req.path, MANUAL_ROUTE);
    assert.deepEqual(req.body, { kind: "sale", customer: "Ada", item: "Rice", quantity: 2, amount_naira: "15000.50", paid_naira: "10000", note: "bag", occurred_at: "2026-10-31T08:00:00.000Z" });
    assert.deepEqual(req.headers, { "x-request-id": "req-1" });
  });

  test("whole naira has no decimals; 5 kobo keeps its zero; unpaid is '0'", () => {
    assert.equal(buildManualRequest({ kind: "expense", amountKobo: 120000 }).body.amount_naira, "1200");
    assert.equal(buildManualRequest({ kind: "expense", amountKobo: 105 }).body.amount_naira, "1.05");
    assert.equal(buildManualRequest({ kind: "sale", amountKobo: 5000, paidKobo: 0, customer: "A" }).body.paid_naira, "0");
  });

  test("payments and expenses carry no paid_naira; empty fields are left out", () => {
    const body = buildManualRequest({ kind: "payment", customer: "Ada", amountKobo: 500000 }, meta).body;
    assert.deepEqual(body, { kind: "payment", customer: "Ada", amount_naira: "5000", occurred_at: meta.spokenAt });
    assert.equal(buildManualRequest({ kind: "expense", amountKobo: 100, paidKobo: 100 }).body.paid_naira, undefined);
  });
});

describe("queue item", () => {
  function setup() {
    const rows = new Map();
    const store = { getAll: async () => [...rows.values()], put: async (i) => void rows.set(i.id, structuredClone(i)), delete: async (id) => void rows.delete(id) };
    const queue = createQueue({ store, send: async () => ({ id: 1 }), isOnline: () => false });
    return { queue, rows };
  }

  test("is saved as a 'manual' item with a request id, the entered time and the checked entry", async () => {
    const { queue, rows } = setup();
    const entry = ok({ amount: "15000", paid: "5000", paidTouched: true, customer: "Ada" });
    const item = await queue.enqueue("manual", { entry }, { requestId: "req-7", spokenAt: "2026-10-31T08:00:00.000Z" });
    assert.equal(item.kind, "manual");
    assert.equal(item.requestId, "req-7");
    assert.equal(item.spokenAt, "2026-10-31T08:00:00.000Z");
    assert.deepEqual(item.payload, { entry: { kind: "sale", customer: "Ada", amountKobo: 1500000, paidKobo: 500000 } });
    assert.equal(item.status, "waiting");
    assert.equal(rows.size, 1);
  });

  test("appears in 'Waiting to send' with a name and a one-line summary, and can be cancelled", async () => {
    const { queue } = setup();
    const entry = ok({ amount: "15000", paid: "5000", paidTouched: true, customer: "Ada" });
    const item = await queue.enqueue("manual", { entry });
    const row = queuedRow(item, () => "09:00");
    assert.equal(row.name, "Entered by hand");
    assert.equal(row.detail, "Sale · ₦15,000 · Ada · owes ₦10,000");
    await queue.cancel(item.id);
    assert.equal(queue.list().length, 0);
  });

  test("a queued entry with no name says 'Customer' until it is sent; an expense says no customer", async () => {
    const { queue } = setup();
    const sale = await queue.enqueue("manual", { entry: ok({ amount: "20000", paid: "0", paidTouched: true }) });
    assert.equal(queuedRow(sale, () => "09:00").detail, "Sale · ₦20,000 · Customer · owes ₦20,000");
    const pay = await queue.enqueue("manual", { entry: ok({ kind: "payment", amount: "5000" }) });
    assert.equal(queuedRow(pay, () => "09:00").detail, "Payment · ₦5,000 · Customer");
    assert.equal(M.manualSummary({ kind: "expense", amountKobo: 120050 }), "Expense · ₦1,200.50");
  });
});

describe("server replies in the queue", () => {
  async function run(error) {
    const { ApiError: E } = await import("../src/api.js");
    const rows = new Map();
    const store = { getAll: async () => [...rows.values()], put: async (i) => void rows.set(i.id, structuredClone(i)), delete: async (id) => void rows.delete(id) };
    let t = 1000;
    const queue = createQueue({ store, send: async () => { throw new E(error.status, error.message); }, isOnline: () => true, now: () => t });
    await queue.enqueue("manual", { entry: { kind: "expense", amountKobo: 100 } });
    await queue.flush();
    return queue.list()[0];
  }

  test("a 400 shows the server's plain message and stops at Needs you", async () => {
    const item = await run({ status: 400, message: "customer is required for a payment" });
    assert.equal(item.status, "needs-you");
    assert.equal(item.error, "Customer is required for a payment");
    assert.equal(queuedRow(item, () => "09:00").status, "Needs you");
  });

  test("a 429, a 409 still being processed and a lost connection are tried again", async () => {
    for (const e of [{ status: 429, message: "slow down" }, { status: 409, message: "that x-request-id is already being processed" }, { status: 0, message: "network" }]) {
      const item = await run(e);
      assert.equal(item.status, "waiting", String(e.status));
      assert.ok(item.nextAt > 1000);
    }
  });
});

describe("hand-entered cards", () => {
  test("no Fix button for source manual; Save and Reject stay, with a one-line explanation", async () => {
    const { readFileSync } = await import("node:fs");
    const card = readFileSync(new URL("../src/screens/ConfirmCard.jsx", import.meta.url), "utf8");
    assert.match(card, /isManual = proposal\.source === "manual"/);
    assert.match(card, /\{!isManual && \(\s*<Button variant="amber"/);
    assert.match(card, /data-part="save"/);
    assert.match(card, /Reject, do not save/);
    assert.match(card, /tap Reject and enter it again/);
  });
});

describe("sending", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => setShop("demo"));
  afterEach(() => (globalThis.fetch = realFetch));

  test("the queue sends it to /proposals/manual with the same request id, and only asks for a proposal", async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ path: String(url).replace(/^\/api/, ""), method: init.method, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 201, json: async () => ({ proposal: { id: 12, status: "pending" } }) };
    };
    const item = { kind: "manual", requestId: "req-9", spokenAt: "2026-10-31T08:00:00.000Z", payload: { entry: { kind: "expense", amountKobo: 120050, item: "Fuel" } } };
    const proposal = await sendItem(item);
    await sendItem(item); // a retry
    assert.equal(proposal.id, 12);
    assert.deepEqual(calls.map((c) => [c.method, c.path]), [["POST", "/proposals/manual"], ["POST", "/proposals/manual"]]);
    assert.ok(calls.every((c) => c.headers["x-request-id"] === "req-9"));
    assert.equal(calls[0].body.amount_naira, "1200.50");
    assert.equal(calls[0].body.occurred_at, "2026-10-31T08:00:00.000Z");
    assert.ok(!calls.some((c) => c.path.startsWith("/confirm"))); // nothing is final until the trader saves
  });

  test("a 200 replay of the same request id is read like a 201", async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ proposal: { id: 12, source: "manual", status: "pending" } }) });
    const p = await sendItem({ kind: "manual", requestId: "req-9", payload: { entry: { kind: "expense", amountKobo: 100 } } });
    assert.equal(p.source, "manual");
  });

  test("the saved message is the one asked for", () => {
    assert.equal(M.MANUAL_SAVED_MESSAGE, "Saved on your phone. It will be sent when you are back online.");
  });
});
