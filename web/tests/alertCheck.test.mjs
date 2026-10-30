// Web tests for the Check alert screen: card states, the wording rule, the
// save / saw-it-in-my-bank flow, and the waiting limits. Fake fetch, fake data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";

const { ApiError, getUnconfirmed, markSeenInBank, proposePhoto, setShop } = await import("../src/api.js");
const { onDataChanged } = await import("../src/refresh.js");
const A = await import("../src/alertCheck.js");
const { WaitError, canRetry, waitForProposal } = await import("../src/recordWait.js");

const realFetch = globalThis.fetch;
let calls;

beforeEach(() => {
  calls = [];
  setShop("demo");
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeServer(handler) {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^\/api/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method, body });
    const { status, data } = await handler(path, body, init);
    return { ok: status < 400, status, json: async () => data };
  };
}

const fields = (extra = {}) => ({ status: "Successful", date: "2026-10-29", amountKobo: 1200000, amountPhrase: "12,000", sender: "Ada Obi", reference: "REF123", ...extra });
const proposal = (photoCheck, extra = {}) => ({ id: 9, status: "pending", heard: "(photo)", question: null, entries: [], flags: [], photoCheck, ...extra });
const alertProposal = (f, warnings = []) => proposal({ photoType: "payment_alert", fields: f, warnings, matchedCustomer: null });

const clean = alertProposal(fields());
const warned = alertProposal(fields({ status: "Pending" }), ['Status is "Pending", not successful.', "Amount ₦12,000 matches no unpaid sale.", "No reference number found."]);
const unreadable = alertProposal({ status: null, date: null, amountKobo: null, amountPhrase: null, sender: null, reference: null }, ["Some alert fields are missing or unreadable: status, date, amount, sender."]);
const notAlert = proposal({ photoType: "unknown", fields: null, warnings: [], matchedCustomer: null }, { question: "I don't recognise this photo — I can only read payment alerts for now." });

const everyString = (card) => JSON.stringify(card);

describe("card states", () => {
  test("clean: fields in plain rows, 'No warning signs found', can save", () => {
    const c = A.describeCheck(clean);
    assert.equal(c.kind, "clean");
    assert.equal(c.title, "No warning signs found");
    assert.deepEqual(c.rows.map((r) => r.label), ["Sender", "Amount", "Date", "Status", "Reference"]);
    assert.equal(c.rows.find((r) => r.key === "amount").value, "₦12,000");
    assert.equal(c.rows.find((r) => r.key === "sender").value, "Ada Obi");
    assert.deepEqual(c.warnings, []);
    assert.equal(c.canSave, true);
  });

  test("warned: 'Warning signs found', one line each, serious vs caution, still savable", () => {
    const c = A.describeCheck(warned);
    assert.equal(c.kind, "warned");
    assert.equal(c.title, "Warning signs found (3)");
    assert.deepEqual(c.warnings.map((w) => w.severity), ["serious", "caution", "caution"]);
    assert.equal(c.canSave, true);
    assert.equal(A.warningSeverity("Reference X was already used in this shop."), "serious");
    assert.equal(A.warningSeverity("Date 2026-11-02 is in the future."), "serious");
    assert.equal(A.warningSeverity('Sender "Bo" matches no customer.'), "caution");
  });

  test("missing single fields read 'Not shown', not a blank", () => {
    const c = A.describeCheck(alertProposal(fields({ reference: null }), ["No reference number found."]));
    assert.equal(c.rows.find((r) => r.key === "reference").value, "Not shown");
  });

  test("unreadable: says so, no rows, no Save", () => {
    const c = A.describeCheck(unreadable);
    assert.equal(c.kind, "unreadable");
    assert.match(c.title, /could not read/i);
    assert.equal(c.canSave, false);
    assert.deepEqual(c.rows, []);
  });

  test("non-alert: flagged card, no Save, shows the server's reason", () => {
    const c = A.describeCheck(notAlert);
    assert.equal(c.kind, "notAlert");
    assert.equal(c.canSave, false);
    assert.match(c.detail, /can only read payment alerts/);
  });
});

describe("wording rule", () => {
  test("no card ever says verified, genuine or safe; the fixed line is on every card", () => {
    for (const p of [clean, warned, unreadable, notAlert]) {
      const c = A.describeCheck(p);
      assert.doesNotMatch(everyString(c), /verified|genuine|\bsafe\b|\breal\b|\bauthentic/i);
      assert.equal(c.fixedLine, "This is a check, not proof. Confirm in your bank app before releasing goods.");
    }
    assert.equal(A.describeCheck(clean).title.toLowerCase().includes("no warning signs found"), true);
  });

  test("the screen and logic source files never use those words", () => {
    for (const file of ["../src/screens/AlertCheckScreen.jsx", "../src/alertCheck.js"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      // "motion-safe" is a CSS class, not wording.
      assert.doesNotMatch(src, /verified|genuine|(?<![-\w])safe(?![-\w])/i, file);
    }
  });
});

describe("photo handling", () => {
  test("accepts jpeg, png and webp only", () => {
    for (const t of ["image/jpeg", "image/png", "image/webp"]) assert.ok(A.isAcceptedType(t));
    for (const t of ["image/gif", "application/pdf", "image/heic", ""]) assert.ok(!A.isAcceptedType(t));
  });

  test("resize keeps aspect, long side at most 1600, never scales up", () => {
    assert.deepEqual(A.fitWithin(4000, 3000), { width: 1600, height: 1200 });
    assert.deepEqual(A.fitWithin(1000, 3200), { width: 500, height: 1600 });
    assert.deepEqual(A.fitWithin(800, 600), { width: 800, height: 600 });
  });

  test("POST /photo-checks sends jpg base64 and returns the proposal", async () => {
    fakeServer(() => ({ status: 201, data: { proposal: clean } }));
    const p = await proposePhoto("QUJD", "jpg");
    assert.equal(p.id, 9);
    assert.deepEqual(calls[0], { path: "/photo-checks", method: "POST", body: { photoBase64: "QUJD", photoFormat: "jpg" } });
  });
});

describe("waiting, failure and timeout", () => {
  test("stages are calm lines in order; the 25 s line comes third; limit is 40 s", () => {
    assert.deepEqual(A.ALERT_STAGES.slice(0, 2), ["Reading the alert…", "Checking the details…"]);
    assert.match(A.ALERT_STAGES[2], /longer than usual/);
    assert.equal(A.ALERT_STAGE_DELAYS_MS[1], 25_000);
    assert.equal(A.ALERT_TIMEOUT_MS, 40_000);
  });

  test("shows each stage, then times out with a retryable error and aborts the request", async () => {
    const seen = [];
    let aborted = false;
    await assert.rejects(
      waitForProposal(
        (signal) => new Promise((_, rej) => signal.addEventListener("abort", () => ((aborted = true), rej(new Error("abort"))))),
        { onStage: (s) => seen.push(s), stages: A.ALERT_STAGES, delays: [10, 25], timeoutMs: 45 }
      ),
      (err) => err instanceof WaitError && err.kind === "timeout" && canRetry(err)
    );
    assert.deepEqual(seen, A.ALERT_STAGES);
    assert.ok(aborted);
  });

  test("Cancel stops the request and shows no error", async () => {
    const cancel = new AbortController();
    const p = waitForProposal((signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("abort")))), { stages: A.ALERT_STAGES, outer: cancel.signal });
    cancel.abort();
    await assert.rejects(p);
  });

  test("a network failure is a retryable WaitError", async () => {
    fakeServer(() => {
      throw new Error("offline");
    });
    await assert.rejects(waitForProposal((s) => proposePhoto("QUJD", "jpg", s), { stages: A.ALERT_STAGES }), (e) => e instanceof WaitError && e.kind === "network" && canRetry(e));
  });

  test("a server error is a plain message, not retryable", async () => {
    fakeServer(() => ({ status: 400, data: { error: "photoBase64 is required" } }));
    await assert.rejects(waitForProposal((s) => proposePhoto("QUJD", "jpg", s), { stages: A.ALERT_STAGES }), (e) => e instanceof WaitError && e.kind === "api" && !canRetry(e));
  });
});

describe("save and confirm in bank", () => {
  const serverSaving = () =>
    fakeServer((path) => {
      if (path === "/confirm/9") return { status: 200, data: { proposal: clean, recordedIds: { paymentCheckId: 4 }, alreadyConfirmed: false } };
      return { status: 404, data: { error: "not found" } };
    });

  test("Save as unconfirmed confirms through POST /confirm/:id and does not mark seen", async () => {
    serverSaving();
    let marked = 0;
    const out = await A.saveAlert(clean, { mark: async () => marked++ });
    assert.deepEqual(calls.map((c) => c.path), ["/confirm/9"]);
    assert.equal(out.saved, true);
    assert.equal(out.checkId, 4);
    assert.equal(out.seen, false);
    assert.equal(marked, 0);
  });

  test("a warned alert can still be saved", async () => {
    serverSaving();
    const out = await A.saveAlert(warned);
    assert.equal(out.saved, true);
  });

  test("I saw it in my bank marks seen only after the save, with the saved check's id", async () => {
    serverSaving();
    const order = [];
    const out = await A.saveAlert(clean, {
      markSeen: true,
      mark: async (id) => {
        order.push(["mark", id, calls.length]);
      },
    });
    assert.deepEqual(order, [["mark", 4, 1]]); // the confirm call had already happened
    assert.equal(out.seen, true);
  });

  test("a failed save marks nothing and throws", async () => {
    fakeServer(() => ({ status: 410, data: { error: "expired" } }));
    let marked = false;
    await assert.rejects(A.saveAlert(clean, { markSeen: true, mark: async () => (marked = true) }), ApiError);
    assert.equal(marked, false);
  });

  test("the bank tap calls POST /photo-checks/:id/bank-confirm and returns the check", async () => {
    fakeServer((path) => ({ status: 200, data: { check: { id: 4, check_status: "confirmed", seen_at: "2026-10-30T10:00:00Z" } } }));
    const check = await markSeenInBank(4);
    assert.deepEqual(calls[0], { path: "/photo-checks/4/bank-confirm", method: "POST", body: null });
    assert.equal(check.check_status, "confirmed");
  });

  test("save then bank tap end to end: confirm first, then bank-confirm with the saved id", async () => {
    fakeServer((path) =>
      path === "/confirm/9"
        ? { status: 200, data: { proposal: clean, recordedIds: { paymentCheckId: 4 }, alreadyConfirmed: false } }
        : { status: 200, data: { check: { id: 4, check_status: "confirmed" } } }
    );
    const out = await A.saveAlert(clean, { markSeen: true });
    assert.deepEqual(calls.map((c) => c.path), ["/confirm/9", "/photo-checks/4/bank-confirm"]);
    assert.equal(out.seen, true);
  });

  test("a failed bank tap leaves the check saved, gives a plain message, and Try again works", async () => {
    let fail = true;
    fakeServer((path) => {
      if (path === "/confirm/9") return { status: 200, data: { proposal: clean, recordedIds: { paymentCheckId: 4 }, alreadyConfirmed: false } };
      return fail ? { status: 503, data: { error: "down" } } : { status: 200, data: { check: { id: 4, check_status: "confirmed" } } };
    });
    const out = await A.saveAlert(clean, { markSeen: true });
    assert.equal(out.saved, true);
    assert.equal(out.seen, false);
    assert.match(out.seenMessage, /not answering/);
    fail = false;
    assert.equal((await A.markSeenSafely(out.checkId)).seen, true);
  });

  test("the bank tap tells open screens to reload", async () => {
    fakeServer(() => ({ status: 200, data: { check: { id: 4 } } }));
    let reloads = 0;
    const stop = onDataChanged(() => reloads++);
    await markSeenInBank(4);
    stop();
    assert.equal(reloads, 1);
  });

  test("a mark failure other than 'not built' reports the plain error", async () => {
    const out = await A.markSeenSafely(4, async () => {
      throw new ApiError(0, "network");
    });
    assert.equal(out.seen, false);
    assert.match(out.seenMessage, /Cannot reach PocketOga/);
  });
});

describe("unconfirmed list", () => {
  test("loads GET /photo-checks/unconfirmed (oldest first, with ids) into list items", async () => {
    const checks = [
      { id: 3, amount_kobo: 500000, sender: "Ada Obi", alert_date: "2026-10-28", created_at: "2026-10-28T10:00:00.000Z", warnings: ["No reference number found."] },
      { id: 5, amount_kobo: 90000, sender: null, alert_date: null, created_at: "2026-10-29T10:00:00.000Z", warnings: [] },
    ];
    fakeServer(() => ({ status: 200, data: { checks } }));
    const { items } = await getUnconfirmed();
    assert.equal(calls[0].path, "/photo-checks/unconfirmed");
    assert.deepEqual(items.map((i) => [i.id, i.amountKobo, i.customer, i.warned]), [[3, 500000, "Ada Obi", true], [5, 90000, null, false]]);
  });

  test("age counts whole days", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    assert.equal(A.checkAgeDays("2026-10-30T09:00:00Z", now), 0);
    assert.equal(A.checkAgeDays("2026-10-28T09:00:00Z", now), 2);
  });
});
