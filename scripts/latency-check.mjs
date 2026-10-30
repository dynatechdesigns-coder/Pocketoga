// Latency + question check: runs 12 fake notes through the real
// propose→render pipeline and prints per-step timings, totals, question
// counts and a summary (median, slowest, question rate), plus 3 voice
// timing probes (tone audio stands in for speech: frame counts, and hence
// transcription cost, match real notes of the same length).
//
// Real model when META_API_KEY is set (read from process.env only, never
// printed); otherwise the mock client with faithful canned readings, which
// still measures every code step honestly. Nothing is confirmed, so runs
// are repeatable. Baseten keys come from process.env when present.
//
// Usage: node scripts/latency-check.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "../ledger.mjs";
import { ProposalStore } from "../proposals.mjs";
import { PromiseStore } from "../promises.mjs";
import { ProductStore } from "../products.mjs";
import { SecondOpinionStore } from "../secondopinion.mjs";
import { createMockModelClient, createModelClient } from "../model.mjs";
import { propose } from "../voice.mjs";
import { renderProposalCard, TEXT_FAILED, MODEL_RETRY_FAILED } from "../messages.mjs";

const SHOP = "lat-shop";
const MOCK = !process.env.META_API_KEY;

// Network-retry tally from the POCKETOGA_TIMING=1 one-liners: every model
// and secondopinion line carries attempts=N (1 = no retry). The patch only
// counts; every line still prints. Without TIMING=1 the counts stay 0.
let modelRetries = 0;
let secondRetries = 0;
const realLog = console.log.bind(console);
console.log = (...args) => {
  const line = args.map((a) => String(a)).join(" ");
  let m = /^model kind=\S+ retry=\d+ attempts=(\d+)/.exec(line);
  if (m) modelRetries += Math.max(0, Number(m[1]) - 1);
  m = /^secondopinion .* attempts=(\d+)/.exec(line);
  if (m) secondRetries += Math.max(0, Number(m[1]) - 1);
  realLog(...args);
};

// --- Fake notes (fixed text; readings below mirror what the model returns)
const NOTES = [
  "Mama Chinedu buy 2 bag of rice for me. Each 15k each she paid 25k and she go pay on Wednesday next week",
  "I bought 10 bags of rice at 45k each",
  "I sold 2 bags of rice to Ada, 30k, she paid 10k",
  "I spent 5k on transport",
  "I sold 3 cartons of Indomie, bought 2 bags of rice and spent 2k on fuel",
  "Ada don pay 5k for the rice wey she buy",
  "Bola buy garri 3 mudu, 4500 total, e pay 2000",
  "Paid shop rent for November, 150000",
  "Sold 4 tins of milk at 2500 each to Ngozi, she pay everything",
  "NEPA bill 12500, paid with transfer",
  "Restock 20 bags of beans at 38k each from Oga Danjuma",
  "Mummy Adaeze bought 5 crates of eggs, 30k, she go pay Friday",
];

// Canned readings for mock runs: faithful transcriptions of the notes above.
const MOCK_READINGS = [
  {
    heard: NOTES[0],
    entries: [
      { type: "sale", customer: "Mama Chinedu", item: "rice", unit: "bag", quantity: 2, amountNaira: 15000, amountPhrase: "15k", priceBasis: "each" },
      { type: "payment", customer: "Mama Chinedu", item: null, quantity: null, unit: null, amountNaira: 25000, amountPhrase: "25k", priceBasis: "total" },
    ],
    totals: { totalNaira: 30000, totalPhrase: "30k", paidNaira: 25000, paidPhrase: "25k", remainderNaira: 5000, remainderPhrase: "remain 5k" },
    promise: { customer: "Mama Chinedu", datePhrase: "Wednesday next week", amountNaira: 5000 },
    question: null,
  },
  {
    heard: NOTES[1],
    entries: [
      { type: "purchase", customer: null, item: "rice", unit: "bag", quantity: 10, amountNaira: 45000, amountPhrase: "45k", priceBasis: "each" },
    ],
    totals: null, promise: null, question: null,
  },
  {
    heard: NOTES[2],
    entries: [
      { type: "sale", customer: "Ada", item: "rice", unit: "bag", quantity: 2, amountNaira: 30000, amountPhrase: "30k", priceBasis: "total" },
      { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10k", priceBasis: "total" },
    ],
    totals: { totalNaira: 30000, totalPhrase: "30k", paidNaira: 10000, paidPhrase: "10k", remainderNaira: 20000, remainderPhrase: "remain 20k" },
    promise: null, question: null,
  },
  {
    heard: NOTES[3],
    entries: [
      { type: "expense", customer: null, item: "transport", amountNaira: 5000, amountPhrase: "5k", priceBasis: "total" },
    ],
    totals: null, promise: null, question: null,
  },
  {
    heard: NOTES[4],
    entries: [
      { type: "sale", customer: null, item: "Indomie", unit: "carton", quantity: 3, amountNaira: null, amountPhrase: null, priceBasis: "total" },
      { type: "purchase", customer: null, item: "rice", unit: "bag", quantity: 2, amountNaira: null, amountPhrase: null, priceBasis: "total" },
      { type: "expense", customer: null, item: "fuel", amountNaira: 2000, amountPhrase: "2k", priceBasis: "total" },
    ],
    totals: null, promise: null, question: "how much for the indomie and the rice?",
  },
  {
    heard: NOTES[5],
    entries: [
      { type: "payment", customer: "Ada", item: null, quantity: null, unit: null, amountNaira: 5000, amountPhrase: "5k", priceBasis: "total" },
    ],
    totals: null, promise: null, question: null,
  },
  {
    heard: NOTES[6],
    entries: [
      { type: "sale", customer: "Bola", item: "garri", unit: "mudu", quantity: 3, amountNaira: 4500, amountPhrase: "4500", priceBasis: "total" },
      { type: "payment", customer: "Bola", item: null, quantity: null, unit: null, amountNaira: 2000, amountPhrase: "2000", priceBasis: "total" },
    ],
    totals: { totalNaira: 4500, totalPhrase: "4500", paidNaira: 2000, paidPhrase: "2000", remainderNaira: 2500, remainderPhrase: "remain 2500" },
    promise: null, question: null,
  },
  {
    heard: NOTES[7],
    entries: [
      { type: "expense", customer: null, item: "rent", amountNaira: 150000, amountPhrase: "150000", priceBasis: "total" },
    ],
    totals: null, promise: null, question: null,
  },
  {
    heard: NOTES[8],
    entries: [
      { type: "sale", customer: "Ngozi", item: "milk", unit: "tin", quantity: 4, amountNaira: 2500, amountPhrase: "2500", priceBasis: "each" },
      { type: "payment", customer: "Ngozi", item: null, quantity: null, unit: null, amountNaira: 10000, amountPhrase: "10000", priceBasis: "total" },
    ],
    totals: { totalNaira: 10000, totalPhrase: "10000", paidNaira: 10000, paidPhrase: "10000", remainderNaira: 0, remainderPhrase: "remain 0" },
    promise: null, question: null,
  },
  {
    heard: NOTES[9],
    entries: [
      { type: "expense", customer: "NEPA", item: "power", amountNaira: 12500, amountPhrase: "12500", priceBasis: "total" },
    ],
    totals: null, promise: null, question: null,
  },
  {
    heard: NOTES[10],
    entries: [
      { type: "purchase", customer: "Oga Danjuma", item: "beans", unit: "bag", quantity: 20, amountNaira: 38000, amountPhrase: "38k", priceBasis: "each" },
    ],
    totals: null, promise: null, question: null,
  },
  {
    heard: NOTES[11],
    entries: [
      { type: "sale", customer: "Mummy Adaeze", item: "eggs", unit: "crate", quantity: 5, amountNaira: 30000, amountPhrase: "30k", priceBasis: "total" },
    ],
    totals: null,
    promise: { customer: "Mummy Adaeze", datePhrase: "Friday", amountNaira: 30000 },
    question: null,
  },
];

// 16 kHz mono 16-bit tone WAV: same frame count as speech of that length.
function toneWav(seconds, hz = 440) {
  const rate = 16000;
  const n = rate * seconds;
  const data = Buffer.alloc(44 + n * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + n * 2, 4);
  data.write("WAVE", 8);
  data.write("fmt ", 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), 44 + i * 2);
  }
  return data;
}

function seed(ctx) {
  const { ledger, products } = ctx;
  ledger.append({ shopId: SHOP, type: "restock", amountKobo: 45000000, customer: SHOP, item: "rice", quantity: 10, unit: "bag" });
  ledger.append({ shopId: SHOP, type: "sale", amountKobo: 1500000, customer: "Chinedu", item: "rice", quantity: 1, unit: "bag" });
  ledger.append({ shopId: SHOP, type: "payment", amountKobo: 1000000, customer: "Chinedu" });
  ledger.append({ shopId: SHOP, type: "sale", amountKobo: 3000000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" });
  ledger.append({ shopId: SHOP, type: "payment", amountKobo: 1000000, customer: "Ada" });
  for (const [name, unit] of [["rice", "bag"], ["Indomie", "carton"], ["garri", "mudu"], ["milk", "tin"], ["eggs", "crate"], ["beans", "bag"]]) {
    products.ensure({ shopId: SHOP, name, unit });
  }
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function pad(s, n) {
  return String(s).padEnd(n).slice(0, n);
}

async function main() {
  console.log(MOCK ? "latency-check (MOCK model — set META_API_KEY for real timings)" : "latency-check (REAL model)");
  if (!process.env.BASETEN_API_KEY) console.log("note: no BASETEN_API_KEY, second opinion degrades to no-op");
  const db = new DatabaseSync(":memory:");
  const ctx = {
    ledger: new Ledger(db),
    proposals: new ProposalStore(db),
    promises: new PromiseStore(db),
    products: new ProductStore(db),
    secondOpinions: new SecondOpinionStore(db),
  };
  seed(ctx);
  const mockByHeard = new Map(NOTES.map((t, i) => [t, MOCK_READINGS[i]]));
  const model = MOCK
    ? createMockModelClient(async (req) => {
        if (req.audio) return MOCK_READINGS[2]; // voice probes: timing only
        return mockByHeard.get(req.text) ?? { heard: req.text, entries: [], totals: null };
      })
    : createModelClient({ apiKey: process.env.META_API_KEY });

  console.log("note kind  classify transcribe checks second 2nd  render total F Q question");
  const textTotals = [];
  let questioned = 0;
  let failures = 0;
  let secondFinished = 0;
  let secondAgreed = 0;
  let secondAttempted = 0;
  let secondLate = 0;
  let secondTimeout = 0;
  let secondError = 0;
  const secondOf = (proposalId) => {
    const rows = ctx.secondOpinions.listByProposal(proposalId);
    return rows.length > 0 ? rows[rows.length - 1] : null;
  };
  for (let i = 0; i < NOTES.length; i++) {
    const timings = {};
    const t0 = Date.now();
    const proposal = await propose(SHOP, NOTES[i], {
      proposals: ctx.proposals,
      model,
      ledger: ctx.ledger,
      products: ctx.products,
      secondOpinions: ctx.secondOpinions,
      secondOpinionEnv: process.env,
      timings,
    });
    const tRender = Date.now();
    renderProposalCard(proposal, { existing: ctx.ledger.list(SHOP), shopId: SHOP, products: ctx.products.listByShop(SHOP) });
    const renderMs = Date.now() - tRender;
    const total = Date.now() - t0;
    textTotals.push(total);
    // Model-side failures ("I no understand", "something went wrong") count
    // as failures, not questions. One question at most per note otherwise.
    const failed = [proposal.question, ...(proposal.flags ?? [])].some(
      (t) => t === TEXT_FAILED || t === MODEL_RETRY_FAILED
    );
    if (failed) failures++;
    const q = proposal.question && !failed ? 1 : 0;
    if (q > 0) questioned++;
    const srow = secondOf(proposal.id);
    const agreed = srow?.agreed ?? "no_second_opinion";
    if (agreed === "yes" || agreed === "no") {
      secondFinished++;
      secondAttempted++;
      if (agreed === "yes") secondAgreed++;
    } else if ((timings.secondMs ?? 0) > 0 || (srow?.latency_ms ?? 0) > 0) {
      secondAttempted++;
      if (srow?.outcome === "late") secondLate++;
      else if (srow?.outcome === "timeout") secondTimeout++;
      else if (srow?.outcome === "error") secondError++;
    }
    const sflag = agreed === "yes" ? "yes" : agreed === "no" ? "no" : "--";
    console.log(
      `${pad(i + 1, 4)} text  ${pad(timings.classifyMs ?? 0, 8)} ${pad(timings.transcribeMs ?? 0, 10)} ` +
        `${pad(timings.checksMs ?? 0, 6)} ${pad(timings.secondMs ?? 0, 6)} ${pad(sflag, 4)} ${pad(renderMs, 6)} ${pad(total, 6)} ${pad(failed ? 1 : 0, 2)} ${pad(q, 2)} ${(proposal.question ?? "").slice(0, 80)}`
    );
  }

  // Voice timing probes: tone audio of realistic note lengths. The scratch
  // dir lives next to the script (removed afterwards) so no system temp
  // access is needed.
  const dir = mkdtempSync(join(import.meta.dirname, ".lat-voice-"));
  const voiceTotals = [];
  try {
    for (const secs of [10, 30, 60]) {
      const wavPath = join(dir, `tone-${secs}s.wav`);
      writeFileSync(wavPath, toneWav(secs));
      const timings = {};
      const t0 = Date.now();
      const proposal = await propose(SHOP, { audioPath: wavPath }, {
        proposals: ctx.proposals,
        model,
        ledger: ctx.ledger,
        products: ctx.products,
        secondOpinions: ctx.secondOpinions,
        secondOpinionEnv: process.env,
        timings,
      });
      const tRender = Date.now();
      renderProposalCard(proposal, { existing: ctx.ledger.list(SHOP), shopId: SHOP, products: ctx.products.listByShop(SHOP) });
      const renderMs = Date.now() - tRender;
      const total = Date.now() - t0;
      voiceTotals.push(total);
      const srow = secondOf(proposal.id);
      const agreed = srow?.agreed ?? "no_second_opinion";
      const sflag = agreed === "yes" ? "yes" : agreed === "no" ? "no" : "--";
      console.log(
        `${pad(`${secs}s`, 4)} voice ${pad(timings.classifyMs ?? 0, 8)} ${pad(timings.transcribeMs ?? 0, 10)} ` +
          `${pad(timings.checksMs ?? 0, 6)} ${pad(timings.secondMs ?? 0, 6)} ${pad(sflag, 4)} ${pad(renderMs, 6)} ${pad(total, 6)} -- -- timing only`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  db.close();

  const secondRate = secondAttempted > 0 ? Math.round((secondFinished / secondAttempted) * 100) : 0;
  const agreeRate = secondFinished > 0 ? Math.round((secondAgreed / secondFinished) * 100) : 0;
  console.log(`text median ${median(textTotals)}ms, slowest ${Math.max(...textTotals)}ms; ` +
    `voice median ${median(voiceTotals)}ms (tone audio, transcription timing only); ` +
    `questioned ${questioned}/${NOTES.length} (${Math.round((questioned / NOTES.length) * 100)}%); ` +
    `failures ${failures}/${NOTES.length}; ` +
    `second check finished in time ${secondFinished}/${secondAttempted} (${secondRate}%), agreed ${secondAgreed}/${secondFinished} (${agreeRate}%); ` +
    `second outcomes: late ${secondLate}, timeout ${secondTimeout}, error ${secondError}; ` +
    `network retries: model ${modelRetries}, second-opinion ${secondRetries}`);
}

await main();
