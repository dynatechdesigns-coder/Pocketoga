// Reminder drafts in the trader's own voice. Same wording as
// REMINDER_TEMPLATES in messages.mjs (the server has no HTTP route for
// them yet). Amount and age come from GET /debts; the app never sends
// anything — the trader copies or opens WhatsApp and sends it themselves.
import { formatKobo } from "./format.js";

function ageWords(days) {
  if (!Number.isInteger(days) || days <= 0) return "from today";
  return days === 1 ? "1 day old" : `${days} days old`;
}

const TEMPLATES = {
  friendly: (name, amount, age) =>
    `Hello ${name}, trust you are well. This is a friendly reminder that your balance of ${amount} (${age}) is still open. Please pay soon. Thank you!`,
  firm: (name, amount, age) =>
    `Hello ${name}, your balance of ${amount} (${age}) is still unpaid. Please pay it today. Thank you.`,
  final: (name, amount, age) =>
    `${name}, final reminder: pay your ${amount} balance (${age}) today, or I will take further steps.`,
};

export const TONES = [
  { key: "friendly", label: "Friendly" },
  { key: "firm", label: "Firm" },
  { key: "final", label: "Final" },
];

export function draftReminder(tone, { customer, owedKobo, ageDays }) {
  return TEMPLATES[tone](customer, formatKobo(owedKobo), ageWords(ageDays));
}

// A stored phone number in the international digits wa.me wants:
// "0803 000 0011" -> "2348030000011". Null when it does not look like one.
export function waNumber(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (/^0\d{10}$/.test(digits)) return "234" + digits.slice(1);
  if (/^234\d{10}$/.test(digits)) return digits;
  return digits.length >= 8 && digits.length <= 15 && String(phone).trim().startsWith("+") ? digits : null;
}

// wa.me straight to the customer's chat when we have their number (stored
// with their permission); with no number WhatsApp opens its contact picker.
export const whatsappLink = (text, phone) => `https://wa.me/${waNumber(phone) ?? ""}?text=${encodeURIComponent(text)}`;
