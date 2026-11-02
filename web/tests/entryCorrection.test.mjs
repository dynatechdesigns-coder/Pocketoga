// Web tests for editing any entry: the request, the Edit sheet's checks, which
// rows show Edit and the Corrected tag, plain refusals, and the offline queue.
// Fake data only; screens are checked from their source (no browser here).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const E = await import("../src/entryCorrection.js");
const { ApiError, proposeEntryCorrection, setShop } = await import("../src/api.js");
const { queuedRow } = await import("../src/queuedRow.js");
const { sendItem } = await import("../src/shopQueue.js");
const { createQueue } = await import("../src/offlineQueue.js");

const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const ledger = src("screens/LedgerScreen.jsx");

const row = (o) => ({ id: 1, seq: 1, type: "sale", customer: "Customer 1", item: "rice", quantity: null, unit: null, amount_kobo: 630000, created_at: "2026-10-30T10:00:00.000Z", corrects_id: null, canCorrect: true, wasCorrected: false, currentVersionId: o?.id ?? 1, ...o });

describe("the request", () => {
  test("POST /entries/:id/correct with the request id and only the changes", () => {
    const req = E.buildCorrectionRequest(7, { amountKobo: 6300000 }, { requestId: "r-1" });
    assert.equal(req.path, "/entries/7/correct");
    assert.deepEqual(req.body, { amountKobo: 6300000 });
    assert.deepEqual(req.headers, { "x-request-id": "r-1" });
    assert.equal(E.buildCorrectionRequest(7, {}).headers, undefined);
  });

  test("goes out as a POST with the app's sign-in and gives back the proposal", async () => {
    setShop("shop-1", "tok");
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ proposal: { id: "p1", entries: [] } }), { status: 201 });
    };
    try {
      const p = await proposeEntryCorrection(7, { amountKobo: 6300000 }, undefined, { requestId: "r-1" });
      assert.equal(p.id, "p1");
      assert.match(calls[0].url, /\/entries\/7\/correct$/);
      assert.equal(calls[0].init.method, "POST");
      assert.equal(calls[0].init.headers["x-request-id"], "r-1");
      assert.deepEqual(JSON.parse(calls[0].init.body), { amountKobo: 6300000 });
    } finally {
      globalThis.fetch = real;
      setShop(null);
    }
  });
});

describe("which rows show Edit", () => {
  test("only when the backend says canCorrect", () => {
    assert.equal(E.canEdit(row({ canCorrect: true })), true);
    assert.equal(E.canEdit(row({ canCorrect: false })), false);
    assert.equal(E.canEdit({ id: 3 }), false); // an older server says nothing
  });

  test("every row in the list that can be corrected gets a pencil, not only the newest (44px tap target)", () => {
    assert.match(ledger, /canEdit\(e\) && \(\s*<button\s+data-part="edit-entry"/);
    assert.doesNotMatch(ledger, /fixableEntryId|fixableId/);
    assert.match(ledger, /data-part="edit-entry"[^]*?min-h-11 min-w-11 shrink-0/);
    assert.match(ledger, /<Pencil aria-hidden="true" \/>/);
  });

  test("only the current version is listed: an entry a later correction replaced is left out", () => {
    const original = row({ id: 1, canCorrect: false, wasCorrected: true, currentVersionId: 2 });
    const fixed = row({ id: 2, seq: 2, type: "correction", corrects_id: 1, amount_kobo: 6300000, canCorrect: true, wasCorrected: false, currentVersionId: 2 });
    const other = row({ id: 3, seq: 3 });
    assert.deepEqual(E.currentEntries([original, fixed, other]).map((e) => e.id), [2, 3]);
    assert.deepEqual(E.currentEntries([{ id: 1 }, { id: 2 }]).map((e) => e.id), [1, 2]); // older server: all rows
  });
});

describe("the Corrected tag", () => {
  const original = row({ id: 1, canCorrect: false, wasCorrected: true, currentVersionId: 2 });
  const fixed = row({ id: 2, seq: 2, type: "correction", corrects_id: 1, amount_kobo: 6300000, created_at: "2026-10-30T10:00:00.000Z" });

  test("tapping it can say 'Was ₦6,300, now ₦63,000' in plain words", () => {
    assert.equal(E.wasNowLine(fixed, [original, fixed]), "Was ₦6,300, now ₦63,000");
  });

  test("also says what else changed: name, item, date", () => {
    const f = row({ id: 2, corrects_id: 1, amount_kobo: 6300000, customer: "Ada", item: "beans", created_at: "2026-10-28T10:00:00.000Z" });
    const line = E.wasNowLine(f, [original, f]);
    assert.match(line, /^Was ₦6,300, now ₦63,000; /);
    assert.match(line, /name was Customer 1, now Ada/);
    assert.match(line, /item was rice, now beans/);
    assert.match(line, /date was Fri 30 Oct, now Wed 28 Oct/);
  });

  test("nothing to compare means no line", () => {
    assert.equal(E.wasNowLine(row({ corrects_id: null }), []), null);
  });

  test("the row shows a quiet tag that opens the line; 44px tall", () => {
    assert.match(ledger, /data-part="corrected-tag"[^]*?min-h-11/);
    assert.match(ledger, /data-part="was-now"/);
    assert.match(ledger, /wasNowLine\(e, all\)/);
  });
});

describe("the Edit sheet", () => {
  const entry = row({ amount_kobo: 630000, customer: "Customer 1", item: "rice", created_at: "2026-10-30T10:00:00.000Z" });
  const start = E.editStart(entry, "shop-1");
  const opts = { today: "2026-11-01", nowMs: Date.parse("2026-11-01T09:00:00Z") };

  test("starts with the amount, item, label and date of the entry", () => {
    assert.deepEqual(start, { amount: "6300", item: "rice", customer: "Customer 1", date: "2026-10-30" });
    assert.equal(E.editStart(row({ customer: "shop-1" }), "shop-1").customer, "");
  });

  test("sends only what changed, amounts as whole kobo", () => {
    assert.deepEqual(E.editChanges(start, { ...start, amount: "63000" }, opts), { changes: { amountKobo: 6300000 } });
    assert.deepEqual(E.editChanges(start, { ...start, customer: " Ada ", item: "" }, opts).changes, { customer: "Ada", item: null });
  });

  test("a changed date becomes a time that is not in the future", () => {
    assert.equal(E.editChanges(start, { ...start, date: "2026-10-28" }, opts).changes.date, "2026-10-28T11:00:00.000Z");
    assert.equal(E.editChanges(start, { ...start, date: "2026-11-01" }, opts).changes.date, "2026-11-01T09:00:00.000Z");
    assert.match(E.editChanges(start, { ...start, date: "2026-11-02" }, opts).error, /cannot be in the future/);
  });

  test("plain checks: empty, bad or zero amount, nothing changed", () => {
    assert.match(E.editChanges(start, { ...start, amount: "" }, opts).error, /Type the amount/);
    assert.match(E.editChanges(start, { ...start, amount: "abc" }, opts).error, /in numbers/);
    assert.match(E.editChanges(start, { ...start, amount: "0" }, opts).error, /more than ₦0/);
    assert.match(E.editChanges(start, start, opts).error, /Change at least one detail/);
  });

  test("the sheet has Amount, Item, Customer label and Date, and the button 'Save changes'", () => {
    for (const id of ["edit-amount", "edit-item", "edit-customer", "edit-date"]) assert.match(ledger, new RegExp(`id="${id}"`));
    assert.match(ledger, /type="date" value=\{v\.date\} max=\{lagosToday\(\)\}/);
    assert.match(ledger, /Save changes/);
  });

  test("Save changes only asks for a proposal; the confirm card does the saving", () => {
    const form = ledger.slice(ledger.indexOf("function EditForm"));
    assert.match(form, /onProposed\(await proposeEntryCorrection\(entry\.id, out\.changes\)\)/);
    assert.doesNotMatch(form, /confirmProposal/);
    assert.match(ledger, /<ConfirmCard/);
  });

  test("fits 320px: one shrinking column, wrapping text, the date box can shrink", () => {
    assert.match(ledger, /data-part="edit-form"/);
    assert.match(ledger, /className="grid min-w-0 gap-4" onSubmit=\{submit\} noValidate data-part="edit-form"/);
    assert.match(ledger, /\$\{inputClass\} min-w-0/);
    assert.match(ledger, /data-part="edit-error"[^>]*\[overflow-wrap:anywhere\]/);
  });
});

describe("plain refusals", () => {
  test("the server's plain message is shown (a sale with payments, a future date)", () => {
    assert.equal(E.correctionError(new ApiError(409, "this sale already has payments, so only the name can change")), "This sale already has payments, so only the name can change.");
    assert.equal(E.correctionError(new ApiError(400, "date must not be in the future")), "Date must not be in the future.");
  });

  test("developer words never show", () => {
    assert.equal(E.correctionError(new ApiError(400, "invalid_field amountKobo")), "This entry cannot be changed that way. Check the details and try again.");
    assert.equal(E.correctionError(new ApiError(409, "server error 409")), "This entry cannot be changed that way. Check the details and try again.");
    assert.equal(E.correctionError(new ApiError(500, "boom")), E.EDIT_FAILED_MESSAGE);
    assert.match(E.correctionError(new ApiError(0, "network")), /Cannot reach PocketOga/);
    assert.match(E.correctionError(new ApiError(404, "entry not found")), /could not find that entry/);
  });
});

describe("offline: the edit is queued and shown in Waiting to send", () => {
  test("a queued edit has its own row text", () => {
    const item = { id: "q1", kind: "correction", status: "waiting", spokenAt: "2026-11-01T08:00:00Z", payload: { entryId: 7, changes: { amountKobo: 6300000, customer: "Ada" } } };
    const r = queuedRow(item, () => "09:00");
    assert.equal(r.name, "Edit to an entry");
    assert.equal(r.detail, "Edit · new amount ₦63,000 · Ada");
    assert.equal(r.stuck, false);
  });

  test("it is sent as POST /entries/:id/correct with the item's own request id", async () => {
    setShop("shop-1", "tok");
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ proposal: { id: "p9" } }), { status: 201 });
    };
    try {
      const out = await sendItem({ kind: "correction", requestId: "rq-5", spokenAt: "x", payload: { entryId: 7, changes: { item: null } } });
      assert.equal(out.id, "p9");
      assert.match(calls[0].url, /\/entries\/7\/correct$/);
      assert.equal(calls[0].init.headers["x-request-id"], "rq-5");
    } finally {
      globalThis.fetch = real;
      setShop(null);
    }
  });

  test("a refused queued edit stops at 'Needs you' with the server's plain message", async () => {
    const rows = new Map();
    const store = { getAll: async () => [...rows.values()], put: async (i) => void rows.set(i.id, structuredClone(i)), delete: async (id) => void rows.delete(id) };
    const queue = createQueue({
      store,
      send: async () => {
        throw new ApiError(409, "this sale already has payments, so only the name can change");
      },
      now: () => 1000,
    });
    await queue.load();
    const item = await queue.enqueue("correction", { entryId: 7, changes: { amountKobo: 100 } });
    await queue.flush();
    const [after] = queue.list();
    assert.equal(after.id, item.id);
    assert.equal(after.status, "needs-you");
    assert.equal(after.error, "This sale already has payments, so only the name can change.");
  });

  test("the sheet queues when the device is offline or the signal drops while sending; Waiting to send lists it", () => {
    const form = ledger.slice(ledger.indexOf("function EditForm"));
    assert.match(form, /isOffline\(connection\.get\(\)\)/);
    assert.match(form, /queue\.enqueue\(CORRECTION_KIND, \{ entryId: entry\.id, changes \}/);
    assert.match(form, /err\?\.status !== 0\) throw err;/);
    assert.match(src("WaitingToSend.jsx"), /correction: \["Edit to an entry", Pencil\]/);
    assert.match(ledger, /data-part="edit-queued"/);
  });
});

describe("a corrected entry shows its current amount", () => {
  const original = row({ id: 1, seq: 1, amount_kobo: 4500000, canCorrect: false, wasCorrected: true, currentVersionId: 2, correctedById: 2 });
  const fixed = row({ id: 2, seq: 2, type: "correction", corrects_id: 1, amount_kobo: 4600000, canCorrect: true, wasCorrected: false, currentVersionId: 2, correctedById: null });
  const other = row({ id: 3, seq: 3, amount_kobo: 100000 });
  const all = [original, fixed, other];

  test("the current amount counts, and 'was' is the amount before", () => {
    assert.equal(E.currentOf(original, all).amount_kobo, 4600000);
    assert.equal(E.wasKobo(fixed, all), 4500000);
    assert.equal(E.wasKobo(other, all), null);
    assert.equal(E.wasKobo(row({ id: 4, corrects_id: 1, amount_kobo: 4500000 }), all), null); // amount did not change
  });

  test("a chain of corrections ends at the last one", () => {
    const third = row({ id: 5, seq: 4, type: "correction", corrects_id: 2, amount_kobo: 4700000, currentVersionId: 5 });
    const chain = [{ ...original, currentVersionId: 5 }, { ...fixed, canCorrect: false, wasCorrected: true, currentVersionId: 5, correctedById: 5 }, third];
    assert.equal(E.currentOf(chain[0], chain).amount_kobo, 4700000);
    assert.deepEqual(E.currentEntries(chain).map((e) => e.id), [5]);
  });

  test("lists keep one row per entry at its current version, so rows match the totals", () => {
    const rows = E.currentRows(all, (e) => e.type === "sale");
    assert.deepEqual(rows.map((r) => [r.entry.id, r.entry.amount_kobo, r.wasKobo, r.corrected, r.entry.type]), [[2, 4600000, 4500000, true, "sale"], [3, 100000, null, false, "sale"]]);
    assert.equal(rows.reduce((sum, r) => sum + r.entry.amount_kobo, 0), 4700000); // what the server's effective total counts
  });

  test("an older server (no canCorrect) still shows only the current row", () => {
    const old1 = { id: 1, seq: 1, type: "sale", amount_kobo: 4500000, corrects_id: null, correctedById: 2 };
    const old2 = { id: 2, seq: 2, type: "correction", amount_kobo: 4600000, corrects_id: 1, correctedById: null };
    assert.deepEqual(E.currentEntries([old1, old2]).map((e) => e.id), [2]);
    assert.equal(E.currentRows([old1, old2], (e) => e.type === "sale")[0].entry.amount_kobo, 4600000);
  });

  const salesScreen = src("SalesScreen.jsx".replace(/^/, "screens/"));
  test("Money-style lists: current amount large, 'was ₦45,000' small, the Corrected tag, never a crossed-out old amount", () => {
    for (const [name, text] of [["Ledger", ledger], ["Sales", salesScreen]]) {
      assert.doesNotMatch(text, /line-through/, name);
      assert.match(text, /data-part="was-amount"/, name);
      assert.match(text, /was \{formatKobo\(was\)\}/, name);
      assert.match(text, /text-lg font-extrabold/, name);
    }
    assert.match(salesScreen, /Pill tone="slate">Corrected</);
    assert.match(salesScreen, /currentRows\(ledger\.data\.entries/);
    assert.match(ledger, /Pill tone="slate">Corrected</);
  });

  test("the 'was' line wraps inside the row on a 320px phone", () => {
    assert.match(ledger, /flex min-w-0 flex-wrap items-center gap-x-2/);
    assert.match(salesScreen, /grid justify-items-end gap-0\.5/);
  });
});
