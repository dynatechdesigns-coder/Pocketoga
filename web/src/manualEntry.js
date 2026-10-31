// "No signal? Enter it by hand": when the entry is offered, how typed amounts
// look, and the plain-code check before anything is kept. Amounts are whole
// kobo (integers) from the first keystroke; no floating-point maths anywhere.
// Plain JavaScript so the web tests can run it under node.
import { formatKobo, parseNaira } from "./format.js";
import { isOffline } from "./connection.js";
import { UNNAMED_WAITING } from "./debtView.js";

export const MANUAL_SAVED_MESSAGE = "Saved on your phone. It will be sent when you are back online.";
export const NOTE_MAX = 200;
export const NAME_MAX = 100; // customer and item, as the server limits them
export const MANUAL_MAX_KOBO = 100_000_000; // ₦1,000,000 per entry

export const MANUAL_TYPES = [
  { kind: "sale", label: "Sale" },
  { kind: "payment", label: "Payment from customer" },
  { kind: "expense", label: "Expense" },
];

// The button shows only while the device is offline or the last request failed
// on the network (the same state as the Offline pill). Being online again does
// not close a form that is already open; only this button goes.
export const showManualEntry = (connectionState) => isOffline(connectionState);

// What the amount boxes keep: digits and one dot, at most 2 decimals, no
// pointless leading zeros. "₦15,0a0.505" -> "1500.50"
export function cleanAmountInput(text) {
  let s = String(text ?? "").replace(/[^\d.]/g, "");
  const dot = s.indexOf(".");
  if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "").slice(0, 2);
  const [whole, frac] = s.split(".");
  const w = whole.replace(/^0+(?=\d)/, "");
  return frac === undefined ? w : `${w === "" ? "0" : w}.${frac}`;
}

// The same, as the trader sees it in the box: "₦15,000.5". Empty stays empty.
export function showAmountInput(raw) {
  const s = cleanAmountInput(raw);
  if (s === "") return "";
  const [whole, frac] = s.split(".");
  return `₦${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac === undefined ? "" : "." + frac}`;
}

export const emptyManual = () => ({ kind: "sale", customer: "", item: "", quantity: "", amount: "", paid: "", paidTouched: false, note: "" });

// "Paid now" follows the amount until the trader types in it.
export const paidText = (v) => (v.paidTouched ? v.paid : v.amount);

// Kobo still owed on a sale, or null while the amounts are not both readable.
export function owesKobo(v) {
  if (v.kind !== "sale") return null;
  const amount = parseNaira(v.amount);
  const paid = parseNaira(paidText(v) === "" ? "0" : paidText(v));
  if (amount === null || paid === null || paid > amount) return null;
  return amount - paid;
}

// The check. -> { entry } ready for the queue, or { error, field } in plain words.
export function validateManual(v) {
  const type = MANUAL_TYPES.find((t) => t.kind === v.kind);
  if (!type) return { error: "Pick what you are entering: a sale, a payment or an expense.", field: "kind" };
  const text = (k) => String(v[k] ?? "").trim();

  const amount = parseNaira(v.amount);
  if (text("amount") === "") return { error: "Type the amount.", field: "amount" };
  if (amount === null) return { error: "Type the amount in numbers, like 15000 or 15,000.50.", field: "amount" };
  if (amount <= 0) return { error: "The amount must be more than ₦0.", field: "amount" };
  if (amount > MANUAL_MAX_KOBO) return { error: `The amount can be at most ${formatKobo(MANUAL_MAX_KOBO)}.`, field: "amount" };

  const entry = { kind: v.kind, amountKobo: amount };

  if (v.kind === "sale") {
    const paidTyped = paidText(v);
    const paid = paidTyped === "" ? 0 : parseNaira(paidTyped);
    if (paid === null) return { error: "Type what was paid in numbers, like 5000.", field: "paid" };
    if (paid > amount) return { error: `Paid now cannot be more than the amount (${formatKobo(amount)}).`, field: "paid" };
    entry.paidKobo = paid;
  }
  // The customer is always optional: with no name the server labels it
  // "Customer 1", "Customer 2" and so on.

  if (text("customer").length > NAME_MAX) return { error: `The customer's name can be at most ${NAME_MAX} characters.`, field: "customer" };
  if (text("item").length > NAME_MAX) return { error: `The item can be at most ${NAME_MAX} characters.`, field: "item" };
  if (text("customer")) entry.customer = text("customer");
  if (text("item") && v.kind !== "payment") entry.item = text("item");
  if (text("quantity") && v.kind === "sale") {
    if (!/^\d+$/.test(text("quantity")) || Number(text("quantity")) < 1) return { error: "Quantity must be a whole number, like 2.", field: "quantity" };
    entry.quantity = Number(text("quantity"));
  }
  if (text("note")) {
    if (text("note").length > NOTE_MAX) return { error: `The note can be at most ${NOTE_MAX} characters.`, field: "note" };
    entry.note = text("note");
  }
  return { entry };
}

// One line for the "Waiting to send" row: "Sale · ₦15,000 · Ada · owes ₦5,000".
export function manualSummary(entry) {
  const label = MANUAL_TYPES.find((t) => t.kind === entry?.kind)?.label ?? "Entry";
  const parts = [label.replace(" from customer", ""), formatKobo(entry?.amountKobo)];
  // Unnamed: "Customer" until it is sent and the server gives it "Customer 1", "Customer 2"...
  if (entry?.customer) parts.push(entry.customer);
  else if (entry?.kind !== "expense") parts.push(UNNAMED_WAITING);
  if (entry?.kind === "sale" && Number.isInteger(entry.paidKobo) && entry.paidKobo < entry.amountKobo) parts.push(`owes ${formatKobo(entry.amountKobo - entry.paidKobo)}`);
  return parts.join(" · ");
}
