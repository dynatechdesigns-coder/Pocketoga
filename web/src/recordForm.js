// The "Type it instead" form: which fields each kind of record asks for, and
// turning what the trader typed into the body of POST /propose-form. Plain
// JavaScript so the web tests can run it under node. Amounts are typed in
// whole naira; the form route wants whole-naira integers.
import { parseNaira } from "./format.js";

// The four kinds a record can be. "purchase" is stock bought (the server calls
// it restock once it is saved).
export const RECORD_TYPES = [
  { type: "sale", label: "Sale" },
  { type: "payment", label: "Payment" },
  { type: "purchase", label: "Stock" },
  { type: "expense", label: "Expense" },
];

// Fields shown per kind, in order. `required` ones must be filled.
export const FORM_FIELDS = {
  sale: ["customer", "item", "quantity", "unit", "amount", "amountPaid"],
  payment: ["customer", "amount"],
  purchase: ["item", "quantity", "unit", "amount", "customer"],
  expense: ["category", "amount", "customer"],
};

export const FIELD_LABELS = {
  customer: "Customer",
  item: "Item",
  quantity: "Quantity",
  unit: "Unit (bag, carton…)",
  amount: "Amount",
  amountPaid: "Amount paid now",
  category: "What was it for?",
};

// Per kind, a field can be renamed ("Supplier" for stock) or made required.
export const FIELD_NOTES = {
  sale: { required: ["customer", "amount"], labels: { customer: "Customer" } },
  payment: { required: ["customer", "amount"], labels: { customer: "Who paid you?", amount: "Amount received" } },
  purchase: { required: ["item", "amount"], labels: { customer: "Supplier (optional)" } },
  expense: { required: ["category", "amount"], labels: { customer: "Paid to (optional)", category: "What was it for?" } },
};

export const emptyForm = () => ({
  customer: "",
  item: "",
  quantity: "",
  unit: "",
  amount: "",
  amountMode: "total", // "total": the amount is for everything; "each": price of one
  amountPaid: "",
  category: "",
});

// Whole naira from typed text: null when empty, { error } when not a plain
// whole amount.
function naira(text) {
  if (!String(text ?? "").trim()) return null;
  const kobo = parseNaira(text);
  if (kobo === null) return { error: "Type the amount in numbers, like 15000 or 15,000." };
  if (kobo % 100 !== 0) return { error: "Use whole naira, like 15000." };
  return kobo / 100;
}

// -> { fields } for the route, or { error, field } to show under the form.
export function buildFormPayload(type, values) {
  const shown = FORM_FIELDS[type];
  if (!shown) return { error: "Pick what you are recording.", field: "type" };
  const need = FIELD_NOTES[type].required;
  const text = (key) => String(values[key] ?? "").trim();

  for (const key of need) {
    if (!text(key)) return { error: `${FIELD_NOTES[type].labels[key] ?? FIELD_LABELS[key]}: fill this in.`.replace(" (optional)", ""), field: key };
  }

  const fields = { type };
  for (const key of ["customer", "item", "unit", "category"]) {
    if (shown.includes(key) && text(key)) fields[key] = text(key);
  }

  if (shown.includes("quantity") && text("quantity")) {
    const q = text("quantity");
    if (!/^\d+$/.test(q) || Number(q) < 1) return { error: "Quantity must be a whole number, like 2.", field: "quantity" };
    fields.quantity = Number(q);
  }

  const amount = naira(values.amount);
  if (amount === null) return { error: "Fill in the amount.", field: "amount" };
  if (typeof amount === "object") return { error: amount.error, field: "amount" };
  const each = values.amountMode === "each" && (type === "sale" || type === "purchase");
  if (each) {
    if (!fields.quantity) return { error: "Give the quantity to price each one.", field: "quantity" };
    fields.unitCostNaira = amount;
  } else {
    fields.amountNaira = amount;
  }

  if (shown.includes("amountPaid") && text("amountPaid")) {
    const paid = naira(values.amountPaid);
    if (typeof paid === "object") return { error: paid.error, field: "amountPaid" };
    fields.amountPaidNaira = paid;
  }
  return { fields };
}

// Builds the body, sends it with `propose` (api.proposeForm) and returns the
// proposal to check. Nothing is saved: the trader still has to tap Save on
// the confirm card. -> { proposal } or { error, field }.
export async function submitRecordForm(type, values, propose) {
  const built = buildFormPayload(type, values);
  if (!built.fields) return built;
  return { proposal: await propose(built.fields) };
}
