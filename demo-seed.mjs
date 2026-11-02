// Demo-shop seed: the same fake entries the manual seed script records
// (web/scripts/seed-demo.mjs), but in-process and model-free —
// proposeFromForm + confirmProposal through the real checks and hash chain,
// then the three promises via the promise store, exactly where confirm puts
// them. Boot-fast (milliseconds) and key-independent, so a fresh Render
// container can reseed before it accepts requests. Fake data only.
// Today's 15 keep the manual script's customers, amounts and totals, spread
// across 08:00–now Lagos; 12 backfill rows cover the previous 6 days so
// weekly reports have data.
import { fileURLToPath } from "node:url";
import { proposeFromForm, confirmProposal } from "./voice.mjs";
import { DEMO_SHOP_ID } from "./auth.mjs";
import { lagosDay, addDays } from "./debts.mjs";

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

/*
 * Backfill: one sale + part-payment per previous day, same fake cast,
 * smaller tickets, so weekly reports show a lived-in shop. Shapes mirror
 * today's pairs exactly, so every call passes checks cleanly.
 */
const BACKFILL = [
  { dayOffset: 6, type: "sale", amountNaira: 45000, customer: "Mama Bisi", item: "rice", quantity: 1, unit: "bag", amountPaidNaira: 20000, note: "Mama Bisi buy 1 bag of rice for 45k. She pay 20k." },
  { dayOffset: 5, type: "sale", amountNaira: 9000, customer: "Chinedu", item: "indomie", quantity: 1, unit: "carton", amountPaidNaira: 9000, note: "Chinedu buy 1 carton of indomie for 9k. He pay 9k." },
  { dayOffset: 4, type: "sale", amountNaira: 65000, customer: "Aunty Ngozi", item: "beans", quantity: 1, unit: "bag", amountPaidNaira: 30000, note: "Aunty Ngozi buy 1 bag of beans for 65k. She pay 30k." },
  { dayOffset: 3, type: "sale", amountNaira: 60000, customer: "Ada", item: "beans", quantity: 1, unit: "bag", amountPaidNaira: 25000, note: "Ada buy 1 bag of beans for 60k. She pay 25k." },
  { dayOffset: 2, type: "sale", amountNaira: 45000, customer: "Tunde", item: "rice", quantity: 1, unit: "bag", amountPaidNaira: 15000, note: "Tunde buy 1 bag of rice for 45k. He pay 15k." },
  { dayOffset: 1, type: "sale", amountNaira: 45000, customer: "Alhaji Musa", item: "groundnut oil", quantity: 1, unit: "tin", amountPaidNaira: 20000, note: "Alhaji Musa buy 1 tin of groundnut oil for 45k. He pay 20k." },
];

// Promises the manual seed records: Ngozi's and Ada's are due today,
// Tunde's tomorrow. Statuses resolve dynamically (Ada's is kept by the
// payment above; the rest age normally).
const PROMISES = [
  { customer: "Aunty Ngozi", amountNaira: 50000, dayOffset: 0 },
  { customer: "Ada", amountNaira: 20000, dayOffset: 0 },
  { customer: "Tunde", amountNaira: 45000, dayOffset: 1 },
];

// "YYYY-MM-DD" in Lagos (UTC+1, no daylight saving), n days after now.
function lagosDayStr(n, nowMs) {
  return addDays(lagosDay(nowMs), n);
}

// Africa/Lagos has no DST (UTC+1), so a Lagos wall clock "HH:MM" on day
// "YYYY-MM-DD" is that UTC instant shifted one hour back.
function lagosWallToIso(day, minutes) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) + (minutes - 60) * 60000).toISOString();
}

// Fixed clock time inside a past day (late morning to mid-afternoon,
// staggered by day so the week reads naturally). Deterministic in order,
// always inside its own day, always in the past.
function backfillIso(today, dayOffset) {
  return lagosWallToIso(addDays(today, -dayOffset), 560 + ((dayOffset * 67) % 380));
}

// Backdates one proposal's entries to a fixed instant. The ledger is
// append-only, so the stamp must ride the proposal into confirm — after
// confirm it is hash-chained history and can never move.
function stampProposalEntries(deps, proposalId, createdAt) {
  const row = deps.proposals.get(proposalId);
  const env = JSON.parse(row.entries_json);
  for (const e of env.entries) e.createdAt = createdAt;
  deps.proposals.update(proposalId, { envelope: env });
}

function seedCall(deps, shopId, fields, createdAt, now, label) {
  const proposal = proposeFromForm(shopId, fields, {
    proposals: deps.proposals,
    ledger: deps.ledger,
    products: deps.products ?? null,
    now,
  });
  if (proposal.question || proposal.flags.length > 0) {
    throw new Error(`demo seed ${label} did not pass checks cleanly: ${proposal.question ?? proposal.flags.join("; ")}`);
  }
  stampProposalEntries(deps, proposal.id, createdAt);
  const { recordedIds } = confirmProposal(proposal.id, shopId, {
    proposals: deps.proposals,
    ledger: deps.ledger,
    promises: deps.promises ?? null,
    products: deps.products ?? null,
  });
  return recordedIds.length;
}

// Seeds the demo shop when it has no ledger entries yet. Real shops and a
// demo that already exists are untouched. Returns { seeded, entries }.
//
// Timing: backfill lands on the previous 6 days (oldest first, so seq order
// is chronological), today's 15 keep their customers, amounts and totals and
// spread across 08:00–now Lagos in seed order (restocks land in the morning,
// sales through the day). Slots are fixed fractions, so order is
// deterministic; every stamp is clamped to now, so nothing is ever future.
// A pre-08:00 boot collapses today's window to now (same as the old seed).
//
// Cleanliness: the trigger is unchanged (empty ledger only). Before writing,
// stale visitor drafts and promises for the shop are cleared, so a pending
// correction draft confirmed after reseed cannot "correct" the new rows
// reusing its ids, and leftover promises cannot pollute the demo debts.
// Corrections_log needs no purge: the ledger is append-only, so an empty
// ledger means no correction row — and no reason — can exist for the shop.
export function seedDemoShop(deps, { shopId = DEMO_SHOP_ID, now = Date.now() } = {}) {
  if (!deps?.proposals || !deps?.ledger) throw new Error("seedDemoShop needs { proposals, ledger }");
  if (deps.ledger.list(shopId).length > 0) return { seeded: false, entries: 0 };
  const db = deps.proposals.db ?? deps.ledger.db;
  const staleProposals = db
    .prepare("SELECT id FROM proposals WHERE shop_id = ? AND status = 'pending'")
    .all(shopId)
    .map((r) => r.id);
  if (staleProposals.length > 0) {
    if (deps.secondOpinions) {
      const ids = staleProposals.map(() => "?").join(",");
      deps.secondOpinions.db
        .prepare(`DELETE FROM second_opinions WHERE proposal_id IN (${ids})`)
        .run(...staleProposals);
    }
    db.prepare("DELETE FROM proposals WHERE shop_id = ? AND status = 'pending'").run(shopId);
  }
  if (deps.promises) {
    deps.promises.db.prepare("DELETE FROM promises WHERE shop_id = ?").run(shopId);
  }
  const today = lagosDay(now);
  const dayStartMs = Date.parse(lagosWallToIso(today, 8 * 60));
  let entries = 0;
  BACKFILL.forEach((fields, i) => {
    entries += seedCall(deps, shopId, fields, backfillIso(today, fields.dayOffset), now, `backfill ${i + 1}`);
  });
  ENTRIES.forEach((fields, i) => {
    // Even spacing across [08:00, now]; clamps to now, never the future.
    const t = ENTRIES.length <= 1 ? now : Math.min(dayStartMs + ((now - dayStartMs) * i) / (ENTRIES.length - 1), now);
    entries += seedCall(deps, shopId, fields, new Date(t).toISOString(), now, `entry ${i + 1}`);
  });
  for (const p of PROMISES) {
    if (!deps.promises) throw new Error("seedDemoShop needs { promises } to record the demo promises");
    deps.promises.create({
      shopId,
      customer: p.customer,
      amountKobo: p.amountNaira * 100,
      dueDate: lagosDayStr(p.dayOffset, now),
    });
  }
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
