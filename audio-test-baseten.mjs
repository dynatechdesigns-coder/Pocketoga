import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "note.wav";
const b64 = readFileSync(file).toString("base64");

const transcript = {
  type: "string",
  description: "Your best transcript of what the trader said, in their own words.",
};

const tools = [
  {
    name: "record_sale",
    description: "Record a completed sale of goods.",
    parameters: {
      type: "object",
      properties: {
        transcript,
        customer: { type: "string" },
        item: { type: "string" },
        quantity: { type: "number" },
        unit: { type: "string", description: "bag, carton, crate, tuber, mudu, piece..." },
        unit_price: { type: "number" },
        amount_paid: { type: "number" },
      },
      required: ["transcript", "item", "quantity", "unit_price"],
    },
  },
  {
    name: "log_debt",
    description: "Record that a customer owes the trader money.",
    parameters: {
      type: "object",
      properties: {
        transcript,
        customer: { type: "string" },
        amount_owed: { type: "number" },
        note: { type: "string" },
      },
      required: ["transcript", "customer", "amount_owed"],
    },
  },
  {
    name: "record_payment",
    description: "Record that a customer paid back some or all of what they owe.",
    parameters: {
      type: "object",
      properties: {
        transcript,
        customer: { type: "string" },
        amount_paid: { type: "number" },
      },
      required: ["transcript", "customer", "amount_paid"],
    },
  },
  {
    name: "set_reminder",
    description: "Set a reminder for the trader, for example to collect a debt.",
    parameters: {
      type: "object",
      properties: {
        transcript,
        text: { type: "string" },
        when: { type: "string", description: "When, in the trader's words, or 'unspecified'." },
      },
      required: ["transcript", "text"],
    },
  },
  {
    name: "ask_followup",
    description:
      "Ask a short question ONLY when the note is unclear or a needed detail is missing.",
    parameters: {
      type: "object",
      properties: {
        transcript,
        question: { type: "string" },
      },
      required: ["transcript", "question"],
    },
  },
].map((t) => ({ type: "function", function: t }));

const started = Date.now();

const res = await fetch("https://inference.baseten.co/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.BASETEN_API_KEY}`,
  },
  body: JSON.stringify({
    model: "meta-models/muse-spark-open-1026",
    max_tokens: 4000,
    messages: [
      {
        role: "system",
        content:
          "You are PocketOga, a bookkeeping agent for Nigerian market traders. Understand English and Pidgin. Amounts are in naira ('15k' = 15000). Listen to the voice note and call every tool that applies (a note can need more than one, for example log_debt and set_reminder). Choose the tool that matches what the trader actually said: sales, debts owed to them, payments received, or reminders. Use ask_followup only if something essential is unclear or missing, and ask about exactly that thing, in the same language the trader used. Never invent details. Traders often correct themselves mid-sentence ('rice, no, I mean yam'): the final corrected version wins, so never ask about something they already corrected. Always capture the customer's name if one is mentioned. Units can be bags, cartons, crates, tubers, mudu, pieces; keep the unit the trader used.",
      },
      {
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: b64, format: "wav" } },
        ],
      },
    ],
    tools,
  }),
});

const data = await res.json();
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const choice = data.choices?.[0];
const msg = choice?.message ?? {};

console.log("FILE:", file, "| STATUS:", res.status, "| TIME:", seconds + "s");
console.log("FINISH REASON:", choice?.finish_reason);

if (msg.tool_calls?.length) {
  for (const c of msg.tool_calls) {
    console.log("TOOL:", c.function.name, c.function.arguments);
  }
} else {
  console.log("TEXT:", (msg.content ?? "").trim().slice(-400) || JSON.stringify(data).slice(0, 600));
}