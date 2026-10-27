// Manual smoke test against the real Meta Model API. Fake data only.
// Run:  META_API_KEY=... node smoke-live.mjs
// Proposes only — it never confirms, so the ledger is untouched.
import { propose } from "./voice.mjs";
import { ProposalStore } from "./proposals.mjs";
import { createModelClient } from "./model.mjs";

if (!process.env.META_API_KEY) {
  console.error("Set META_API_KEY in your environment first (never in a file).");
  process.exit(1);
}

// Fake Pidgin note. No real customers, items, or amounts.
const NOTE = "Ada buy rice 2 bags, na 15k. She pay 10k, remain 5k.";

const proposals = new ProposalStore(":memory:");
const model = createModelClient({});
const proposal = await propose("smoke-shop", NOTE, { proposals, model });
console.log(
  JSON.stringify(
    {
      heard: proposal.heard,
      entries: proposal.entries,
      totals: proposal.totals,
      flags: proposal.flags,
      question: proposal.question,
    },
    null,
    2
  )
);
proposals.close();
