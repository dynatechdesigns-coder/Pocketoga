// Fills the "demo" shop with fake data through the backend's real path:
// POST /propose with a fake note, check the proposal, then POST /confirm.
// It never writes the database directly, so the hash chain, the plain-code
// checks and promise handling are exactly what a trader gets.
//
//   1. start the backend:   node --env-file=.env.local server.mjs
//   2. from web/:           npm run seed:demo
//
// Options: BACKEND_URL (default http://localhost:3000), --shop <id>
// (default "demo"). Fake names, items and amounts only.
//
// Safe to run twice: each note is skipped when its entries are already in
// the shop's ledger, so a second run adds nothing and an interrupted run
// carries on where it stopped.
//
// Dates: confirm stamps entries with today's date and promise days resolve
// forward ("today", "tomorrow"), so nothing can start out late. Seed the day
// BEFORE a demo and, on demo day, Aunty Ngozi's promise is broken, Tunde's is
// due today and Ada's is kept. Seeded the same day, both are simply open.

const BASE = (process.env.BACKEND_URL ?? "http://localhost:3000").replace(/\/$/, "");
const shopFlag = process.argv.indexOf("--shop");
const SHOP = shopFlag !== -1 ? process.argv[shopFlag + 1] : "demo";
const MAX_TRIES = 3; // proposals per note before giving up

// Each fake note and exactly what must come back before we press confirm.
// Amounts in naira; promise "day" is 0 for today, 1 for tomorrow.
const NOTES = [
  {
    text: "I buy 10 bags of rice from Alaba Wholesalers, 520k total.",
    expect: [{ type: "restock", customer: "Alaba Wholesalers", naira: 520000 }],
  },
  {
    text: "I buy 5 bags of beans from Alaba Wholesalers, 300k total.",
    expect: [{ type: "restock", customer: "Alaba Wholesalers", naira: 300000 }],
  },
  {
    text: "I buy 2 cartons of indomie from Oyingbo Depot, 18k total.",
    expect: [{ type: "restock", customer: "Oyingbo Depot", naira: 18000 }],
  },
  {
    text: "Mama Bisi buy 2 bags of rice, 118k total. She pay 100k, remain 18k.",
    expect: [
      { type: "sale", customer: "Mama Bisi", naira: 118000 },
      { type: "payment", customer: "Mama Bisi", naira: 100000 },
    ],
  },
  {
    text: "Chinedu buy 3 cartons of indomie, 27k total. He pay 27k.",
    expect: [
      { type: "sale", customer: "Chinedu", naira: 27000 },
      { type: "payment", customer: "Chinedu", naira: 27000 },
    ],
  },
  {
    text: "Aunty Ngozi buy 1 bag of beans for 65k. She pay 15k, remain 50k. She go pay the 50k today.",
    expect: [
      { type: "sale", customer: "Aunty Ngozi", naira: 65000 },
      { type: "payment", customer: "Aunty Ngozi", naira: 15000 },
    ],
    promise: { customer: "Aunty Ngozi", naira: 50000, day: 0 }, // broken from tomorrow
  },
  {
    text: "Ada buy 2 bags of beans, 120k total. She pay 50k, remain 70k. She go pay 20k today.",
    expect: [
      { type: "sale", customer: "Ada", naira: 120000 },
      { type: "payment", customer: "Ada", naira: 50000 },
    ],
    promise: { customer: "Ada", naira: 20000, day: 0 }, // kept by the next note
  },
  {
    text: "Ada pay 20k.",
    expect: [{ type: "payment", customer: "Ada", naira: 20000 }],
  },
  {
    text: "Tunde buy 1 bag of rice for 45k. He never pay. He say he go pay the 45k tomorrow.",
    expect: [{ type: "sale", customer: "Tunde", naira: 45000 }], // below the ₦52,000 cost
    promise: { customer: "Tunde", naira: 45000, day: 1 },
  },
  {
    text: "Alhaji Musa buy 2 tins of groundnut oil, 90k total. He pay 40k, remain 50k.",
    expect: [
      { type: "sale", customer: "Alhaji Musa", naira: 90000 },
      { type: "payment", customer: "Alhaji Musa", naira: 40000 },
    ],
  },
];

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { "x-shop-id": SHOP, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`cannot reach the backend at ${BASE} — is server.mjs running?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error ?? "no detail"}`);
  return data;
}

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// Does a row ({ type, customer, kobo }) match an expected entry? A restock
// may come back with the supplier's name or, when the model leaves the
// supplier out, recorded for the shop itself — both are fine.
function fits(want, row) {
  if (row.type !== want.type || row.kobo !== want.naira * 100) return false;
  if (norm(row.customer) === norm(want.customer)) return true;
  return want.type === "restock" && row.customer === SHOP;
}

// Takes one matching row out of `pool` for every expected entry. Returns the
// pool without them, or null when any expected entry has no match.
function consume(pool, wants) {
  const left = [...pool];
  for (const w of wants) {
    const i = left.findIndex((r) => fits(w, r));
    if (i === -1) return null;
    left.splice(i, 1);
  }
  return left;
}

const describe = (rows) => rows.map((r) => `${r.type} ${r.customer} ₦${r.kobo / 100}`).join(", ");

// "YYYY-MM-DD" in Lagos (UTC+1, no daylight saving), n days after the given
// time. We use the proposal's own timestamp so "today" is the server's today.
const lagosDay = (n, fromIso) => new Date(Date.parse(fromIso) + 3600000 + n * 86400000).toISOString().slice(0, 10);

// Why a proposal must not be confirmed, or null when it matches the note.
function mismatch(proposal, note) {
  if (proposal.flags.length > 0) return `it has checks: ${proposal.flags.join("; ")}`;
  const got = proposal.entries.map((e) => ({ type: e.type, customer: e.customer, kobo: e.amountKobo }));
  const left = consume(got, note.expect);
  if (!left || left.length > 0) {
    const want = note.expect.map((e) => ({ type: e.type, customer: e.customer, kobo: e.naira * 100 }));
    return `entries [${describe(got)}] instead of [${describe(want)}]`;
  }
  const p = proposal.promise;
  if (note.promise) {
    const w = note.promise;
    if (!p) return "the promise was not picked up";
    if (norm(p.customer) !== norm(w.customer) || p.amountKobo !== w.naira * 100 || p.dueDate !== lagosDay(w.day, proposal.created_at)) {
      return `promise ${JSON.stringify(p)} instead of ${w.customer} ₦${w.naira} on ${lagosDay(w.day, proposal.created_at)}`;
    }
  } else if (p) {
    return `an unexpected promise ${JSON.stringify(p)}`;
  }
  return null;
}

async function main() {
  console.log(`Seeding shop "${SHOP}" through ${BASE} (fake data only)`);

  // Ledger rows already saved, consumed note by note. A note whose entries
  // are all present was confirmed on an earlier run.
  const { entries } = await api("GET", "/ledger");
  let have = entries.map((r) => ({ type: r.type, customer: r.customer, kobo: r.amount_kobo }));

  let added = 0;
  let skipped = 0;
  for (const [i, note] of NOTES.entries()) {
    const label = `${i + 1}/${NOTES.length}`;
    const left = consume(have, note.expect);
    if (left) {
      have = left;
      skipped++;
      console.log(`  ${label} already saved, skipped: ${note.text}`);
      continue;
    }

    // The model can read a note differently from one try to the next, so a
    // proposal that does not match is rejected and the note sent again.
    let proposal;
    for (let attempt = 1; ; attempt++) {
      ({ proposal } = await api("POST", "/propose", { text: note.text }));
      // The model sometimes adds an empty promise to a note that has none,
      // which the backend flags. Answer it the way a trader would, with Fix.
      const onlyPromiseChecks = proposal.flags.length > 0 && proposal.flags.every((f) => f.startsWith("promise"));
      if (!note.promise && onlyPromiseChecks) {
        ({ proposal } = await api("POST", `/fix/${proposal.id}`, { correctionText: "There is no promise in this note. Nobody promised to pay." }));
      }
      const why = mismatch(proposal, note);
      if (!why) break;
      await api("POST", `/reject/${proposal.id}`);
      console.error(`  ${label} try ${attempt} rejected: ${why}`);
      if (attempt === MAX_TRIES) {
        console.error(`  Stopped. Nothing wrong was saved; run the command again to retry from this note.`);
        process.exit(1);
      }
    }
    const res = await api("POST", `/confirm/${proposal.id}`);
    added++;
    console.log(`  ${label} saved as entries ${res.recordedIds.join(", ")}: ${note.text}`);
  }

  const { verify } = await api("GET", "/ledger");
  const { report } = await api("GET", "/report");
  const { promises } = await api("GET", "/promises");
  console.log(`Done: ${added} notes saved, ${skipped} already there.`);
  console.log(`Chain verified: ${verify.ok} (${verify.count ?? 0} entries)`);
  console.log(`Owed: ₦${(report.owed.totalKobo / 100).toLocaleString("en-US")} by ${report.owed.customers} customers`);
  console.log(`Promises: ${promises.map((p) => `${p.customer} ${p.status} (due ${p.due_date})`).join(", ")}`);
}

main().catch((err) => {
  console.error(`Seed failed: ${err.message}`);
  process.exit(1);
});
