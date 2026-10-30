// Accuracy runner: real-model voice-note accuracy over test-audio/expected.json.
//
// Reads test-audio/expected.json (keys are .wav file names; each has "said"
// and an "entries" list with type, customer, item, quantity, total_naira),
// sends each wav through the same real code path as a WhatsApp voice note —
// propose(shop, { audioPath }, { proposals, model, ledger, products,
// secondOpinions }) with the real Meta client — repeats each file 3 times on
// fresh identical in-memory stores (so run-to-run differences are model
// variance, not state), and prints per note and overall: entry type correct,
// amount correct, customer correct (scored the way the app matches names -
// titles stripped, spacing/case ignored, the app's similar-name rule),
// number of entries correct, run-to-run consistency, and the headline
// silence metric: runs fully correct, runs wrong but flagged (question,
// warning, locked Save, second-opinion disagreement or usual-price note -
// the trader would be warned before saving), and runs wrong and NOT flagged
// (silently wrong, Save enabled). Also writes a summary table to
// accuracy-results.md in the project root (no audio, no secrets).
// Nothing is confirmed; nothing is committed under test-audio/ (gitignored).
//
// Modes: --seeded (default) gives the fake shop a realistic history (known
// customers with debts, catalog products with sell prices, stock on hand) so
// the known-names context, balance checks and usual-price notes can work;
// --empty runs on a fresh shop with no history. With neither flag both modes
// run back to back and both are reported. Needs META_API_KEY;
// BASETEN_API_KEY + BASETEN_MODEL ride along from the environment exactly as
// in production (second opinion on when present, off when absent).
//
// Usage (keys from the environment, never printed):
//   node scripts/accuracy-run.mjs [--seeded|--empty] [wav-file ...]
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "../ledger.mjs";
import { ProposalStore } from "../proposals.mjs";
import { ProductStore } from "../products.mjs";
import { SecondOpinionStore } from "../secondopinion.mjs";
import { SECOND_CHECK_UNAVAILABLE } from "../secondopinion.mjs";
import { createModelClient, TEXT_MODEL, AUDIO_MODEL, MODEL_TEMPERATURE, MODEL_SEED } from "../model.mjs";
import { propose, sameCustomerName } from "../voice.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_AUDIO = join(ROOT, "test-audio");
const SHOP = "accuracy-shop";
const RUNS = 3;

// The production code normalizes "purchase" to "restock" before anything is
// checked or stored; expectations are written in trader words, so normalize
// the same way before comparing.
function normType(t) {
  return t === "purchase" ? "restock" : t;
}

// Customer names score by whole-name equality after normalisation
// (lowercase, titles stripped, all spaces removed): "Auntie Ngozi" and
// "Mama Chine du" match; "Jimusa" and "busy" do not. Substring and typo
// matches never count.
function customersMatch(got, want) {
  if (want === null || want === undefined) return true;
  return sameCustomerName(got, want);
}

// Item names normalise for the consistency check only: lowercase, trimmed,
// singular/plural unified, trader spelling variants unified. Correctness
// still compares the raw spelling.
function normItem(s) {
  let n = String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (n === "gari") n = "garri";
  if (!n.endsWith("ss") && n.endsWith("s") && n.length > 3) n = n.slice(0, -1);
  return n;
}

// Trader-visible core of a proposal for the consistency check.
function canonical(proposal) {
  return JSON.stringify({
    entries: (proposal.entries ?? []).map((e) => [e.type, e.customer, normItem(e.item), e.quantity, e.unit, e.amountKobo, e.priceBasis]),
    question: proposal.question ?? null,
    promise: proposal.promise ? [proposal.promise.customer, proposal.promise.datePhrase, proposal.promise.amountKobo] : null,
  });
}

function entrySummary(e) {
  return `${e.type} ${e.customer ?? "?"} ${e.amountKobo == null ? "?" : `₦${e.amountKobo / 100}`} ${e.item ?? ""}`.trim();
}

function checkRun(proposal, expected) {
  const got = proposal.entries ?? [];
  const want = expected.entries ?? [];
  const countOk = got.length === want.length;
  let typesOk = countOk;
  let amountsOk = countOk;
  let customersOk = countOk;
  if (countOk) {
    for (let i = 0; i < want.length; i++) {
      if (normType(got[i].type) !== normType(want[i].type)) typesOk = false;
      if (want[i].total_naira != null && got[i].amountKobo !== want[i].total_naira * 100) amountsOk = false;
      if (!customersMatch(got[i].customer, want[i].customer)) customersOk = false;
    }
  } else {
    typesOk = false;
    amountsOk = false;
    customersOk = false;
  }
  return { countOk, typesOk, amountsOk, customersOk };
}

// Flagged means the trader would be warned before saving: a question (Save
// locked), a warning flag, or any soft assumption line — second-opinion
// disagreements and usual-price notes included. The "second check not
// available" line is plumbing, not a warning, and never counts.
function isFlagged(proposal) {
  if (proposal.question !== null && proposal.question !== undefined && proposal.question !== "") return true;
  if ((proposal.flags ?? []).length > 0) return true;
  return (proposal.assumptions ?? []).some((a) => a !== SECOND_CHECK_UNAVAILABLE);
}

function freshStores() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    ledger: new Ledger(db),
    proposals: new ProposalStore(db),
    products: new ProductStore(db),
    secondOpinions: new SecondOpinionStore(db),
  };
}

// Realistic shop history, identical for every run: catalog products with
// sell prices (usual-price notes + product matching), stock on hand (no
// negative-stock noise), open debts for the balance checks, and settled
// sale+payment pairs so titled customers are known without debt.
function seedShop(ctx) {
  const products = [
    ["rice", "bag", 85000],
    ["garri", "mudu", 1500],
    ["eggs", "crate", 7500],
    ["beans", "mudu", 2800],
    ["tomato", "tin", 1500],
    ["Indomie", "carton", 6800],
  ];
  for (const [name, unit, sellNaira] of products) {
    const row = ctx.products.ensure({ shopId: SHOP, name, unit });
    ctx.products.setPrices(row.id, { sellPriceKobo: sellNaira * 100 });
  }
  const stock = [
    ["rice", 20, "bag", 45000],
    ["garri", 60, "mudu", 800],
    ["eggs", 30, "crate", 6000],
    ["beans", 40, "mudu", 2000],
    ["tomato", 120, "tin", 900],
    ["Indomie", 50, "carton", 6000],
  ];
  for (const [item, quantity, unit, costNaira] of stock) {
    ctx.ledger.append({ shopId: SHOP, type: "restock", amountKobo: costNaira * 100 * quantity, customer: SHOP, item, quantity, unit });
  }
  const debts = [
    ["Ada", 5000, null, null, null],
    ["Bola", 2500, "garri", 1, "mudu"],
    ["Chinedu", 4000, "tomato", 2, "tin"],
    ["Musa", 10000, "rice", 1, "bag"],
    ["Ngozi", 3000, "beans", 1, "mudu"],
  ];
  for (const [customer, naira, item, quantity, unit] of debts) {
    ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: naira * 100, customer, item, quantity, unit });
  }
  const settled = [
    ["Mama Chinedu", 30000],
    ["Mama Bisi", 5000],
    ["Tunde", 2000],
    ["Mama Eniola", 7000],
  ];
  for (const [customer, naira] of settled) {
    ctx.ledger.append({ shopId: SHOP, type: "sale", amountKobo: naira * 100, customer, item: null, quantity: null, unit: null });
    ctx.ledger.append({ shopId: SHOP, type: "payment", amountKobo: naira * 100, customer, item: null, quantity: null, unit: null });
  }
}

async function runMode({ files, expected, model, seeded }) {
  const rows = [];
  let fullyCorrect = 0;
  let wrongFlagged = 0;
  let wrongSilent = 0;
  let failed = 0;
  const totals = { types: 0, amounts: 0, customers: 0, counts: 0, consistent: 0 };
  for (const file of files) {
    const exp = expected[file];
    const runs = [];
    for (let r = 0; r < RUNS; r++) {
      const ctx = freshStores();
      try {
        if (seeded) seedShop(ctx);
        const proposal = await propose(SHOP, { audioPath: join(TEST_AUDIO, file) }, {
          proposals: ctx.proposals,
          model,
          ledger: ctx.ledger,
          products: ctx.products,
          secondOpinions: ctx.secondOpinions,
          secondOpinionEnv: process.env,
        });
        const check = checkRun(proposal, exp);
        const correct = check.typesOk && check.amountsOk && check.customersOk && check.countOk;
        const flagged = isFlagged(proposal);
        runs.push({ ok: true, key: canonical(proposal), entries: (proposal.entries ?? []).map(entrySummary).join("; ") || "(none)", check, correct, flagged });
      } catch (err) {
        runs.push({ ok: false, error: err.message ?? String(err) });
      } finally {
        ctx.db.close();
      }
    }
    const tallies = new Map();
    for (const run of runs) {
      if (!run.ok) continue;
      tallies.set(run.key, (tallies.get(run.key) ?? 0) + 1);
    }
    const consistency = tallies.size === 0 ? 0 : Math.max(...tallies.values());

    console.log(`--- ${file} ---`);
    console.log(`said: "${exp.said}"`);
    const note = { types: 0, amounts: 0, customers: 0, counts: 0, correct: 0, wrongFlagged: 0, wrongSilent: 0 };
    runs.forEach((run, i) => {
      if (!run.ok) {
        failed++;
        console.log(`run ${i + 1}: FAILED: ${run.error}`);
        return;
      }
      const c = run.check;
      if (c.typesOk) note.types++;
      if (c.amountsOk) note.amounts++;
      if (c.customersOk) note.customers++;
      if (c.countOk) note.counts++;
      let bucket;
      if (run.correct) {
        note.correct++;
        fullyCorrect++;
        bucket = "correct";
      } else if (run.flagged) {
        note.wrongFlagged++;
        wrongFlagged++;
        bucket = "WRONG but flagged";
      } else {
        note.wrongSilent++;
        wrongSilent++;
        bucket = "WRONG and silent";
      }
      console.log(
        `run ${i + 1}: ${run.entries} | types ${c.typesOk ? "ok" : "WRONG"} | amounts ${c.amountsOk ? "ok" : "WRONG"} | ` +
        `customers ${c.customersOk ? "ok" : "WRONG"} | count ${c.countOk ? "ok" : "WRONG"} | ${bucket}`
      );
    });
    console.log(`consistency: ${consistency}/${RUNS} identical`);
    totals.types += note.types;
    totals.amounts += note.amounts;
    totals.customers += note.customers;
    totals.counts += note.counts;
    if (consistency === RUNS) totals.consistent++;
    rows.push({ file, said: exp.said, ...note, consistency });
  }
  const totalRuns = files.length * RUNS;
  return { rows, fullyCorrect, wrongFlagged, wrongSilent, failed, totals, totalRuns, noteCount: files.length };
}

function reportMode(mode, out) {
  console.log(
    `${mode}: ${out.fullyCorrect}/${out.totalRuns} runs fully correct; ` +
    `wrong but flagged ${out.wrongFlagged}/${out.totalRuns}; SILENTLY WRONG ${out.wrongSilent}/${out.totalRuns}` +
    (out.failed > 0 ? `; failed (model error) ${out.failed}` : "")
  );
  console.log(
    `${mode}: types ${out.totals.types}/${out.totalRuns}, amounts ${out.totals.amounts}/${out.totalRuns}, ` +
    `customers ${out.totals.customers}/${out.totalRuns}, counts ${out.totals.counts}/${out.totalRuns}; ` +
    `fully consistent notes ${out.totals.consistent}/${out.noteCount}`
  );
}

function mdMode(mode, out) {
  return [
    `## ${mode}`,
    "",
    "| Note | Said | Types | Amounts | Customers | Count | Consistency | Correct | Wrong, flagged | Wrong, silent |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...out.rows.map((r) =>
      `| ${r.file} | ${r.said} | ${r.types}/${RUNS} | ${r.amounts}/${RUNS} | ${r.customers}/${RUNS} | ` +
      `${r.counts}/${RUNS} | ${r.consistency}/${RUNS} | ${r.correct}/${RUNS} | ${r.wrongFlagged}/${RUNS} | ${r.wrongSilent}/${RUNS} |`
    ),
    "",
    `Overall: ${out.fullyCorrect}/${out.totalRuns} runs fully correct; wrong but flagged ` +
    `${out.wrongFlagged}/${out.totalRuns}; SILENTLY WRONG ${out.wrongSilent}/${out.totalRuns}` +
    (out.failed > 0 ? `; failed (model error) ${out.failed}` : "") + ".",
    "",
  ];
}

async function main() {
  if (!process.env.META_API_KEY) {
    console.error("accuracy-run needs META_API_KEY in the environment (real model only, nothing is confirmed).");
    process.exit(1);
  }
  const rawArgs = process.argv.slice(2);
  const onlySeeded = rawArgs.includes("--seeded");
  const onlyEmpty = rawArgs.includes("--empty");
  const filter = rawArgs.filter((a) => !a.startsWith("--"));
  const expected = JSON.parse(readFileSync(join(TEST_AUDIO, "expected.json"), "utf8"));
  const files = Object.keys(expected).filter((f) => filter.length === 0 || filter.includes(f));
  if (files.length === 0) {
    console.error("no matching files in test-audio/expected.json");
    process.exit(1);
  }
  const model = createModelClient({ apiKey: process.env.META_API_KEY });
  const secondOn = Boolean(process.env.BASETEN_API_KEY && process.env.BASETEN_MODEL);
  const modes = onlySeeded ? ["seeded"] : onlyEmpty ? ["empty"] : ["seeded", "empty"];

  const md = [
    "# Accuracy results",
    "",
    `Real-model voice-note accuracy, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC. Each wav in \`test-audio/expected.json\` sent ${RUNS}x ` +
    `through the real WhatsApp voice-note path (\`propose\` with \`{ audioPath }\`, real Meta client, ` +
    `nothing confirmed). Audio model \`${AUDIO_MODEL}\`, sampling \`temperature: ${MODEL_TEMPERATURE}\` + ` +
    `\`seed: ${MODEL_SEED}\` (text model \`${TEXT_MODEL}\` unused here); second opinion ${secondOn ? "on" : "off"}. ` +
    `Customer names score by whole-name equality after normalisation (lowercase, titles stripped, all spaces removed): titles, case and spacing forgiven; substring and typo matches never count. ` +
    `Flagged = question, warning, locked Save, second-opinion disagreement or usual-price note. ` +
    `Cells show runs out of ${RUNS}. Consistency is the largest group of identical runs.`,
    "",
  ];
  for (const mode of modes) {
    const seeded = mode === "seeded";
    console.log(`=== ${mode} shop (${seeded ? "known customers, debts, prices and stock" : "no history"}) ===`);
    const out = await runMode({ files, expected, model, seeded });
    reportMode(mode, out);
    md.push(...mdMode(mode === "seeded" ? "Seeded shop" : "Empty shop", out));
  }
  writeFileSync(join(ROOT, "accuracy-results.md"), md.join("\n"));
  console.log("wrote accuracy-results.md");
}

await main();
