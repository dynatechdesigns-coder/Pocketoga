// Prints every new debts/promises message with fake data so the layout can
// be read in the terminal without WhatsApp. Run: `node preview-debts.mjs`
// Fake data only. No network, no .env, nothing is sent anywhere.
import { Ledger } from "./ledger.mjs";
import { checkModelOutput } from "./voice.mjs";
import { PromiseStore, refreshPromises, keptRate } from "./promises.mjs";
import { customerDebts, chaseForShop, lagosDay } from "./debts.mjs";
import {
  MAX_BODY_CHARS,
  renderProposalCard,
  renderWhoOwes,
  renderChase,
  renderBalance,
  unknownCustomer,
  dueTodayLines,
} from "./messages.mjs";

// Fixed clock so the preview never shifts: Wed 28 Oct 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const SHOP = "preview-shop";

function show(title, text) {
  console.log(`--- ${title} (${text.length} chars) ---`);
  console.log(text);
  console.log("");
  if (text.length > MAX_BODY_CHARS) console.log("!! OVER 1024 CHARS !!\n");
}

const ledger = new Ledger(":memory:");
ledger.append({ shopId: SHOP, type: "sale", amountKobo: 3000000, customer: "Ada", item: "rice", quantity: 2, unit: "bag", createdAt: daysAgo(12) });
ledger.append({ shopId: SHOP, type: "payment", amountKobo: 1000000, customer: "Ada", createdAt: daysAgo(2) });
ledger.append({ shopId: SHOP, type: "sale", amountKobo: 500000, customer: "Bola", item: "beans", quantity: 1, unit: "bag", createdAt: daysAgo(3) });

const promises = new PromiseStore(":memory:");
promises.create({ shopId: SHOP, customer: "Ada", amountKobo: 2000000, dueDate: "2026-10-20" });
promises.create({ shopId: SHOP, customer: "Bola", amountKobo: 500000, dueDate: lagosDay(NOW) });
promises.create({ shopId: SHOP, customer: "Chidi", dueDate: lagosDay(NOW) });
promises.create({ shopId: SHOP, customer: "Bola", dueDate: "2026-11-05" });
refreshPromises(promises, ledger, SHOP, { now: NOW });

const rows = ledger.list(SHOP);
const allPromises = promises.listByShop(SHOP);
const debts = customerDebts(rows, { now: NOW });

// 1. Proposal card carrying a promise.
const { heard, question, questionedNames, ...envelope } = checkModelOutput(
  {
    heard: "Ada buy rice 2 bags na 30k. She go pay friday.",
    entries: [
      { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 30000, amountPhrase: "30k", priceBasis: "total" },
    ],
    totals: null,
    question: null,
    promise: { customer: "Ada", datePhrase: "friday", amountNaira: 30000 },
  },
  SHOP,
  { now: NOW }
);
const card = renderProposalCard(
  { id: 1, shop_id: SHOP, status: "pending", heard, question, ...envelope },
  { existing: rows, shopId: SHOP }
);
show("Proposal card with promise", `${card.text}\n\n[${card.buttons.map((b) => b.reply.title).join("] [")}]`);

// 2. who owes.
show("who owes", renderWhoOwes(debts));

// 3. chase with three drafts.
show("chase", renderChase(chaseForShop(rows, allPromises, { now: NOW })));

// 4. balance, known and unknown.
const ada = debts.find((d) => d.customer === "Ada");
show("balance Ada", renderBalance(ada, keptRate(allPromises, "Ada")));
show("balance Nobody", unknownCustomer("Nobody"));

// 5. Due-today lines appended to replies.
const due = allPromises.filter((p) => p.status === "open" && p.due_date === lagosDay(NOW));
show("due today", dueTodayLines(due).join("\n"));

ledger.close();
promises.close();
