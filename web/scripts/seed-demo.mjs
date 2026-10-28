// Fills the "demo-shop" with fake entries and promises so every screen of
// the web app has something to show. Fake data only — invented names,
// items and amounts. Uses the backend's own Ledger and PromiseStore, so the
// hash chain is real, and writes ONLY to the database file given:
//
//   node scripts/seed-demo.mjs                 -> web/demo.db
//   node scripts/seed-demo.mjs --db path.db    -> any other file
//
// Then start the backend with LEDGER_DB pointing at the same file. Dates are
// relative to today, so re-seed a fresh file before each demo. Refuses to
// add to a demo shop that already has entries (delete the file to reset).
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Ledger } from "../../ledger.mjs";
import { PromiseStore } from "../../promises.mjs";
import { lagosDay, addDays } from "../../debts.mjs";

export const DEMO_SHOP_ID = "demo-shop";

const dbFlag = process.argv.indexOf("--db");
const dbPath = dbFlag !== -1 ? process.argv[dbFlag + 1] : fileURLToPath(new URL("../demo.db", import.meta.url));

const today = lagosDay(Date.now());
// "d days ago at hh:00 Lagos time" as an ISO string (Lagos is UTC+1, no DST).
const at = (d, hh) => new Date(`${addDays(today, -d)}T${String(hh).padStart(2, "0")}:00:00+01:00`).toISOString();
const due = (d) => addDays(today, d); // promise due day, d days from today

// Oldest first, so the chain's order matches the dates. Amounts in naira.
const ENTRIES = [
  { d: 45, h: 8, type: "restock", customer: "Alaba Wholesalers", item: "rice", unit: "bag", quantity: 10, naira: 520000 },
  { d: 45, h: 9, type: "restock", customer: "Oyingbo Depot", item: "indomie", unit: "carton", quantity: 20, naira: 180000 },
  { d: 42, h: 8, type: "restock", customer: "Oyingbo Depot", item: "groundnut oil", unit: "tin", quantity: 4, naira: 168000 },
  { d: 40, h: 11, type: "sale", customer: "Alhaji Musa", item: "groundnut oil", unit: "tin", quantity: 2, naira: 90000 },
  { d: 36, h: 9, type: "sale", customer: "Mama Bisi", item: "rice", unit: "bag", quantity: 2, naira: 118000 },
  { d: 35, h: 10, type: "payment", customer: "Mama Bisi", naira: 100000 },
  { d: 25, h: 14, type: "sale", customer: "Chinedu", item: "indomie", unit: "carton", quantity: 3, naira: 27000 },
  { d: 25, h: 14, type: "payment", customer: "Chinedu", naira: 27000 },
  { d: 22, h: 8, type: "restock", customer: "Alaba Wholesalers", item: "beans", unit: "bag", quantity: 5, naira: 300000 },
  { d: 21, h: 10, type: "sale", customer: "Aunty Ngozi", item: "beans", unit: "bag", quantity: 1, naira: 65000 },
  { d: 19, h: 11, type: "payment", customer: "Aunty Ngozi", naira: 15000 },
  { d: 12, h: 15, type: "sale", customer: "Mama Bisi", item: "rice", unit: "bag", quantity: 1, naira: 48000 }, // below cost
  { d: 10, h: 9, type: "sale", customer: "Ada", item: "beans", unit: "bag", quantity: 2, naira: 120000 },
  { d: 8, h: 16, type: "payment", customer: "Ada", naira: 50000 },
  { d: 6, h: 13, type: "sale", customer: "Kemi", item: "rice", unit: "bag", quantity: 9, naira: 468000 }, // 12 bags sold, 10 bought
  { d: 6, h: 13, type: "payment", customer: "Kemi", naira: 468000 },
  { d: 4, h: 10, type: "sale", customer: "Tunde", item: "eggs", unit: "crate", quantity: 2, naira: 15000 }, // never restocked
  { d: 2, h: 11, type: "sale", customer: "Chinedu", item: "indomie", unit: "carton", quantity: 2, naira: 16000 }, // below cost
  { d: 2, h: 11, type: "payment", customer: "Chinedu", naira: 16000 },
];

// All created "open"; the server marks them kept or broken from the ledger
// the first time a screen asks (refreshPromises).
const PROMISES = [
  { customer: "Mama Bisi", naira: 100000, created: 36, dueIn: -34 }, // kept
  { customer: "Alhaji Musa", naira: 90000, created: 38, dueIn: -10 }, // broken
  { customer: "Aunty Ngozi", naira: 15000, created: 21, dueIn: -18 }, // kept
  { customer: "Aunty Ngozi", naira: 50000, created: 2, dueIn: 2 }, // open
  { customer: "Ada", naira: 50000, created: 10, dueIn: -8 }, // kept
  { customer: "Ada", naira: 70000, created: 3, dueIn: 2 }, // open
  { customer: "Tunde", naira: 15000, created: 4, dueIn: -1 }, // broken
];

const db = new DatabaseSync(dbPath);
const ledger = new Ledger(db);
const promises = new PromiseStore(db);

if (ledger.list(DEMO_SHOP_ID).length > 0) {
  console.error(`${DEMO_SHOP_ID} already has entries in ${dbPath}. Delete that file to start fresh.`);
  process.exit(1);
}

for (const e of ENTRIES) {
  ledger.append({
    shopId: DEMO_SHOP_ID,
    type: e.type,
    amountKobo: e.naira * 100,
    customer: e.customer,
    item: e.item ?? null,
    unit: e.unit ?? null,
    quantity: e.quantity ?? null,
    createdAt: at(e.d, e.h),
  });
}
for (const p of PROMISES) {
  promises.create({
    shopId: DEMO_SHOP_ID,
    customer: p.customer,
    amountKobo: p.naira * 100,
    dueDate: due(p.dueIn),
    createdAt: at(p.created, 17),
  });
}

const check = ledger.verify(DEMO_SHOP_ID);
console.log(`Seeded ${DEMO_SHOP_ID}: ${ENTRIES.length} entries, ${PROMISES.length} promises -> ${dbPath}`);
console.log(`Chain verified: ${check.ok}`);
db.close();
