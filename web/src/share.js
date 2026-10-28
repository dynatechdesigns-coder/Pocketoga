// The money check as plain text, and sharing it. Values come straight from
// GET /report; categories are listed separately and never added together.
import { formatKobo, plural } from "./format.js";

export function reportText(shopName, report) {
  const { owed, overdue, broken, shortfalls, belowCost } = report;
  const lines = [`PocketOga money check — ${shopName}`];
  lines.push(
    owed.totalKobo > 0
      ? `Customers owe: ${formatKobo(owed.totalKobo)} (${plural(owed.customers, "customer")})`
      : "Customers owe: nothing"
  );
  if (overdue.amountKobo > 0) lines.push(`Overdue 30+ days: ${formatKobo(overdue.amountKobo)}`);
  if (broken.count > 0) lines.push(`Broken promises: ${plural(broken.count, "promise")}, ${formatKobo(broken.amountKobo)} unpaid`);
  for (const s of shortfalls) lines.push(`Sold more than bought: ${s.display}, ${s.shortfallQty} short`);
  for (const b of belowCost.items) lines.push(`Margin lost: ${b.display}, ${formatKobo(b.marginKobo)}`);
  return lines.join("\n");
}

// Uses the phone's share sheet when there is one, else opens WhatsApp with
// the text ready. Either way the trader chooses who gets it.
export async function shareText(text) {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return; // the trader closed the share sheet
    }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
}
