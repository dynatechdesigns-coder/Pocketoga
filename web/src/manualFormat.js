// The request for a hand-entered record, in one place. If the backend reports a
// different format, this is the only file to change.
//
//   POST /proposals/manual
//   header  x-request-id: <the item's request id, the same on every retry>
//   body    { kind: "sale" | "payment" | "expense", customer?, item?, quantity?,
//             amount_naira, paid_naira?, note?, occurred_at? }
//   amount_naira, paid_naira: decimal strings with at most 2 decimals ("15000",
//   "15000.50"), made from whole kobo with integer maths only.
//   occurred_at: the ISO time the trader entered it.
//   response: a normal proposal ({ proposal }), the same shape as /propose.
import { nairaInput } from "./format.js";

export const MANUAL_ROUTE = "/proposals/manual";

// entry: the checked form (see manualEntry.js): { kind, customer?, item?,
// quantity?, amountKobo, paidKobo?, note? }. meta: { requestId, spokenAt }.
export function buildManualRequest(entry, meta = {}) {
  const body = { kind: entry.kind };
  if (entry.customer) body.customer = entry.customer;
  if (entry.item) body.item = entry.item;
  if (Number.isInteger(entry.quantity)) body.quantity = entry.quantity;
  body.amount_naira = nairaInput(entry.amountKobo);
  if (entry.kind === "sale" && Number.isInteger(entry.paidKobo)) body.paid_naira = nairaInput(entry.paidKobo) || "0";
  if (entry.note) body.note = entry.note;
  if (meta.spokenAt) body.occurred_at = meta.spokenAt;
  return {
    path: MANUAL_ROUTE,
    body,
    headers: meta.requestId ? { "x-request-id": meta.requestId } : undefined,
  };
}
