// The WhatsApp-and-web demo on the landing page: one note from a trader, the
// bot's reply card, the saved reply, and the Money screen before and after.
// Fake data only. CARD_TEXT and SAVED_TEXT are exactly what the real bot sends
// for DEMO_PROPOSAL / DEMO_RECORDED (renderProposalCard and renderSavedReply in
// ../../../messages.mjs); `npm run check:copy` fails if they ever drift apart.

export const DEMO_PROPOSAL = {
  id: 1,
  flags: [],
  question: null,
  promise: null,
  heard: "Ada buy 2 bags of rice, 15k each. She pay 10k.",
  entries: [
    {
      type: "sale",
      customer: "Ada",
      item: "rice",
      unit: "bag",
      quantity: 2,
      amountKobo: 3000000,
      eachKobo: 1500000,
    },
    {
      type: "payment",
      customer: "Ada",
      item: null,
      unit: null,
      quantity: null,
      amountKobo: 1000000,
    },
  ],
};

// The same two entries once saved (ledger rows use snake_case).
export const DEMO_RECORDED = [
  {
    type: "sale",
    customer: "Ada",
    item: "rice",
    unit: "bag",
    quantity: 2,
    amount_kobo: 3000000,
  },
  {
    type: "payment",
    customer: "Ada",
    item: null,
    unit: null,
    quantity: null,
    amount_kobo: 1000000,
  },
];

// WhatsApp markup: *bold*, _italic_, blank lines between blocks.
export const CARD_TEXT = [
  "🛒 *Ada*",
  "",
  "2 bags of rice × ₦15,000 = *₦30,000* → Sales",
  "💵 Paid: *₦10,000* → Debts",
  "",
  "⚖️ Ada owes *₦20,000* after saving",
  "",
  '_"Ada buy 2 bags of rice, 15k each. She pay 10k."_',
].join("\n");

export const CARD_BUTTONS = ["Save", "Fix", "Reject"];

export const SAVED_TEXT = ["✅ *Saved*", "", "*Ada*: sale 2 bags of rice *₦30,000*, paid *₦10,000*", "", "⚖️ Ada owes *₦20,000*"].join(
  "\n",
);

export const VOICE_NOTE_LENGTH = "0:07";

// The Money screen on the web, before and after the note is saved. Integer
// kobo. The sale adds ₦30,000 to sold, the payment ₦10,000 to collected, and
// Ada's ₦20,000 balance joins what customers owe (she owed nothing before).
export const WEB_BEFORE = {
  soldKobo: 2700000,
  collectedKobo: 2700000,
  owedKobo: 21300000,
  owing: 5,
};
export const WEB_AFTER = {
  soldKobo: 5700000,
  collectedKobo: 3700000,
  owedKobo: 23300000,
  owing: 6,
};
