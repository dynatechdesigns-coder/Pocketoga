// What the confirm card says about each entry, in plain words, built from the
// proposal the server returned. Plain JavaScript so the web tests can use it.
import { itemText, typeLabel } from "./format.js";

// Where a saved entry shows up. `destination` comes from the server's
// effects[]; the words are ours.
const DESTINATION_WORDS = {
  Sales: "Goes to Sales",
  Debts: "Goes to Debts: it changes what the customer owes",
  Products: "Goes to Products: it changes your stock",
  Expenses: "Goes to Expenses",
};

export const ENTRY_TYPE_WORDS = {
  sale: "Sale",
  payment: "Payment received",
  restock: "Stock bought",
  expense: "Expense",
};

export const entryTypeWords = (type) => ENTRY_TYPE_WORDS[type] ?? typeLabel(type);

// -> { type, destination, stock, notes[] } for entry `i`. Fields are null or
// empty when the server sent nothing for them (older server).
export function describeEntry(proposal, i) {
  const entry = proposal.entries[i];
  const effect = proposal.effects?.[i] ?? null;
  const notes = [];
  let stock = null;
  if (effect && effect.stockItem && Number.isInteger(effect.stockBefore) && Number.isInteger(effect.stockAfter)) {
    const unit = effect.stockUnit ? ` ${effect.stockUnit}` : "";
    stock = `Stock of ${effect.stockItem}: ${effect.stockBefore} → ${effect.stockAfter}${unit}`;
  }
  if (effect?.negativeStock) notes.push("This takes your stock below zero. Check the quantity.");
  if (effect?.costUnknown) notes.push("No cost price yet, so profit on this item is a guess.");
  return {
    type: entryTypeWords(entry.type),
    destination: effect?.destination ? DESTINATION_WORDS[effect.destination] ?? `Goes to ${effect.destination}` : null,
    stock,
    notes,
    item: itemText(entry),
  };
}

// The "you said X but it sounds like Y" line, when the server sent one.
export const hintLine = (proposal) => (typeof proposal.hintNote === "string" && proposal.hintNote.trim() ? proposal.hintNote.trim() : null);

// Server flags are written for developers ("entry 1: missing customer name").
// Make them read like plain words.
export function plainFlag(flag) {
  const s = flag
    .replace(/^needs clarification:\s*/i, "")
    .replace(/^entry (\d+):\s*/i, "Line $1: ")
    .replace(/^remainder:\s*/i, "Still owed: ")
    .replace(/\*/g, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// The things the trader must answer before Save unlocks, repeats removed.
export function problemsOf(proposal) {
  const problems = [...new Set(proposal.flags.map(plainFlag))];
  if (problems.length === 0 && proposal.question) problems.push(proposal.question);
  return problems;
}

// Save only works on a pending proposal with nothing left to check. Nothing is
// written to the ledger until the trader taps it.
export const canSave = (proposal) => proposal.status === "pending" && problemsOf(proposal).length === 0 && proposal.entries.length > 0;
