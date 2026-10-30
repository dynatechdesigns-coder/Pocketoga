// Demo-shop seed: the same fake entries the manual seed script records
// (web/scripts/seed-demo.mjs), but in-process and model-free —
// proposeFromForm + confirmProposal through the real checks and hash chain,
// then the three promises via the promise store, exactly where confirm puts
// them. Boot-fast (milliseconds) and key-independent, so a fresh Render
// container can reseed before it accepts requests. Fake data only.
import { fileURLToPath } from "node:url";
import { proposeFromForm, confirmProposal } from "./voice.mjs";
import { DEMO_SHOP_ID } from "./auth.mjs";

// The 15 canonical demo entries, in seed order: sale+payment pairs ride one
// form call (amountPaidNaira adds the payment), like the manual seed notes.
const ENTRIES = [
  { type: "purchase", amountNaira: 520000, item: "rice", quantity: 10, unit: "bag" },
  { type: "purchase", amountNaira: 300000, item: "beans", quantity: 5, unit: "bag" },
  { type: "purchase", amountNaira: 18000, item: "indomie", quantity: 2, unit: "carton" },
  { type: "sale", amountNaira: 118000, customer: "Mama Bisi", item: "rice", quantity: 2, unit: "bag", amountPaidNaira: 100000, note: "Mama Bisi buy 2 bags of rice, 118k total. She pay 100k, remain 18k." },
  { type: "sale", amountNaira: 27000, customer: "Chinedu", item: "indomie", quantity: 3, unit: "carton", amountPaidNaira: 27000, note: "Chinedu buy 3 cartons of indomie, 27k total. He pay 27k." },
  { type: "sale", amountNaira: 65000, customer: "Aunty Ngozi", item: "beans", quantity: 1, unit: "bag", amountPaidNaira: 15000, note: "Aunty Ngozi buy 1 bag of beans for 65k. She pay 15k, remain 50k." },
  { type: "sale", amountNaira: 120000, customer: "Ada", item: "beans", quantity: 2, unit: "bag", amountPaidNaira: 50000, note: "Ada buy 2 bags of beans, 120k total. She pay 50k, remain 70k." },
  { type: "payment", amountNaira: 20000, customer: "Ada", note: "Ada pay 20k." },
  { type: "sale", amountNaira: 45000, customer: "Tunde", item: "rice", quantity: 1, unit: "bag", note: "Tunde buy 1 bag of rice for 45k. He never pay." },
  { type: "sale", amountNaira: 90000, customer: "Alhaji Musa", item: "groundnut oil", quantity: 2, unit: "tin", amountPaidNaira: 40000, note: "Alhaji Musa buy 2 tins of groundnut oil, 90k total. He pay 40k, remain 50k." },
];

// Promises the manual seed records, keyed by which entry they follow:
// Ngozi's and Ada's are due today, Tunde's tomorrow. Statuses resolve
// dynamically (Ada's is kept by the payment above; the rest age normally).
const PROMISES = [
  { after: 5, customer: "Aunty Ngozi", amountNaira: 50000, dayOffset: 0 },
  { after: 6, customer: "Ada", amountNaira: 20000, dayOffset: 0 },
  { after: 8, customer: "Tunde", amountNaira: 45000, dayOffset: 1 },
];

// "YYYY-MM-DD" in Lagos (UTC+1, no daylight saving), n days after now.
function lagosDay(n, nowMs) {
  return new Date(nowMs + 3600000 + n * 86400000).toISOString().slice(0, 10);
}

// Seeds the demo shop when it has no ledger entries yet. Real shops and a
// demo that already exists are untouched. Returns { seeded, entries }.
export function seedDemoShop(deps, { shopId = DEMO_SHOP_ID, now = Date.now() } = {}) {
  if (!deps?.proposals || !deps?.ledger) throw new Error("seedDemoShop needs { proposals, ledger }");
  if (deps.ledger.list(shopId).length > 0) return { seeded: false, entries: 0 };
  let entries = 0;
  ENTRIES.forEach((fields, i) => {
    const proposal = proposeFromForm(shopId, fields, {
      proposals: deps.proposals,
      ledger: deps.ledger,
      products: deps.products ?? null,
      now,
    });
    if (proposal.question || proposal.flags.length > 0) {
      throw new Error(`demo seed entry ${i + 1} did not pass checks cleanly: ${proposal.question ?? proposal.flags.join("; ")}`);
    }
    const { recordedIds } = confirmProposal(proposal.id, shopId, {
      proposals: deps.proposals,
      ledger: deps.ledger,
      promises: deps.promises ?? null,
      products: deps.products ?? null,
    });
    entries += recordedIds.length;
    for (const p of PROMISES.filter((x) => x.after === i)) {
      if (!deps.promises) throw new Error("seedDemoShop needs { promises } to record the demo promises");
      deps.promises.create({
        shopId,
        customer: p.customer,
        amountKobo: p.amountNaira * 100,
        dueDate: lagosDay(p.dayOffset, now),
      });
    }
  });
  return { seeded: true, entries };
}

// Manual reseed helper (never used by the server): `node demo-seed.mjs`
// fills the DATA_DIR database's demo shop the same way boot does.
const invokedAsMain = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  const { buildDeps } = await import("./server.mjs");
  const deps = buildDeps(process.env);
  try {
    const out = seedDemoShop(deps);
    console.log(out.seeded ? `demo seeded: ${out.entries} entries` : "demo already has entries, nothing seeded");
  } finally {
    deps.db.close();
  }
}
