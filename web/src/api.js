// Every call to the PocketOga backend lives in this file. To move the backend
// or add real auth later, change API_BASE and authHeaders() — nothing else.
// Response shapes are documented next to each call (see server.mjs).

// Dev: "/api" is forwarded to http://localhost:3000 by vite.config.js.
// Production: set VITE_API_BASE at build time (e.g. https://api.example.com).
const API_BASE = (import.meta.env.VITE_API_BASE ?? "/api").replace(/\/$/, "");

// Must match DEMO_SHOP_ID in scripts/seed-demo.mjs.
export const DEMO_SHOP_ID = "demo-shop";

let shopId = null;

// Called once a shop is open. All requests are made as this shop.
export function setShop(id) {
  shopId = id;
}

// Today the server only wants the shop name in x-shop-id. Real auth (a token,
// a session cookie) goes here later.
function authHeaders() {
  return { "x-shop-id": shopId };
}

// An error the UI can show: `status` is the HTTP code (0 = no connection).
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  if (!shopId) throw new ApiError(400, "No shop is open.");
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: { ...authHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `server error ${res.status}`);
  return data;
}

// --- Voice-to-confirm loop ---------------------------------------------------

// POST /propose { text } -> { proposal }
// proposal: { id, status, heard, question, entries[], totals, flags[], promise }
export async function proposeText(text) {
  return (await request("POST", "/propose", { text })).proposal;
}

// POST /propose { audioBase64, audioFormat } -> { proposal }. Format: wav|mp3.
export async function proposeAudio(audioBase64, audioFormat = "wav") {
  return (await request("POST", "/propose", { audioBase64, audioFormat })).proposal;
}

// POST /confirm/:id -> { proposal, recordedIds, alreadyConfirmed }
export function confirmProposal(id) {
  return request("POST", `/confirm/${encodeURIComponent(id)}`);
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

// --- Read-only views ---------------------------------------------------------

// GET /ledger -> { entries: rows ordered by seq, verify }
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

// Turns any error into one plain sentence for the trader.
export function friendlyError(err) {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  switch (err.status) {
    case 0:
      return "Cannot reach PocketOga. Check your connection and try again.";
    case 403:
      return "This note belongs to another shop.";
    case 404:
      return "We could not find that. Please try again.";
    case 409:
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
