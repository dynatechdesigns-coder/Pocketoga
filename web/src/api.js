// Every call to the PocketOga backend lives in this file. To move the backend
// or add real auth later, change API_BASE and authHeaders() — nothing else.
// Response shapes are documented next to each call (see server.mjs).

// Dev: "/api" is forwarded to http://localhost:3000 by vite.config.js.
// Production: set VITE_API_BASE at build time (e.g. https://api.example.com).
// The `?.` keeps this module importable from plain node (the web checks),
// where import.meta.env does not exist.
const API_BASE = (import.meta.env?.VITE_API_BASE ?? "/api").replace(/\/$/, "");

// The shop scripts/seed-demo.mjs fills with fake data.
export const DEMO_SHOP_ID = "demo";

import { connection } from "./connection.js";
import { buildManualRequest } from "./manualFormat.js";
import { buildCorrectionRequest } from "./entryCorrection.js";
import { csvPath } from "./monthlyCsv.js";
import { notifyDataChanged } from "./refresh.js";

let shopId = null;
let token = null;

// Called once a shop is open. All requests are made as this shop; a real shop
// also carries its session token. The demo shop is public and sends none.
export function setShop(id, sessionToken = null) {
  shopId = id;
  token = id === DEMO_SHOP_ID ? null : sessionToken;
}

function authHeaders() {
  return { "x-shop-id": shopId, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

// Fired when the server turns a real shop's token away (expired or revoked);
// Root listens and sends the trader back to the login.
export const SESSION_ENDED = "pocketoga:session-ended";

// How long a screen's data request may take before it counts as a lost
// connection (a weak signal otherwise leaves the screen loading for ever).
export const GET_TIMEOUT_MS = 20_000;

// The shop the app is open for (the saved-data store keys on it).
export const getShopId = () => shopId;

// An error the UI can show: `status` is the HTTP code (0 = no connection).
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// How many requests are running right now; the background refresh waits for 0.
let running = 0;
export const requestsRunning = () => running;

async function request(method, path, body, signal, extraHeaders) {
  if (!shopId) throw new ApiError(400, "No shop is open.");
  running++;
  try {
    return await send(method, path, body, signal, extraHeaders);
  } finally {
    running--;
  }
}

async function send(method, path, body, signal, extraHeaders) {
  let res;
  // A read with no signal of its own gets a time limit.
  let timer = null;
  let timedOut = false;
  if (method === "GET" && !signal) {
    const controller = new AbortController();
    signal = controller.signal;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, GET_TIMEOUT_MS);
  }
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: { ...authHeaders(), ...(extraHeaders ?? {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    // A Cancel (AbortError) says nothing about the connection; the timeout
    // of a proposal reports itself in waitForProposal.
    if (err?.name !== "AbortError" || timedOut) connection.reportFailed();
    throw new ApiError(0, timedOut ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
  connection.reportReached();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && shopId !== DEMO_SHOP_ID) window.dispatchEvent(new Event(SESSION_ENDED));
    throw new ApiError(res.status, data.error ?? `server error ${res.status}`);
  }
  return data;
}

// GET /reports/monthly.csv?month=YYYY-MM -> the CSV as a Blob (see monthlyCsv.js).
// Same sign-in as every other request. `no-store`: the browser keeps no copy,
// and the service worker never touches /api.
export async function getMonthlyCsv(month) {
  if (!shopId) throw new ApiError(400, "No shop is open.");
  let res;
  try {
    res = await fetch(API_BASE + csvPath(month), { method: "GET", headers: authHeaders(), cache: "no-store" });
  } catch {
    connection.reportFailed();
    throw new ApiError(0, "network");
  }
  connection.reportReached();
  if (!res.ok) {
    if (res.status === 401 && shopId !== DEMO_SHOP_ID) window.dispatchEvent(new Event(SESSION_ENDED));
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? `server error ${res.status}`);
  }
  return res.blob();
}

// --- Login ---------------------------------------------------------------------

// POST /session { shop, code } (no headers) -> 201 { token, shop_id, expires_at }
// 400 missing field; 401 wrong, used or expired code; 429 too many wrong guesses.
export async function login(shop, code) {
  let res;
  try {
    res = await fetch(API_BASE + "/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shop, code }),
    });
  } catch {
    throw new ApiError(0, "network");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `server error ${res.status}`);
  return data;
}

// DELETE /session (Bearer) -> { revoked: true }. Best effort: the trader is
// logged out on this device whether or not the server could be reached.
export async function logout(sessionToken) {
  try {
    await fetch(API_BASE + "/session", { method: "DELETE", headers: { Authorization: `Bearer ${sessionToken}` } });
  } catch {
    // offline: the token still expires on its own
  }
}

// --- Voice-to-confirm loop ---------------------------------------------------

// `hint` (optional): sale | payment | purchase | expense, the kind of note the
// trader said they were recording. It only guides the reading; when the note
// clearly says something else the proposal's hintNote says so.
const withHint = (body, hint) => (hint ? { ...body, hint } : body);

// `meta` ({ requestId, spokenAt }) rides on every propose call: the client's
// request id (header x-request-id, the same on every retry of one note) and
// the ISO time it was spoken or typed (body field spokenAt). Both are
// optional; a server that does not know them ignores them, and nothing here
// depends on them for correctness.
const withSpoken = (body, meta) => (meta?.spokenAt ? { ...body, spokenAt: meta.spokenAt } : body);
const metaHeaders = (meta) => (meta?.requestId ? { "x-request-id": meta.requestId } : undefined);

// POST /propose { text, hint? } -> { proposal }
// proposal: { id, status, heard, question, entries[], totals, flags[], promise,
//   effects[], source, hint, hintNote }
export async function proposeText(text, hint, signal, meta) {
  return (await request("POST", "/propose", withSpoken(withHint({ text }, hint), meta), signal, metaHeaders(meta))).proposal;
}

// POST /propose { audioBase64, audioFormat, hint? } -> { proposal }. Format: wav|mp3.
export async function proposeAudio(audioBase64, audioFormat = "wav", hint, signal, meta) {
  return (await request("POST", "/propose", withSpoken(withHint({ audioBase64, audioFormat }, hint), meta), signal, metaHeaders(meta))).proposal;
}

// POST /proposals/manual (format in manualFormat.js) -> { proposal }. A record
// entered by hand while offline, sent from the queue with its own request id
// and the time it was entered (occurred_at). The trader still checks and saves.
export async function proposeManual(entry, signal, meta) {
  const req = buildManualRequest(entry, meta);
  return (await request("POST", req.path, req.body, signal, req.headers)).proposal;
}

// POST /propose-form <fields from recordForm.js> -> 201 { proposal }. No model
// call; the same proposal object, checked by the same code, saved only by
// POST /confirm/:id.
export async function proposeForm(fields) {
  return (await request("POST", "/propose-form", fields)).proposal;
}

// POST /feedback (format in feedbackFormat.js) -> 201 { ok, text? }. Sent live,
// never queued: on any error the form keeps what was typed.
export function sendFeedback(req, signal) {
  return request("POST", req.path, req.body, signal);
}

// POST /confirm/:id -> { proposal, recordedIds, alreadyConfirmed }
// A new save tells every open screen to reload its numbers.
export async function confirmProposal(id) {
  const res = await request("POST", `/confirm/${encodeURIComponent(id)}`);
  if (!res.alreadyConfirmed) notifyDataChanged();
  return res;
}

// POST /fix/:id { correctionText } -> { proposal }
export async function fixProposal(id, correctionText) {
  return (await request("POST", `/fix/${encodeURIComponent(id)}`, { correctionText })).proposal;
}

// POST /reject/:id -> { proposal }
export async function rejectProposal(id) {
  return (await request("POST", `/reject/${encodeURIComponent(id)}`)).proposal;
}

// GET /proposals/:id -> { proposal }
export async function getProposal(id) {
  return (await request("GET", `/proposals/${encodeURIComponent(id)}`)).proposal;
}

// --- Check alert ---------------------------------------------------------------

// POST /photo-checks { photoBase64, photoFormat: png|jpg|jpeg } -> 201 { proposal }
// proposal.photoCheck: { photoType: payment_alert|unknown, fields: { status,
//   date, amountKobo, amountPhrase, sender, reference } | null, warnings[],
//   matchedCustomer }. Confirming it (POST /confirm/:id) records an
//   unconfirmed payment check, never a ledger entry; recordedIds is
//   { paymentCheckId }. The photo itself is never stored.
export async function proposePhoto(photoBase64, photoFormat = "jpg", signal, meta) {
  return (await request("POST", "/photo-checks", withSpoken({ photoBase64, photoFormat }, meta), signal, metaHeaders(meta))).proposal;
}

// GET /photo-checks/unconfirmed -> { checks[]: { id, amount_kobo, sender,
//   alert_date, created_at, warnings[] } }, oldest first. Returned here as
//   items: { id, amountKobo, customer (the sender), createdAt, warned }.
export async function getUnconfirmed() {
  const { checks = [] } = await request("GET", "/photo-checks/unconfirmed");
  return {
    items: checks.map((c) => ({
      id: c.id,
      amountKobo: c.amount_kobo,
      customer: c.sender ?? null,
      createdAt: c.created_at,
      warned: (c.warnings ?? []).length > 0,
    })),
  };
}

// POST /photo-checks/:id/bank-confirm -> { check } with check_status
// "confirmed" and seen_at. Idempotent (confirming twice returns the same
// check); 404 unknown id, 403 another shop's check.
export async function markSeenInBank(id) {
  const res = await request("POST", `/photo-checks/${encodeURIComponent(id)}/bank-confirm`);
  notifyDataChanged();
  return res.check;
}

// --- Read-only views ---------------------------------------------------------

// GET /ledger -> { entries: rows ordered by seq, verify }
// entries[].correctedById: id of the correction that replaced it, or null
// (older servers leave it out; corrects_id links are used then).
// verify: { ok: true, count } or { ok: false, brokenId, index, reason }
export function getLedger() {
  return request("GET", "/ledger");
}

// GET /debts -> { debts, chase }
// debts[]: { customer, owedKobo, salesKobo, paidKobo, oldestUnpaidAgeDays, lastPaymentAt }
// chase[]: { customer, owedKobo, ageDays, broken, score } — ranked, debtors only
export function getDebts() {
  return request("GET", "/debts");
}

// GET /promises -> { promises[]: { id, customer, amount_kobo, due_date,
//   status: open|kept|broken|cancelled, created_at, resolved_at, paid_kobo } }
export async function getPromises() {
  return (await request("GET", "/promises")).promises;
}

// GET /report -> { report: { owed: { totalKobo, customers }, overdue: { amountKobo },
//   broken: { count, amountKobo }, shortfalls[], noStockRecord, belowCost: { items[], skippedItems } } }
export async function getReport() {
  return (await request("GET", "/report")).report;
}

// --- Routes being built (see the README for the dev-only stand-in server) -------

// A 404 from these means the server does not have the route yet. The app then
// shows "not available yet"; it never substitutes made-up numbers.
export const isNotBuilt = (err) => err instanceof ApiError && err.status === 404 && err.message === "not built";

async function newRoute(method, path, body) {
  try {
    return await request(method, path, body);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && /^not found$/i.test(err.message)) throw new ApiError(404, "not built");
    throw err;
  }
}

const periodQuery = (period) => `?period=${encodeURIComponent(period)}`;

// GET /profit?period=today|week|month|year -> { period, from, to, salesKobo,
//   collectedKobo, cogsKobo, expensesKobo, estimatedProfitKobo (signed),
//   result: profit|loss|break_even, resultKobo (>= 0), owedKobo, missing_cost_items,
//   series[]: { label, salesKobo, cogsKobo, expensesKobo, profitKobo } }
export function getProfit(period) {
  return newRoute("GET", "/profit" + periodQuery(period));
}

// GET /expenses?period=... -> { expenses[]: { id, createdAt, category, payee, amountKobo },
//   byCategory[]: { category, amountKobo } }
export function getExpenses(period) {
  return newRoute("GET", "/expenses" + periodQuery(period));
}

// GET /products -> { products[]: { id, name, unit, sellPriceKobo, costPriceKobo, stockOnHand, lowStock } }
export async function getProducts() {
  return (await newRoute("GET", "/products")).products;
}

// POST /products/:id { sellPriceKobo?, costPriceKobo? } -> { product }
export async function setProductPrices(id, prices) {
  return (await newRoute("POST", `/products/${encodeURIComponent(id)}`, prices)).product;
}

// GET /customers -> { customers[]: { id, name, phone, owedKobo, lastActivityAt } }
export async function getCustomers() {
  return (await newRoute("GET", "/customers")).customers;
}

// POST /customers { name, phone?, consent? } -> { customer }. Create or update
// by name. A phone needs consent: true (the form asks for it), so the two are
// sent together; with no phone only the name goes.
export async function saveCustomer({ name, phone }) {
  const body = phone ? { name, phone, consent: true } : { name };
  return (await newRoute("POST", "/customers", body)).customer;
}

// POST /customers/rename { from, to } -> { renamed, customer }. Corrects a
// label (like "Customer 1") everywhere; 404 unknown, 409 name already used.
export function renameCustomer(from, to) {
  return newRoute("POST", "/customers/rename", { from, to });
}

// POST /ledger/:id/correct { amountKobo?, customer?, item?, quantity?, unit?, reason }
//   -> { entry, verify }. Adds a correction entry; the original is never edited.
export function correctEntry(id, changes) {
  return newRoute("POST", `/ledger/${encodeURIComponent(id)}/correct`, changes);
}

// POST /correct-last { entryId?, amountKobo?, customer?, item?, quantity?,
//   unit?, reason } -> 201 { proposal }. Proposes a correction of the shop's
// latest entry; the trader confirms it with POST /confirm/:id like any other
// proposal. Omitted values inherit the original; explicit null clears item,
// quantity and unit. Always pass entryId so a newer entry landing mid-tap
// fails loudly instead of fixing the wrong entry.
export async function proposeCorrection(changes) {
  return (await request("POST", "/correct-last", changes)).proposal;
}

// POST /entries/:id/correct (see entryCorrection.js) -> { proposal }. A correction
// of any past entry; nothing is saved until the trader confirms the proposal.
export async function proposeEntryCorrection(entryId, changes, signal, meta) {
  const req = buildCorrectionRequest(entryId, changes, meta);
  return (await request("POST", req.path, req.body, signal, req.headers)).proposal;
}

// A lost connection or a timeout (no answer from the server at all), as
// opposed to a server that answered with an error.
export const isNetworkFailure = (err) => err instanceof ApiError && err.status === 0;

// Turns any error into one plain sentence for the trader.
export function friendlyError(err) {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  switch (err.status) {
    case 0:
      return "Cannot reach PocketOga. Check your connection and try again.";
    case 403:
      // "that product belongs to another shop": say which thing it was.
      return /^that (product|customer) /i.test(err.message) ? err.message.charAt(0).toUpperCase() + err.message.slice(1) + "." : "This note belongs to another shop.";
    case 404:
      if (err.message === "not built") return "This part needs the newer PocketOga server, which is still being built.";
      // POST /correct-last on an empty shop.
      if (/no entries to correct/i.test(err.message)) return "There is nothing to correct yet.";
      return "We could not find that. Please try again.";
    case 409:
      // POST /correct-last and confirming one: the entry was fixed
      // elsewhere, or a newer entry landed first.
      if (/already corrected/i.test(err.message)) return "This entry was already corrected.";
      if (/latest/i.test(err.message)) return "A newer entry came in first. Only the latest entry can be fixed.";
      return err.message.includes("confirmed")
        ? "This note is already saved. To change it, record a new note."
        : "This note was rejected. Please record it again.";
    case 410:
      return "This note is more than 30 minutes old. Please record it again.";
    case 413:
      return "That recording is too long. Keep it under 2 minutes.";
    case 500:
    case 502:
    case 503:
      return "PocketOga is not answering right now. Please try again in a moment.";
    default:
      return err.message.charAt(0).toUpperCase() + err.message.slice(1);
  }
}
