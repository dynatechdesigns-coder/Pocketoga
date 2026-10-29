// Prints the expense card, profit cards and /profit + /expenses payloads
// with fake data so the layout can be read in the terminal without
// WhatsApp. Run: `node preview-profit.mjs`
// Fake data only. No network, no .env, nothing is sent anywhere.
import { Ledger } from "./ledger.mjs";
import { checkModelOutput } from "./voice.mjs";
import { profitForPeriod, expensesForPeriod } from "./profit.mjs";
import { MAX_BODY_CHARS, renderProposalCard, renderProfit } from "./messages.mjs";

// Fixed clock so the preview never shifts: Wed 28 Oct 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const SHOP = "preview-shop";

function show(title, text) {
  console.log(`--- ${title} (${text.length} chars) ---`);
  console.log(text);
  console.log("");
  if (text.length > MAX_BODY_CHARS) console.log("!! OVER 1024 CHARS !!\n");
}

const ledger = new Ledger(":memory:");
ledger.append({ shopId: SHOP, type: "restock", amountKobo: 6000000, customer: SHOP, item: "rice", quantity: 10, unit: "bag", createdAt: "2026-10-01T10:00:00.000Z" });
ledger.append({ shopId: SHOP, type: "restock", amountKobo: 8000000, customer: SHOP, item: "rice", quantity: 10, unit: "bag", createdAt: "2026-10-20T10:00:00.000Z" });
ledger.append({ shopId: SHOP, type: "sale", amountKobo: 4000000, customer: "Ada", item: "rice", quantity: 4, unit: "bag", createdAt: "2026-10-28T09:30:00.000Z" });
ledger.append({ shopId: SHOP, type: "sale", amountKobo: 1000000, customer: "Bola", item: "beans", quantity: 2, unit: "tin", createdAt: "2026-10-28T08:00:00.000Z" });
ledger.append({ shopId: SHOP, type: "payment", amountKobo: 2000000, customer: "Ada", createdAt: "2026-10-28T11:00:00.000Z" });
ledger.append({ shopId: SHOP, type: "expense", amountKobo: 500000, customer: "NEPA", item: "power", createdAt: "2026-10-28T06:00:00.000Z" });
ledger.append({ shopId: SHOP, type: "expense", amountKobo: 150000, customer: "Danfo", item: "transport", createdAt: "2026-10-27T07:00:00.000Z" });

const rows = ledger.list(SHOP);

// 1. Expense proposal card.
const checked = checkModelOutput(
  {
    heard: "Paid NEPA 5k for power.",
    entries: [
      { type: "expense", customer: "NEPA", item: "power", quantity: null, unit: null, amountNaira: 5000, amountPhrase: "5k", priceBasis: "total" },
    ],
    totals: null,
    promise: null,
    question: null,
  },
  SHOP,
  { now: NOW }
);
show("expense card", renderProposalCard({ id: 1, shop_id: SHOP, status: "pending", heard: checked.heard, question: checked.question, created_at: new Date(NOW).toISOString(), entries: checked.entries, totals: checked.totals, flags: checked.flags, notes: checked.notes, recorded_ids: null, name_checked: null, promise: checked.promise }, { existing: rows, shopId: SHOP }).text);

// 2. Profit cards for today and the week.
show("profit today", renderProfit(profitForPeriod(rows, "today", { now: NOW })));
show("profit week", renderProfit(profitForPeriod(rows, "week", { now: NOW })));

// 3. Route payloads.
const profit = profitForPeriod(rows, "today", { now: NOW });
console.log(`--- GET /profit?period=today (series: ${profit.series.length} buckets) ---`);
console.log(JSON.stringify({ ...profit, series: profit.series.filter((b) => b.salesKobo > 0 || b.expensesKobo > 0) }, null, 2));
console.log("");
console.log("--- GET /expenses?period=week ---");
console.log(JSON.stringify(expensesForPeriod(rows, "week", { now: NOW }), null, 2));
