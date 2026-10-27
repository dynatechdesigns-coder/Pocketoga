// Money display helpers. Amounts are always integer kobo (100 kobo = ₦1),
// same as the backend. The UI never does money math beyond formatting.

export const NAIRA_SIGN = "₦";

// 1500000 -> "₦15,000"; 1550 -> "₦15.50"
export function formatKobo(kobo) {
  if (kobo === null || kobo === undefined) return "—";
  const sign = kobo < 0 ? "-" : "";
  const abs = Math.abs(kobo);
  const grouped = Math.floor(abs / 100).toLocaleString("en-US");
  const k = abs % 100;
  return `${sign}${NAIRA_SIGN}${grouped}${k === 0 ? "" : "." + String(k).padStart(2, "0")}`;
}

// Words a trader uses for each entry type.
export const TYPE_LABELS = {
  sale: "Sale",
  payment: "Payment received",
  restock: "Stock bought",
  correction: "Correction",
};

export function typeLabel(type) {
  return TYPE_LABELS[type] ?? type;
}
