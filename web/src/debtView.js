// What the screens say about debts, customer labels and shorthand amounts, from
// the shapes the server sends. Display only: every amount arrives as whole
// kobo from the server. Plain JavaScript so the web tests can run it.
import { formatDueDay, formatKobo, lagosToday } from "./format.js";

// The label shown for an unnamed entry that is still waiting on the phone. The
// server gives it "Customer 1", "Customer 2" and so on once it is sent.
export const UNNAMED_WAITING = "Customer";

// proposal.debts[]: { customer, amountKobo, direction: "customer_owes" | "trader_owes" }
// -> [{ customer, amountKobo, text }] with text "Debt: Customer 1 owes ₦20,000".
export function debtLines(proposal) {
  const out = [];
  for (const d of Array.isArray(proposal?.debts) ? proposal.debts : []) {
    if (!d || typeof d.customer !== "string" || !Number.isInteger(d.amountKobo) || d.amountKobo <= 0) continue;
    const amount = formatKobo(d.amountKobo);
    const text = d.direction === "trader_owes" ? `Debt: you owe ${d.customer} ${amount}` : `Debt: ${d.customer} owes ${amount}`;
    out.push({ customer: d.customer, amountKobo: d.amountKobo, text });
  }
  return out;
}

// proposal.partPaid: { customer, totalKobo, paidKobo, owedKobo } or null
// -> three rows: sale total, paid, debt left.
export function partPaidRows(proposal) {
  const p = proposal?.partPaid;
  if (!p || ![p.totalKobo, p.paidKobo, p.owedKobo].every(Number.isInteger)) return null;
  return [
    { key: "total", label: "Sale total", kobo: p.totalKobo },
    { key: "paid", label: "Paid", kobo: p.paidKobo },
    { key: "owed", label: "Debt left", kobo: p.owedKobo },
  ];
}

// The first entry with two amounts to choose from (proposal.entries[i].amountOptions =
// [literalKobo, shorthandKobo]) -> { index, options: [kobo, kobo], question } or null.
export function amountChoice(proposal) {
  const entries = Array.isArray(proposal?.entries) ? proposal.entries : [];
  const index = entries.findIndex((e) => Array.isArray(e?.amountOptions) && e.amountOptions.length === 2 && e.amountOptions.every(Number.isInteger));
  if (index < 0) return null;
  const options = entries[index].amountOptions;
  return { index, options, question: `Did you mean ${formatKobo(options[0])} or ${formatKobo(options[1])}?` };
}

// The text POST /fix/:id takes to pick a choice: "1" for the first amount, "2" for the second.
export const choiceFix = (n) => String(n);

// The day a debt started, for the Debts row: today minus the age in days, in
// Lagos time ("Fri 30 Oct"). Null when the age is unknown.
export function debtSince(ageDays) {
  if (!Number.isInteger(ageDays) || ageDays < 0) return null;
  return formatDueDay(lagosToday(-ageDays));
}

// The row's second line: "Since Fri 30 Oct · 3 days". Today reads "Since today".
export function debtDateLine(ageDays) {
  const day = debtSince(ageDays);
  if (!day) return "";
  if (ageDays === 0) return "Since today";
  return `Since ${day}`;
}

// POST /customers/rename { from, to } -> { renamed, customer }
export const NAME_MAX = 100;

export function validateRename(from, to) {
  const next = String(to ?? "").trim().replace(/\s+/g, " ");
  if (!next) return { error: "Type the new name." };
  if (next.length > NAME_MAX) return { error: `The name can be at most ${NAME_MAX} characters.` };
  if (next.toLowerCase() === String(from ?? "").trim().toLowerCase()) return { error: "That is the same name. Type a different one." };
  return { to: next };
}

// Plain words for a refused rename (the server's own wording is for developers).
export function renameError(err) {
  switch (err?.status) {
    case 0:
      return "Cannot reach PocketOga. Check your connection and try again.";
    case 404:
      return "We could not find that customer. Pull to refresh and try again.";
    case 409:
      return "You already have a customer with that name. Type a different one.";
    case 400:
      return "That name cannot be used. Type a different one.";
    default:
      return "Could not change the name. Please try again.";
  }
}
