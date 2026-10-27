// A copy of the shop's ledger kept on this device (localStorage), used until
// the server has a ledger list route. Rows have the same shape and the same
// hash chain as ledger.mjs, so the same tamper check works here.
// Append-only: nothing here edits or removes a row (except the demo reset).
import { sha256Hex } from "./sha256.js";

const key = (shopId) => `pocketoga.ledger.${shopId}`;

// Same canonical encoding as computeEntryHash() in ledger.mjs.
export function computeEntryHash(e) {
  const material = JSON.stringify([
    e.shop_id,
    e.seq,
    e.type,
    e.amount_kobo,
    e.customer,
    e.item ?? null,
    e.quantity ?? null,
    e.created_at,
    e.corrects_id ?? null,
    e.prev_hash ?? null,
  ]);
  return sha256Hex(material);
}

export function readLocalLedger(shopId) {
  try {
    return JSON.parse(localStorage.getItem(key(shopId)) ?? "[]");
  } catch {
    return [];
  }
}

function writeLocalLedger(shopId, rows) {
  localStorage.setItem(key(shopId), JSON.stringify(rows));
}

// Adds rows to the end of the chain. Each input: { type, amount_kobo,
// customer, item, quantity, created_at?, server_id? }.
export function appendLocal(shopId, inputs) {
  const rows = readLocalLedger(shopId);
  for (const input of inputs) {
    const prev = rows[rows.length - 1];
    const row = {
      id: (prev?.id ?? 0) + 1,
      shop_id: shopId,
      seq: (prev?.seq ?? 0) + 1,
      prev_hash: prev ? prev.entry_hash : null,
      type: input.type,
      amount_kobo: input.amount_kobo,
      customer: input.customer,
      item: input.item ?? null,
      quantity: input.quantity ?? null,
      corrects_id: null,
      created_at: input.created_at ?? new Date().toISOString(),
      server_id: input.server_id ?? null, // id the server gave it, not hashed
    };
    row.entry_hash = computeEntryHash(row);
    rows.push(row);
  }
  writeLocalLedger(shopId, rows);
}

// Mirrors a confirmed proposal's entries, so the trader sees them right away.
export function mirrorConfirmed(shopId, proposal, recordedIds) {
  appendLocal(
    shopId,
    proposal.entries.map((e, i) => ({
      type: e.type,
      amount_kobo: e.amountKobo,
      customer: e.customer,
      item: e.item,
      quantity: e.quantity,
      server_id: recordedIds?.[i] ?? null,
    }))
  );
}

// Same rules as verifyChain() in ledger.mjs. Returns { ok, count } or
// { ok: false, brokenId, reason }.
export function verifyLocalLedger(rows) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.seq !== i + 1) return { ok: false, brokenId: row.id, reason: "entries are missing or out of order" };
    const expectedPrev = i === 0 ? null : rows[i - 1].entry_hash;
    if (row.prev_hash !== expectedPrev) return { ok: false, brokenId: row.id, reason: "link to the previous entry is broken" };
    if (computeEntryHash(row) !== row.entry_hash) return { ok: false, brokenId: row.id, reason: "entry was changed after saving" };
  }
  return { ok: true, count: rows.length };
}

// --- Demo shop ---------------------------------------------------------------

// Fake data only: invented names, items and amounts.
const DEMO_ENTRIES = [
  { daysAgo: 6, hour: 8, type: "restock", customer: "Alaba Wholesalers", item: "bag of rice", quantity: 10, naira: 520000 },
  { daysAgo: 6, hour: 10, type: "sale", customer: "Mama Bisi", item: "bag of rice", quantity: 2, naira: 118000 },
  { daysAgo: 6, hour: 10, type: "payment", customer: "Mama Bisi", naira: 100000 },
  { daysAgo: 5, hour: 9, type: "sale", customer: "Chinedu", item: "carton of Indomie", quantity: 3, naira: 27000 },
  { daysAgo: 5, hour: 9, type: "payment", customer: "Chinedu", naira: 27000 },
  { daysAgo: 4, hour: 13, type: "sale", customer: "Alhaji Musa", item: "tin of groundnut oil", quantity: 1, naira: 42000 },
  { daysAgo: 3, hour: 11, type: "payment", customer: "Mama Bisi", naira: 18000 },
  { daysAgo: 3, hour: 15, type: "restock", customer: "Oyingbo Depot", item: "carton of Indomie", quantity: 12, naira: 96000 },
  { daysAgo: 2, hour: 10, type: "sale", customer: "Aunty Ngozi", item: "bag of beans", quantity: 1, naira: 65000 },
  { daysAgo: 2, hour: 10, type: "payment", customer: "Aunty Ngozi", naira: 50000 },
  { daysAgo: 1, hour: 16, type: "sale", customer: "Tunde", item: "crate of eggs", quantity: 2, naira: 15000 },
  { daysAgo: 0, hour: 9, type: "payment", customer: "Alhaji Musa", naira: 20000 },
];

export const DEMO_SHOP_NAME = "Mama Nkechi Provisions";

// Creates a fresh demo shop id and fills its local ledger with fake entries.
export function createDemoShop() {
  const shopId = `demo-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  appendLocal(
    shopId,
    DEMO_ENTRIES.map((d, i) => {
      const at = new Date(now);
      at.setDate(at.getDate() - d.daysAgo);
      at.setHours(d.hour, i, 0, 0);
      return { ...d, amount_kobo: d.naira * 100, created_at: at.toISOString() };
    })
  );
  return shopId;
}

// Demo only: secretly change one saved amount, to show the tamper alarm.
export function tamperDemoEntry(shopId) {
  const rows = readLocalLedger(shopId);
  if (rows.length < 2) return;
  rows[1].amount_kobo += 1000000; // +₦10,000 without re-hashing
  writeLocalLedger(shopId, rows);
}

export function clearLocalLedger(shopId) {
  localStorage.removeItem(key(shopId));
}
