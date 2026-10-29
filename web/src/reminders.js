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

// A phone number in the international digits wa.me wants, worked out the way
// the backend stores it (customers.mjs normalizePhone): "0803 000 0011" and
// "+234 803 000 0011" both give "2348030000011"; a number from another country
// ("+44 7700 900123", or "447700900123" as stored) keeps its own code. Null
// when it does not look like a phone number: under 7 or over 15 digits, or a
// Nigerian number that is not 234 plus ten digits (usually a typo).
export function waNumber(phone) {
  let digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length < 7) return null;
  if (digits.startsWith("0")) digits = `234${digits.replace(/^0+/, "")}`;
  else if (!digits.startsWith("234") && digits.length === 10) digits = `234${digits}`;
  if (digits.length > 15) return null;
  if (digits.startsWith("234") && digits.length !== 13) return null;
  return digits;
}

// wa.me straight to the customer's chat when we have their number (stored
// with their permission); with no number WhatsApp opens its contact picker.
export const whatsappLink = (text, phone) => `https://wa.me/${waNumber(phone) ?? ""}?text=${encodeURIComponent(text)}`;
