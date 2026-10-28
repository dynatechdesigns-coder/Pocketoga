// Prints every WhatsApp message type with fake data so the layout can be
// read in the terminal without WhatsApp. Run: `node preview-messages.mjs`
// Fake data only. No network, no .env, nothing is sent anywhere.
import { Ledger } from "./ledger.mjs";
import { checkModelOutput } from "./voice.mjs";
import {
  MAX_BODY_CHARS,
  REJECTED,
  FIX_ASK,
  ALREADY_SAVED,
  NOT_REGISTERED,
  UNSUPPORTED,
  EXPIRED_PROPOSAL,
  GENERIC_ERROR,
  UNKNOWN_BUTTON,
  PROPOSAL_NOT_FOUND,
  OTHER_SHOP,
  FFMPEG_MISSING,
  AUDIO_FAILED,
  HEAR_FAILED,
  BAD_AUDIO_JSON,
  CORRECTION_AS_TEXT,
  alreadyConfirmedFix,
  renderProposalCard,
  renderSavedReply,
} from "./messages.mjs";

const SHOP = "preview-shop";

function proposal(id, raw) {
  const { heard, question, ...envelope } = checkModelOutput(raw, SHOP);
  return { id, shop_id: SHOP, status: "pending", heard, question, ...envelope };
}

function show(title, text, buttons) {
  console.log(`--- ${title} (${text.length} chars) ---`);
  console.log(text);
  if (buttons) console.log(`\n[${buttons.map((b) => b.reply.title).join("] [")}]`);
  console.log("");
}

function showCard(title, card) {
  show(title, card.text, card.buttons);
  if (card.text.length > MAX_BODY_CHARS) console.log("!! OVER 1024 CHARS !!\n");
}

// Prior ledger history so balance lines have something to add to.
const ledger = new Ledger(":memory:");
ledger.append({ shopId: SHOP, type: "sale", amountKobo: 2000000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" });
ledger.append({ shopId: SHOP, type: "payment", amountKobo: 500000, customer: "Ada" });
const existing = () => ledger.list(SHOP);

// 1. Clean sale with an each-price.
const cleanSale = proposal(1, {
  heard: "Ada buy rice 2 bags, na 15k each.",
  entries: [
    { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "each" },
  ],
  totals: null,
  question: null,
});
showCard("Clean sale (Save, Fix, Reject)", renderProposalCard(cleanSale, { existing: existing(), shopId: SHOP }));

// 2. Part payment.
const partPayment = proposal(2, {
  heard: "Ada buy rice 2 bags, na 15k. She pay 10k, remain 5k.",
  entries: [
    { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" },
    { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
  ],
  totals: {
    totalNaira: 15000, totalPhrase: "15k",
    paidNaira: 10000, paidPhrase: "10k",
    remainderNaira: 5000, remainderPhrase: "remain 5k",
  },
  question: null,
});
showCard("Part payment (Save, Fix, Reject)", renderProposalCard(partPayment, { existing: existing(), shopId: SHOP }));

// 3. Needs checking: the numbers do not add up.
const mismatch = proposal(3, {
  heard: "Ada buy rice 2 bags, na 15k. She pay 10k, remain 4k.",
  entries: [
    { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" },
    { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
  ],
  totals: {
    totalNaira: 15000, totalPhrase: "15k",
    paidNaira: 10000, paidPhrase: "10k",
    remainderNaira: 4000, remainderPhrase: "remain 4k",
  },
  question: null,
});
showCard("Needs checking (Fix, Reject)", renderProposalCard(mismatch));

// 4. Multi-entry note, two customers.
const multi = proposal(4, {
  heard: "Ada buy rice 1 bag na 8k and Bola pay 3k for garri.",
  entries: [
    { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 1, amountNaira: 8000, amountPhrase: "8k", priceBasis: "total" },
    { type: "payment", customer: "Bola", item: null, quantity: null, unit: null, amountNaira: 3000, amountPhrase: "3k", priceBasis: "total" },
  ],
  totals: null,
  question: null,
});
showCard("Multi-entry, two customers", renderProposalCard(multi, { existing: existing(), shopId: SHOP }));

// 5. Customer name with markdown characters.
const tricky = proposal(5, {
  heard: "Mama star buy beans 2 tins, na 4k.",
  entries: [
    { type: "sale", customer: "Mama *Nkechi* _Best_", item: "beans", unit: "tin", quantity: 2, amountNaira: 4000, amountPhrase: "4k", priceBasis: "total" },
  ],
  totals: null,
  question: null,
});
showCard("Markdown in customer name", renderProposalCard(tricky, { existing: existing(), shopId: SHOP }));

// 6. Very long note: the heard quote is trimmed first.
const longHeard = `Ada buy rice 2 bags na 15k, she pay 10k and promise to pay the remaining 5k on Friday when her brother returns from the market with the rest of the money she lent him last month for transport and upkeep. `.repeat(3);
const longNote = proposal(6, {
  heard: longHeard,
  entries: [
    { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "total" },
    { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
  ],
  totals: null,
  question: null,
});
showCard("Very long note (heard trimmed)", renderProposalCard(longNote, { existing: existing(), shopId: SHOP }));

// 7. Saved reply: record the part payment, then report it.
const recorded = partPayment.entries.map((e) =>
  ledger.append({
    shopId: SHOP,
    type: e.type,
    amountKobo: e.amountKobo,
    customer: e.customer,
    item: e.item,
    quantity: e.quantity,
    unit: e.unit,
  })
);
show("Saved reply", renderSavedReply({ recorded, existing: existing() }));

// 8. One-line replies.
for (const [title, text] of [
  ["Reject", REJECTED],
  ["Fix prompt", FIX_ASK],
  ["Already saved", ALREADY_SAVED],
  ["Unknown sender", NOT_REGISTERED],
  ["Unsupported message", UNSUPPORTED],
  ["Expired proposal", EXPIRED_PROPOSAL],
  ["Error", GENERIC_ERROR],
  ["Unknown button", UNKNOWN_BUTTON],
  ["Proposal not found", PROPOSAL_NOT_FOUND],
  ["Other shop", OTHER_SHOP],
  ["ffmpeg missing", FFMPEG_MISSING],
  ["Audio failed", AUDIO_FAILED],
  ["Could not hear correction", HEAR_FAILED],
  ["Bad audio JSON", BAD_AUDIO_JSON],
  ["Correction as text", CORRECTION_AS_TEXT],
  ["Fix on confirmed", alreadyConfirmedFix(12)],
]) {
  show(title, text);
}

ledger.close();
