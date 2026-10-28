// Manual smoke test against the real Meta Model API. Fake data only.
// Run:  META_API_KEY=... node smoke-live.mjs ["note text"] [audio-file]
// Proposes only — it never confirms, so the ledger is untouched.
import { propose } from "./voice.mjs";
import { ProposalStore } from "./proposals.mjs";
import { createModelClient } from "./model.mjs";

if (!process.env.META_API_KEY) {
  console.error("Set META_API_KEY in your environment first (never in a file).");
  process.exit(1);
}

// Fake Pidgin note. No real customers, items, or amounts.
const DEFAULT_NOTE = "Ada buy rice 2 bags, na 15k. She pay 10k, remain 5k.";

// First arg: note text. Second arg (optional): audio file path, wins when given.
const audioPath = process.argv[3] ?? null;
const input = audioPath ? { audioPath } : (process.argv[2] ?? DEFAULT_NOTE);

const proposals = new ProposalStore(":memory:");
const model = createModelClient({});
const proposal = await propose("smoke-shop", input, { proposals, model });
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
