// Repeatability check: sends the same 3 fake text notes through the real
// propose() step 5 times each and prints how many distinct results each note
// produced. Real model only — needs META_API_KEY in the environment (read
// from process.env, never printed). Each run uses a fresh identical
// in-memory store, so differences between runs are model variance, not
// state. Baseten keys come from process.env when present, as in production.
//
// Usage: META_API_KEY=... node scripts/repeat-check.mjs
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "../ledger.mjs";
import { ProposalStore } from "../proposals.mjs";
import { ProductStore } from "../products.mjs";
import { SecondOpinionStore } from "../secondopinion.mjs";
import { createModelClient } from "../model.mjs";
import { propose } from "../voice.mjs";

const SHOP = "repeat-shop";
const RUNS = 5;

// Fake notes: the reported flaky debt line, an each/total quantity line, and
// a sale with a promise.
const NOTES = [
  "Mummy Patrick dey owe me 5k",
  "Sold 12 bags of rice to Ngozi, 45k each, she pay 200k",
  "Ada buy 2 cartons of Indomie for 15k, she go pay Friday",
];

function seed(ctx) {
  ctx.ledger.append({ shopId: SHOP, type: "restock", amountKobo: 90000000, customer: SHOP, item: "rice", quantity: 20, unit: "bag" });
  ctx.products.ensure({ shopId: SHOP, name: "rice", unit: "bag" });
  ctx.products.ensure({ shopId: SHOP, name: "Indomie", unit: "carton" });
}

// The trader-visible core of a proposal: entries, the question, the promise.
// Flags, notes and assumption wording are code-derived from these.
function canonical(proposal) {
  return JSON.stringify({
    entries: (proposal.entries ?? []).map((e) => [e.type, e.customer, e.item, e.quantity, e.unit, e.amountKobo, e.priceBasis]),
    question: proposal.question ?? null,
    promise: proposal.promise ? [proposal.promise.customer, proposal.promise.datePhrase, proposal.promise.amountKobo] : null,
  });
}

async function main() {
  if (!process.env.META_API_KEY) {
    console.error("repeat-check needs META_API_KEY in the environment (real model only, nothing is confirmed).");
    process.exit(1);
  }
  const model = createModelClient({ apiKey: process.env.META_API_KEY });
  for (const note of NOTES) {
    const variants = new Map();
    for (let r = 0; r < RUNS; r++) {
      const db = new DatabaseSync(":memory:");
      const ctx = {
        ledger: new Ledger(db),
        proposals: new ProposalStore(db),
        products: new ProductStore(db),
        secondOpinions: new SecondOpinionStore(db),
      };
      seed(ctx);
      const proposal = await propose(SHOP, note, {
        proposals: ctx.proposals,
        model,
        ledger: ctx.ledger,
        products: ctx.products,
        secondOpinions: ctx.secondOpinions,
        secondOpinionEnv: process.env,
      });
      const key = canonical(proposal);
      variants.set(key, (variants.get(key) ?? 0) + 1);
      db.close();
    }
    console.log(`"${note}" -> ${variants.size} distinct result(s) in ${RUNS} runs`);
    let i = 0;
    for (const [key, count] of variants) {
      i++;
      console.log(`  variant ${i} (x${count}): ${key}`);
    }
  }
}

await main();
