// Display helpers only. Every number arrives from the server already
// computed; nothing here adds, subtracts or ranks money.

// 1500000 -> "₦15,000"; 1550 -> "₦15.50". Always from integer kobo.
export function formatKobo(kobo) {
  if (!Number.isInteger(kobo)) return "—";
  const sign = kobo < 0 ? "-" : "";
  const abs = Math.abs(kobo);
  const naira = Math.floor(abs / 100).toLocaleString("en-US");
  const k = abs % 100;
  return `${sign}₦${naira}${k === 0 ? "" : "." + String(k).padStart(2, "0")}`;
}

export const TYPE_LABELS = {
  sale: "Sale",
  payment: "Payment received",
  restock: "Stock bought",
  correction: "Correction",
};

export const typeLabel = (type) => TYPE_LABELS[type] ?? type;

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// "21 days", "1 day", "today".
export function ageText(days) {
  if (!Number.isInteger(days) || days <= 0) return "today";
  return plural(days, "day");
}

// What was sold or bought: "2 bags of rice", "3 × eggs", "rice".
export function itemText({ item, unit, quantity }) {
  if (!item) return quantity ? `${quantity} items` : "";
  if (!quantity) return item;
  if (unit) return `${quantity} ${quantity === 1 || unit.endsWith("s") ? unit : unit + "s"} of ${item}`;
  return `${quantity} × ${item}`;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-10-30" -> "Fri 30 Oct". A pure calendar day, no time zone involved.
export function formatDueDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ""));
  if (!m) return "date unknown";
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DOW[dt.getUTCDay()]} ${dt.getUTCDate()} ${MON[dt.getUTCMonth()]}`;
}

// Day and time in Lagos for ledger rows.
const LAGOS = "Africa/Lagos";
const dayKey = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: LAGOS });

export function dayLabel(iso) {
  const key = dayKey(iso);
  const now = Date.now();
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(now - 86400000)) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: LAGOS, weekday: "short", day: "numeric", month: "short" });
}

// Today's Lagos day as "YYYY-MM-DD", n days from now.
export const lagosToday = (n = 0) => dayKey(Date.now() + n * 86400000);

// "Due today", "Due tomorrow" or "Due Fri 30 Oct" for an open promise.
export function dueText(day) {
  if (day === lagosToday()) return "Due today";
  if (day === lagosToday(1)) return "Due tomorrow";
  return `Due ${formatDueDay(day)}`;
}

// "Good morning" / "Good afternoon" / "Good evening", by Lagos time.
export function greeting() {
  const h = Number(new Date().toLocaleTimeString("en-GB", { timeZone: LAGOS, hour: "2-digit", hour12: false }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export const timeLabel = (iso) =>
  new Date(iso).toLocaleTimeString("en-GB", { timeZone: LAGOS, hour: "2-digit", minute: "2-digit" });

// Customer names compared the way the backend does (debts.mjs normCustomer).
export const sameCustomer = (a, b) =>
  String(a ?? "").trim().toLowerCase().replace(/\s+/g, " ") ===
  String(b ?? "").trim().toLowerCase().replace(/\s+/g, " ");
