// Voice-to-confirm loop, backend only. The model only proposes; plain code
// does every check; confirmProposal() is the ONLY path that appends to the
// ledger. Uses fake data in tests; never touches real trader data.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseNaira, formatKobo, extractNairaAmounts } from "./money.mjs";
import { escapeMd, customerOwedKobo, MISMATCH_PREFIX, BAD_AUDIO_JSON, TEXT_FAILED, MODEL_RETRY_FAILED, AUDIO_EMPTY_RETRY } from "./messages.mjs";
import { resolvePromiseDate } from "./promises.mjs";
import { fetchSecondReading, compareReadings, SECOND_OPINION_TIMEOUT_MS, SECOND_CHECK_UNAVAILABLE, SECOND_CHECK_CREDIT, NORMALISED_AMOUNT } from "./secondopinion.mjs";
import { stockLevels, productKey } from "./products.mjs";
import { costBasisByProduct, costBasisKey } from "./profit.mjs";

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;
// Deprecated gate: the second opinion used to run only for flagged notes
// and big money. It now runs in parallel on every text/voice note when keys
// are set (hard 4 s cap, soft on late), so latency never grows. Kept
// exported for compatibility; new code ignores it.
export const SECOND_OPINION_MIN_NAIRA = 100000;
// Types stored in the ledger. The model, hints and forms say "purchase";
// code normalizes it to "restock" before anything is checked or stored, so
// the chain never sees a new type and the hash rules do not change.
export const ENTRY_TYPES = ["sale", "payment", "restock", "expense"];
export const HINT_TYPES = ["sale", "payment", "purchase", "expense"];
export function normalizeEntryType(type) {
  const t = typeof type === "string" ? type.trim().toLowerCase() : "";
  if (t === "purchase") return "restock";
  return ENTRY_TYPES.includes(t) ? t : null;
}
// Expense categories, stored in the item field. Anything the model sends
// that is not on this list becomes "other" in pickExpenseCategory.
export const EXPENSE_CATEGORIES = ["transport", "rent", "power", "wages", "stock-related", "fuel", "data", "other"];
export const PRICE_BASES = ["each", "total", "unclear"];
// Words that mean a price is per item. Checked against the note: the
// trader's words win over the model's price-basis reading, softly.
const EACH_WORDS = /\b(each|per|every|apiece|one-one|one one|a piece)\b/i;

function eachWordHeard(heard, phrase) {
  const m = `${heard ?? ""} ${phrase ?? ""}`.match(EACH_WORDS);
  return m ? m[0].toLowerCase() : "each";
}

function pluralFor(quantity, unit) {
  const u = String(unit ?? "").trim();
  if (!u) return "";
  return quantity === 1 ? u : `${u}s`;
}
// Phrases where the note itself states what is still owed ("remain 5k",
// "balance na 3k", "e remain 2k"). Plain code cross-checks the stated
// figure against the note's own sales-minus-payments, even when the model
// sent no totals.
const STATED_REMAINDER_SRC = "\\b(?:she\\s+still\\s+owes?|e\\s+remains?|remains?\\s+for|remaining|remainder|remains?|balances?|left)\\b";
// Filler words between a remainder phrase and its amount ("remain na 5k",
// "balance for am 5k"). Never amount words.
const REMAINDER_FILLER = new Set([
  "na", "be", "is", "are", "dey", "still", "now", "just",
  "me", "am", "him", "her", "them", "us", "my",
  "for", "to", "of", "the", "o", "oh",
]);
const AUDIO_FORMATS = { ".wav": "wav", ".mp3": "mp3", ".mpeg": "mp3" };

export function voiceError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Row + parsed envelope for callers.
export function toProposal(row) {
  const env = JSON.parse(row.entries_json);
  return {
    id: row.id,
    shop_id: row.shop_id,
    status: row.status,
    heard: row.heard,
    question: row.question,
    created_at: row.created_at,
    entries: env.entries,
    totals: env.totals,
    flags: env.flags,
    notes: env.notes,
    recorded_ids: row.recorded_ids ? JSON.parse(row.recorded_ids) : null,
    name_checked: row.name_checked ? JSON.parse(row.name_checked) : null,
    promise: env.promise ?? null,
    correctionOf: env.correctionOf ?? null,
    correctionReason: env.correctionReason ?? null,
    photoCheck: env.photoCheck ?? null,
    effects: env.effects ?? [],
    source: row.source ?? null,
    hint: env.hint ?? null,
    hintNote: env.hintNote ?? null,
    assumptions: env.assumptions ?? [],
  };
}

function cleanText(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// Code picks the expense category: a list member survives (case-insensitive),
// anything else — including a missing value — becomes "other".
function pickExpenseCategory(raw) {
  const norm = typeof raw === "string" ? raw.trim().toLowerCase().replace(/\s+/g, " ") : "";
  return EXPENSE_CATEGORIES.includes(norm) ? norm : "other";
}

// --- Plain-code checks (never the model) -----------------------------------

// Validates one amount leg: whole non-negative naira + parser cross-check of
// the original phrase. Returns { naira, kobo, phrase } with nulls when absent
// or invalid — callers treat null as missing (blocking, combined into the one
// question). A model/phrase mismatch is soft: the model's figure records with
// a "Tap Fix" assumption, never a block.
function checkLeg(naira, phrase, label, flags, notes, required = false, assumptions = null) {
  const cleanPhrase = cleanText(phrase);
  if (naira === null || naira === undefined) {
    return { naira: null, kobo: null, phrase: cleanPhrase };
  }
  if (typeof naira !== "number" || !Number.isInteger(naira) || naira < 0) {
    return { naira: null, kobo: null, phrase: cleanPhrase };
  }
  const kobo = naira * 100;
  if (cleanPhrase) {
    try {
      const parsed = parseNaira(cleanPhrase);
      if (parsed.kobo !== kobo && assumptions) {
        const line = `Taken as ${formatKobo(kobo)} from "${cleanPhrase}". Tap Fix if it was ${formatKobo(parsed.kobo)}.`;
        if (!assumptions.includes(line)) assumptions.push(line);
      }
    } catch {
      notes.push(`${label}: could not verify amount phrase "${cleanPhrase}"`);
    }
  } else {
    notes.push(`${label}: no amount phrase to cross-check`);
  }
  return { naira, kobo, phrase: cleanPhrase };
}

function checkEntry(rawEntry, index, shopId, flags, notes, heard, assumptions, hint = null) {
  const label = `entry ${index + 1}`;
  const e = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
  let type = normalizeEntryType(e.type);
  if (!type) {
    // The note fits the tapped hint but the type came back unreadable: trust
    // the trader's tap and say so, instead of asking which type it is.
    const hinted = normalizeEntryType(hint);
    if (hinted) {
      type = hinted;
      assumptions.push(`Taken as ${withArticle(TYPE_WORDS[hinted])} from your tap.`);
    } else {
      // Soft: skip the unreadable entry, save the rest. Empty overall still
      // blocks via "no entries to record" below.
      assumptions.push(`Skipped an entry with unknown type "${String(e.type)}". Tap Fix to add it.`);
      return null;
    }
  }
  const { naira, kobo, phrase } = checkLeg(e.amountNaira, e.amountPhrase, label, flags, notes, true, assumptions);

  let basis = e.priceBasis;
  if (!PRICE_BASES.includes(basis)) {
    basis = "unclear";
  }

  let customer = cleanText(e.customer);
  if (!customer) {
    if (type === "restock") {
      customer = shopId; // stock moves into the shop itself
      notes.push(`${label}: no supplier given, recorded for the shop`);
    } else if (type === "expense") {
      customer = shopId; // the shop itself paid
      notes.push(`${label}: no payee given, recorded for the shop`);
    } else {
      // Blocking: the ledger needs a customer. Collected into the one
      // question below (missing amounts first, then missing customers).
      flags.push(`${label}: missing customer name`);
    }
  }

  let item = null;
  if (e.item !== null && e.item !== undefined && e.item !== "") {
    if (typeof e.item !== "string" || !e.item.trim()) {
      item = null;
    } else {
      item = e.item.trim();
    }
  }

  let quantity = null;
  if (e.quantity !== null && e.quantity !== undefined) {
    if (typeof e.quantity !== "number" || !Number.isInteger(e.quantity) || e.quantity <= 0) {
      quantity = null;
    } else {
      quantity = e.quantity;
    }
  }

  let unit = null;
  if (e.unit !== null && e.unit !== undefined && e.unit !== "") {
    if (typeof e.unit !== "string" || !e.unit.trim()) {
      unit = null;
    } else {
      unit = e.unit.trim();
    }
  }

  // Payments store money only: no item, quantity or unit reaches the ledger.
  if (type === "payment") {
    if (basis === "each") {
      assumptions.push("Payment taken as a total.");
      basis = "total";
    }
    if (item !== null || quantity !== null || unit !== null) {
      notes.push(`${label}: payment item and quantity are not stored`);
      item = null;
      quantity = null;
      unit = null;
    }
  }

  // Expenses store money and a category only: quantity and unit never reach
  // the ledger, the amount is always a total, and code picks the category.
  if (type === "expense") {
    if (basis === "each") {
      assumptions.push("Expense taken as a total.");
      basis = "total";
    }
    if (quantity !== null || unit !== null) {
      notes.push(`${label}: expense quantity and unit are not stored`);
      quantity = null;
      unit = null;
    }
    const rawCategory = typeof e.item === "string" ? e.item.trim().toLowerCase().replace(/\s+/g, " ") : "";
    item = pickExpenseCategory(e.item);
    if (rawCategory !== item) assumptions.push("Expense category assumed: other.");
  }

  // The trader's words win over the model's reading: "each/per/one-one"
  // in the note means each, otherwise total. Unclear with quantity stays
  // unclear here and resolves after product matching (catalog price picks
  // the closest reading, else total). Form entries skip the each-to-total
  // guard: unitCostNaira is explicit, not a model guess, and the auto heard
  // text carries no "each" word. When the note says each but the model read
  // a total, the read amount disagrees with the trader's words, so the
  // entries still convert (the trader's words win) AND a blocking flag goes
  // up: 15k total versus 15k each is a different debt.
  const saysEach = EACH_WORDS.test(`${heard ?? ""} ${phrase ?? ""}`);
  const isFormHeard = String(heard ?? "").startsWith("Form:");
  if ((type === "sale" || type === "restock") && quantity !== null && quantity > 1 && naira !== null) {
    if (basis === "total" && saysEach) {
      basis = "each";
      const total = formatKobo(kobo * quantity);
      const line = `Taken as ${formatKobo(kobo)} each (${total} total) from "${eachWordHeard(heard, phrase)}" in your note. Tap Fix if it was total.`;
      if (!assumptions.includes(line)) assumptions.push(line);
      const flag = `note says "${eachWordHeard(heard, phrase)}" but the amount was read as a total`;
      if (!flags.includes(flag)) flags.push(flag);
    } else if (basis === "each" && !saysEach && !isFormHeard) {
      basis = "total";
      const unitWord = unit ? ` ${pluralFor(quantity, unit)}` : "";
      const line = `Taken as ${formatKobo(kobo)} for all ${quantity}${unitWord}, ${formatKobo(Math.round(kobo / quantity))} each. Tap Fix if it was each.`;
      if (!assumptions.includes(line)) assumptions.push(line);
    }
  }

  // Plain code does the each-price math. amountNaira/amountKobo are always the
  // entry total; eachNaira/eachKobo keep the per-item figure for the card.
  let totalNaira = naira;
  let totalKobo = kobo;
  let eachNaira = null;
  let eachKobo = null;
  if (basis === "each") {
    if (quantity === null) {
      // Total unknown without a quantity: null amount blocks as missing.
      totalNaira = null;
      totalKobo = null;
    } else if (naira !== null) {
      totalNaira = naira * quantity;
      totalKobo = kobo * quantity;
      eachNaira = naira;
      eachKobo = kobo;
    }
  } else if (basis === "unclear" && quantity === 1) {
    basis = "total"; // one item: each and total are the same money
    eachNaira = naira;
    eachKobo = kobo;
  }

  // Money known but stock descriptors missing: record the money, move no
  // stock, and say so.
  if ((type === "sale" || type === "restock") && Number.isInteger(totalKobo)) {
    if (item === null) assumptions.push("No item stated; stock unchanged.");
    else if (!Number.isInteger(quantity)) assumptions.push("No quantity stated; stock unchanged.");
  }

  return {
    type,
    customer,
    item,
    quantity,
    unit,
    priceBasis: basis,
    amountNaira: totalNaira,
    amountKobo: totalKobo,
    amountPhrase: phrase,
    eachNaira,
    eachKobo,
  };
}

function checkTotals(rawTotals, flags, notes, assumptions = null) {
  if (rawTotals === null || rawTotals === undefined) return null;
  const t = typeof rawTotals === "object" ? rawTotals : {};
  const total = checkLeg(t.totalNaira, t.totalPhrase, "total", flags, notes, false, assumptions);
  const paid = checkLeg(t.paidNaira, t.paidPhrase, "paid", flags, notes, false, assumptions);
  const remainder = checkLeg(t.remainderNaira, t.remainderPhrase, "remainder", flags, notes, false, assumptions);
  // BLOCKING: the note's own total, paid and remainder do not add up, so
  // the money cannot be recorded safely. The card restates this labelled
  // flag as one Pidgin question; the model's own question about the same
  // mismatch is suppressed.
  if (total.naira !== null && paid.naira !== null && remainder.naira !== null) {
    if (total.naira !== paid.naira + remainder.naira) {
      flags.push(`${MISMATCH_PREFIX}: total ${formatKobo(total.kobo)} but paid ${formatKobo(paid.kobo)} + remainder ${formatKobo(remainder.kobo)}`);
    }
  }
  return {
    totalNaira: total.naira,
    totalKobo: total.kobo,
    totalPhrase: total.phrase,
    paidNaira: paid.naira,
    paidKobo: paid.kobo,
    paidPhrase: paid.phrase,
    remainderNaira: remainder.naira,
    remainderKobo: remainder.kobo,
    remainderPhrase: remainder.phrase,
  };
}

function stripEdgePunct(token) {
  return token.replace(/^['"«(（]+/, "").replace(/[.,;:!?'"»)）]+$/, "");
}

// Amount at the start of the text after a remainder phrase, read with the
// existing money parser. Tries the longest lead-in first so "five thousand"
// wins over "five". Returns kobo, or null when no amount follows.
function parseLeadingKobo(after) {
  const tokens = String(after ?? "")
    .split(/\s+/)
    .map(stripEdgePunct)
    .filter(Boolean);
  let i = 0;
  while (i < tokens.length && REMAINDER_FILLER.has(tokens[i].toLowerCase())) i++;
  const rest = tokens.slice(i, i + 6);
  for (let n = rest.length; n >= 1; n--) {
    try {
      return parseNaira(rest.slice(0, n).join(" ")).kobo;
    } catch {
      // Try a shorter lead-in.
    }
  }
  return null;
}

// First stated remainder in the heard text ("remain 5k" -> 500000 kobo).
// Null when the note states no remainder with a readable amount.
function statedRemainderKobo(heard) {
  const text = String(heard ?? "");
  const re = new RegExp(STATED_REMAINDER_SRC, "gi");
  let m;
  while ((m = re.exec(text)) !== null) {
    const kobo = parseLeadingKobo(text.slice(m.index + m[0].length));
    if (kobo !== null) return kobo;
  }
  return null;
}

// The note's own expected remainder: sale totals minus payments, restock
// excluded (stock, not debt). Null when there is no sale or an amount is
// unknown — e.g. payment-only notes, where "remain 5k" refers to old debt
// this note cannot verify.
function noteExpectedRemainder(entries) {
  let sales = 0;
  let paid = 0;
  let hasSale = false;
  for (const e of entries) {
    if (e.type === "sale") {
      if (!Number.isInteger(e.amountKobo)) return null;
      hasSale = true;
      sales += e.amountKobo;
    } else if (e.type === "payment") {
      if (!Number.isInteger(e.amountKobo)) return null;
      paid += e.amountKobo;
    }
  }
  if (!hasSale) return null;
  return { sales, paid, expected: sales - paid };
}

// Safety net independent of model totals: a remainder stated in the heard
// text should equal sales minus payments in this note. BLOCKING, like the
// totals check above: contradictory money locks Save until the trader fixes
// it. The card collapses every mismatch flag to the same one line.
function checkStatedRemainder(heard, entries, flags, assumptions = null) {
  const stated = statedRemainderKobo(heard);
  if (stated === null) return;
  const note = noteExpectedRemainder(entries);
  if (note === null) return;
  if (stated !== note.expected) {
    flags.push(`${MISMATCH_PREFIX}: sales ${formatKobo(note.sales)} minus paid ${formatKobo(note.paid)} = ${formatKobo(note.expected)}, stated remainder ${formatKobo(stated)}`);
  }
}

// Leading titles stripped before customer names are compared, so
// "Mama Chinedu" matches "Chinedu". Whole leading words only — never
// substrings — and never the whole name.
export const NAME_TITLES = [
  "mama", "mummy", "aunty", "auntie", "oga", "baba", "papa", "alhaji", "alhaja",
  "hajia", "chief", "madam", "mrs", "mr", "sir", "ma", "brother", "bro",
  "sister", "sis", "pastor", "doctor", "dr", "engineer", "engr", "prince",
  "princess", "uncle",
];

function normalizeName(name) {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function stripTitle(normalized) {
  const parts = String(normalized ?? "").split(" ").filter(Boolean);
  let i = 0;
  while (i < parts.length - 1 && NAME_TITLES.includes(parts[i].replace(/\.+$/, ""))) i++;
  return parts.slice(i).join(" ") || String(normalized ?? "");
}

// Plain edit distance over normalized names. Trader ledgers are small, so
// the simple O(n*m) table is plenty.
function editDistance(a, b) {
  let prev = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

// True when two already-normalized, non-equal names may be the same person:
// a small typo, one name extending the other, or a title difference.
// Exported for the photo pipeline's sender check.
// Strict whole-name equality for scoring: lowercase, titles stripped, all
// spaces removed. Deliberately tighter than namesSimilar (which tolerates
// two edits and prefix extension): "Mama Chine du" still matches
// "Mama Chinedu", but "Jimusa" never matches "Musa".
export function sameCustomerName(a, b) {
  const norm = (s) => stripTitle(normalizeName(s)).replace(/ /g, "");
  const na = norm(a);
  const nb = norm(b);
  return na !== "" && na === nb;
}

export function namesSimilar(a, b) {
  if (editDistance(a, b) <= 2) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length >= 3 && long.startsWith(short)) return true;
  const sa = stripTitle(a);
  const sb = stripTitle(b);
  if (sa && sb && sa === sb) return true;
  return false;
}

// Customer matcher over the shop's own ledger names. Titles are stripped on
// both sides before comparing, so "Mama Chinedu" equals "Chinedu".
function customerMatcher(existingCustomers, checkedNames) {
  return {
    stored: (existingCustomers ?? [])
      .filter((c) => typeof c === "string" && normalizeName(c))
      .map((c) => ({ raw: c.trim(), norm: normalizeName(c), stripped: stripTitle(normalizeName(c)) })),
    checked: new Set((checkedNames ?? []).map((n) => normalizeName(n))),
    asked: new Set(),
  };
}

// One heard customer name against the shop's customers. Exact (after title
// stripping) rewrites to the stored spelling; a clearly-closest near match
// does the same; no match at all means a new customer. All three are soft
// assumption lines, never questions. The ONLY name question left: two
// different existing customers about equally close (within one edit of each
// other), which blocks with one short flag.
function matchCustomerName(heardRaw, mc, flags, questioned, assumptions) {
  const heard = heardRaw.trim();
  const norm = normalizeName(heardRaw);
  const stripped = stripTitle(norm);
  const exact = mc.stored.find((s) => s.norm === norm) ?? (stripped ? mc.stored.find((s) => s.stripped === stripped) : undefined);
  if (exact) {
    if (exact.raw === heard) return { action: "silent", name: exact.raw };
    return { action: "taken", name: exact.raw, line: `${heard} taken as your customer ${exact.raw}.` };
  }
  // Already settled on a Fix ("new customer", or asked before): the trader's
  // spelling stands and records as a new customer. Exact matches above still
  // win, so this can never duplicate a stored name.
  if (mc.checked.has(norm) || (stripped && mc.checked.has(stripped))) {
    return { action: "new", name: heard, line: `New customer: ${heard}.` };
  }
  const scored = [];
  for (const s of mc.stored) {
    if (!stripped || !s.stripped) continue;
    const d = editDistance(stripped, s.stripped);
    if (d <= 2) scored.push({ s, d });
  }
  scored.sort((a, b) => a.d - b.d);
  if (scored.length === 0) {
    return { action: "new", name: heard, line: `New customer: ${heard}.` };
  }
  const [best, second] = [scored[0], scored[1]];
  if (!second || second.d - best.d >= 2) {
    return { action: "taken", name: best.s.raw, line: `${heard} taken as your customer ${best.s.raw}.` };
  }
  if (mc.asked.size > 0) {
    return { action: "silent", name: heard }; // one customer question per note at most
  }
  mc.asked.add(stripped);
  questioned.push(stripped);
  flags.push(`Is *${escapeMd(heard)}* ${escapeMd(best.s.raw)} or ${escapeMd(second.s.raw)}? Send the right name, or say new customer.`);
  return { action: "ask", name: heard };
}

// Customer matching for sale/payment entries: rewrites each customer to the
// matched stored spelling and records soft assumption lines. Restock
// suppliers and expense payees are not debt customers and pass untouched.
// Returns the matcher so the promise customer can be resolved the same way.
function checkSimilarNames(entries, shopId, existingCustomers, checkedNames, flags, questioned, assumptions) {
  const mc = customerMatcher(existingCustomers, checkedNames);
  for (const e of entries) {
    if (e.type !== "sale" && e.type !== "payment") continue;
    if (!e.customer || e.customer === shopId) continue;
    if (!normalizeName(e.customer)) continue;
    const out = matchCustomerName(e.customer, mc, flags, questioned, assumptions);
    if (out.action === "taken" || out.action === "new") {
      e.customer = out.name;
      if (!assumptions.includes(out.line)) assumptions.push(out.line);
    }
  }
  return mc;
}

// Product matching: each sale/restock item against the shop's catalog.
// Exact (name, unit) is silent; the closest near name with the same unit is
// assumed (the entry is rewritten to the catalog spelling); no match means
// a new product. All soft assumption lines — products never block.
// Skipped entirely without a catalog.
function checkSimilarProducts(entries, catalog, assumptions, checked = []) {
  if (!catalog || catalog.length === 0) return;
  const checkedSet = new Set((checked ?? []).map((n) => normalizeName(n)));
  const stored = catalog
    .filter((p) => p && normalizeName(p.name))
    .map((p) => ({ name: p.name.trim(), norm: normalizeName(p.name), unit: normalizeName(p.unit ?? "") }));
  for (const e of entries) {
    if ((e.type !== "sale" && e.type !== "restock") || !e.item) continue;
    const heard = e.item.trim();
    const norm = normalizeName(e.item);
    if (!norm) continue;
    const unit = normalizeName(e.unit ?? "");
    if (stored.some((s) => s.norm === norm && s.unit === unit)) continue;
    // Settled as new on a Fix: the trader's spelling stands.
    if (checkedSet.has(`item:${norm}`)) {
      const line = `New product: ${heard}${e.unit ? ` (${String(e.unit).trim()})` : ""}.`;
      if (!assumptions.includes(line)) assumptions.push(line);
      continue;
    }
    const scored = stored
      .filter((s) => s.unit === unit)
      .map((s) => ({ s, d: editDistance(norm, s.norm) }))
      .filter((x) => x.d <= 2)
      .sort((a, b) => a.d - b.d);
    if (scored.length === 0) {
      const line = `New product: ${heard}${e.unit ? ` (${String(e.unit).trim()})` : ""}.`;
      if (!assumptions.includes(line)) assumptions.push(line);
      continue;
    }
    const best = scored[0].s;
    e.item = best.name;
    const line = `${heard} taken as your product ${best.name}${e.unit ? ` (${String(e.unit).trim()})` : ""}.`;
    if (!assumptions.includes(line)) assumptions.push(line);
  }
}

// Where one checked entry lands, in the trader's words. Payments reduce
// what customers owe, so they land in Debts.
export const ENTRY_DESTINATIONS = { sale: "Sales", payment: "Debts", restock: "Products", expense: "Expenses" };

// Per-entry effects, computed by code from the shop's own rows and catalog:
// the destination view, the stock movement (running across entries, so two
// lines for one product chain correctly), and whether a sale's cost is
// unknown (no trader price and no purchase history). Empty without rows,
// so callers without a ledger simply show no effect lines.
export function computeEffects(entries, { rows = null, catalog = null } = {}) {
  if (!Array.isArray(entries) || entries.length === 0 || !rows) return [];
  const levels = new Map(stockLevels(rows));
  const basis = costBasisByProduct(rows);
  const traderCosts = new Map();
  for (const p of catalog ?? []) {
    if (p && p.cost_price_kobo != null) traderCosts.set(costBasisKey(p.name, p.unit), p.cost_price_kobo);
  }
  return entries.map((e) => {
    const effect = {
      destination: ENTRY_DESTINATIONS[e.type] ?? null,
      stockBefore: null,
      stockAfter: null,
      stockItem: null,
      stockUnit: null,
      negativeStock: false,
      costUnknown: false,
    };
    if ((e.type !== "sale" && e.type !== "restock") || !e.item || !Number.isInteger(e.quantity)) return effect;
    const before = levels.get(productKey(e.item, e.unit)) ?? 0;
    const after = before + (e.type === "restock" ? e.quantity : -e.quantity);
    levels.set(productKey(e.item, e.unit), after);
    effect.stockBefore = before;
    effect.stockAfter = after;
    effect.stockItem = e.item;
    effect.stockUnit = e.unit ?? null;
    effect.negativeStock = after < 0;
    if (e.type === "sale") {
      const b = basis.get(costBasisKey(e.item, e.unit));
      effect.costUnknown = traderCosts.get(costBasisKey(e.item, e.unit)) == null && (!b || b.qty <= 0);
    }
    return effect;
  });
}

// Trader words for stored types: the ledger says restock, the trader tapped
// purchase.
const TYPE_WORDS = { sale: "sale", payment: "payment", restock: "purchase", expense: "expense" };

function withArticle(word) {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

// The hint-mismatch sentence for the card: the note clearly says something
// other than the tapped hint, so code says so and classifies as heard.
// Null when the hint is absent, unknown, or matches at least one entry.
export function hintMismatchNote(hint, entries) {
  if (!hint || !Array.isArray(entries) || entries.length === 0) return null;
  const want = normalizeEntryType(hint);
  if (!want || entries.some((e) => e && e.type === want)) return null;
  const said = withArticle(TYPE_WORDS[want]);
  if (entries.length === 1 && TYPE_WORDS[entries[0]?.type]) {
    const heardWord = TYPE_WORDS[entries[0].type];
    return `You said this was ${said}, but it sounds like ${withArticle(heardWord)}. Saving it as ${withArticle(heardWord)}.`;
  }
  return `You said this was ${said}, but it sounds like something else. Saving each entry as heard.`;
}

// Distinct customer names already in the shop's own ledger. Empty when no
// ledger was supplied, so those callers skip the similar-name check.
// Known-names hint for the model call: the shop's existing customers and
// catalog products, capped so the prompt stays short. Helps audio
// transcription pick "Ada" over "dado" and text extraction reuse exact
// spellings. Null when the shop has neither.
function modelContext(ledgerRows, catalog) {
  const customers = [];
  for (const r of ledgerRows ?? []) {
    if (typeof r?.customer === "string" && r.customer.trim() && !customers.includes(r.customer)) {
      customers.push(r.customer);
      if (customers.length >= 20) break;
    }
  }
  const items = [];
  for (const p of catalog ?? []) {
    if (typeof p?.name === "string" && p.name.trim() && !items.includes(p.name)) {
      items.push(p.name);
      if (items.length >= 20) break;
    }
  }
  if (customers.length === 0 && items.length === 0) return null;
  const parts = [];
  if (customers.length > 0) parts.push(`customers: ${customers.join(", ")}`);
  if (items.length > 0) parts.push(`products: ${items.join(", ")}`);
  const debts = [];
  for (const name of customers) {
    const owed = customerOwedKobo({ existing: ledgerRows, proposalEntries: [], customer: name });
    if (Number.isInteger(owed) && owed > 0 && owed % 100 === 0) debts.push(`${name} owes ${owed / 100}`);
  }
  if (debts.length > 0) parts.push(`balances owed (naira): ${debts.join(", ")}`);
  return `Known names (exact spellings; prefer these when the note sounds like them) — ${parts.join("; ")}.`;
}

function shopCustomers(ledger, shopId) {
  if (!ledger || typeof ledger.list !== "function") return [];
  const seen = new Set();
  for (const row of ledger.list(shopId)) {
    if (typeof row.customer === "string" && row.customer.trim() && !seen.has(row.customer)) {
      seen.add(row.customer);
    }
  }
  return [...seen];
}

// Promise validation. The model only supplies the customer's day-phrase;
// code resolves it to a real date. Anything unclear becomes a clarifying
// question — never a guess. Returns the envelope promise or null.
// Promise dates are soft: code resolves the day-phrase, and whatever it
// cannot resolve becomes "no pay date" on the card — never a question. The
// debt itself always records. Never flags; malformed model output degrades
// to notes. dueDate null means "no pay date set".
function checkPromise(rawPromise, notes, nowMs) {
  if (rawPromise === null || rawPromise === undefined) return null;
  if (typeof rawPromise !== "object" || Array.isArray(rawPromise)) {
    notes.push("ignoring promise with unknown shape");
    return null;
  }
  const customer = cleanText(rawPromise.customer);
  if (!customer) {
    notes.push("ignoring promise without a customer");
    return null;
  }
  const datePhrase = cleanText(rawPromise.datePhrase);
  const dueDate = datePhrase ? resolvePromiseDate(datePhrase, nowMs) : null;
  let amountNaira = null;
  if (rawPromise.amountNaira !== null && rawPromise.amountNaira !== undefined) {
    if (typeof rawPromise.amountNaira !== "number" || !Number.isInteger(rawPromise.amountNaira) || rawPromise.amountNaira < 0) {
      notes.push("ignoring bad promise amount");
    } else {
      amountNaira = rawPromise.amountNaira;
    }
  }
  return { customer, datePhrase, amountNaira, amountKobo: amountNaira === null ? null : amountNaira * 100, dueDate };
}

// Overpayments against a KNOWN balance block with one short question: the
// money cannot be recorded safely (typo? wrong customer?). Payments for
// customers with no recorded balance pass freely — code cannot judge an
// advance or an unrecorded history — as do payments settled inside the note
// by their own sale. Skipped entirely without ledger rows.
function checkOverpayment(entries, ledgerRows, flags) {
  if (!ledgerRows) return;
  const paidBy = new Map();
  const soldTo = new Set();
  for (const e of entries) {
    if (!e.customer) continue;
    const norm = normalizeName(e.customer);
    if (e.type === "sale") soldTo.add(norm);
    if (e.type === "payment" && Number.isInteger(e.amountKobo)) {
      paidBy.set(norm, (paidBy.get(norm) ?? 0) + e.amountKobo);
    }
  }
  for (const [norm, paid] of paidBy) {
    if (soldTo.has(norm)) continue;
    const name = entries.find((e) => e.type === "payment" && normalizeName(e.customer) === norm)?.customer ?? norm;
    const owed = customerOwedKobo({ existing: ledgerRows, proposalEntries: [], customer: name });
    if (owed > 0 && paid > owed) {
      flags.push(`${name} owes ${formatKobo(owed)} but ${formatKobo(paid)} was paid. Which is right?`);
    }
  }
}

// Number sanity checks (plain code, never the model). All three run after
// every other check, just before the question is picked.

// (a) Payments against the actual balance. Overpayment of a known debt
// already blocks above; this adds the soft side, Save enabled: a payment for
// a customer with no recorded debt, and a "remain"/"balance" payment that
// does not match the recorded balance.
const REMAINDER_PHRASE_RE = /\b(remains?|remaining|remainder|balances?|rest|left)\b/i;
// "The remain / the balance / the rest" with no stated amount: the amount is
// the customer's recorded balance. Fills amountNaira/amountKobo from the
// ledger (whole naira only) with a soft line; an unknown or zero balance
// keeps blocking as missing. A spoken amount always wins and is checked
// separately against the balance.
function fillRemainFromBalance(entries, ledgerRows, heard, assumptions) {
  if (!ledgerRows) return;
  for (const e of entries) {
    if (e.type !== "payment" || Number.isInteger(e.amountKobo) || !e.customer) continue;
    if (!REMAINDER_PHRASE_RE.test(`${e.amountPhrase ?? ""} ${heard ?? ""}`)) continue;
    const owed = customerOwedKobo({ existing: ledgerRows, proposalEntries: [], customer: e.customer });
    if (!Number.isInteger(owed) || owed <= 0 || owed % 100 !== 0) continue;
    e.amountNaira = owed / 100;
    e.amountKobo = owed;
    const line = `Taken as ${formatKobo(owed)} (the balance ${e.customer} owes).`;
    if (!assumptions.includes(line)) assumptions.push(line);
  }
}

function checkPaymentBalance(entries, ledgerRows, flags, assumptions) {
  if (!ledgerRows) return;
  const paidBy = new Map();
  const soldTo = new Set();
  for (const e of entries) {
    if (!e.customer) continue;
    const norm = normalizeName(e.customer);
    if (e.type === "sale") soldTo.add(norm);
    if (e.type === "payment" && Number.isInteger(e.amountKobo)) {
      const cur = paidBy.get(norm) ?? { total: 0, name: e.customer, remain: null };
      cur.total += e.amountKobo;
      if (REMAINDER_PHRASE_RE.test(e.amountPhrase ?? "")) cur.remain = e.amountKobo;
      paidBy.set(norm, cur);
    }
  }
  for (const [norm, paid] of paidBy) {
    if (soldTo.has(norm)) continue;
    const owed = customerOwedKobo({ existing: ledgerRows, proposalEntries: [], customer: paid.name });
    if (owed > 0 && paid.total > owed) continue; // blocked above as overpayment
    if (owed <= 0) {
      const line = `No debt recorded for ${paid.name}, yet ${formatKobo(paid.total)} was paid.`;
      if (!assumptions.includes(line)) assumptions.push(line);
      continue;
    }
    if (paid.remain !== null && paid.remain !== owed) {
      const line = `Note says the remaining ${formatKobo(paid.remain)} but ${paid.name} owes ${formatKobo(owed)}.`;
      if (!assumptions.includes(line)) assumptions.push(line);
    }
  }
}

// (b) Usual-price tripwire (soft, Save enabled): a sale/restock whose
// per-unit price differs from the shop's usual price for that item by 5x or
// more gets one "Is this right?" line. Catches decimal-scale model errors
// like a 240,000 total on 6 tins at a usual 1,500.
function checkUsualPrice(entries, catalog, assumptions) {
  if (!catalog || catalog.length === 0) return;
  for (const e of entries) {
    if (e.type !== "sale" && e.type !== "restock") continue;
    if (!e.item || !Number.isInteger(e.amountKobo) || e.amountKobo <= 0) continue;
    const usual = knownUnitPriceKobo(e.item, e.unit, e.type, catalog);
    if (!Number.isInteger(usual) || usual <= 0) continue;
    const perUnit = Number.isInteger(e.eachKobo)
      ? e.eachKobo
      : Number.isInteger(e.quantity) && e.quantity > 0 ? e.amountKobo / e.quantity : e.amountKobo;
    const ratio = perUnit / usual;
    if (ratio >= 5 || ratio <= 0.2) {
      const line = `${e.item} at ${formatKobo(Math.round(perUnit))} each (usual ${formatKobo(usual)}). Is this right?`;
      if (!assumptions.includes(line)) assumptions.push(line);
    }
  }
}

// (c) Heard-vs-amount magnitude tripwire (blocking): when no number spoken in
// the note is within 2x of the entry amount (or its per-unit share), the
// amount is the wrong order of magnitude — e.g. 2500 heard as 25000. One
// short question, Save locked. Skips notes with no spoken digits.
function heardNumbersKobo(heard) {
  // Digits ("2500", "15k") and number words ("seventeen thousand", "five
  // k"): word-spoken amounts must count, or quantity-only digits ("8
  // crates ... seventeen thousand") would false-flag.
  return extractNairaAmounts(heard).map((n) => Math.round(n * 100)).filter((k) => k > 0);
}
// Exact-duplicate entries (a model stutter: the same payment twice) merge
// into one — a payment must never be duplicated in a proposal. Compares the
// final checked fields; only entries with a known amount merge, so questions
// about missing amounts are unaffected. The merge is a soft assumption line
// so the trader sees it; entries are otherwise untouched.
function dedupeEntries(entries, assumptions) {
  const seen = new Map();
  const out = [];
  for (const e of entries) {
    if (!Number.isInteger(e.amountKobo)) {
      out.push(e);
      continue;
    }
    const key = JSON.stringify([e.type, e.customer, e.item, e.quantity, e.unit, e.amountKobo, e.priceBasis]);
    if (seen.has(key)) {
      const line = `Merged a repeated ${e.type} of ${formatKobo(e.amountKobo)} into one.`;
      if (!assumptions.includes(line)) assumptions.push(line);
      continue;
    }
    seen.set(key, true);
    out.push(e);
  }
  return out;
}

function checkHeardMagnitude(heard, entries, flags) {
  const nums = heardNumbersKobo(heard);
  if (nums.length === 0) return;
  for (const e of entries) {
    if (!Number.isInteger(e.amountKobo) || e.amountKobo <= 0) continue;
    const values = [e.amountKobo];
    if (Number.isInteger(e.quantity) && e.quantity > 1) values.push(e.amountKobo / e.quantity);
    const ok = nums.some((n) => values.some((v) => n >= v / 2 && n <= v * 2));
    if (ok) continue;
    const closest = nums.slice().sort((a, b) => Math.abs(Math.log(a / e.amountKobo)) - Math.abs(Math.log(b / e.amountKobo)))[0];
    const heardNaira = closest / 100;
    const heardShown = Number.isInteger(heardNaira) ? heardNaira.toLocaleString("en-US") : String(heardNaira);
    const what = e.item ? `${e.item} reads ` : "the entry reads ";
    flags.push(`Heard ${heardShown} but ${what}${formatKobo(e.amountKobo)}. Which is right?`);
  }
}

function knownUnitPriceKobo(item, unit, type, catalog) {
  if (!item || !catalog || catalog.length === 0) return null;
  if (type !== "sale" && type !== "restock") return null;
  const wantName = normalizeName(item);
  const wantUnit = normalizeName(unit ?? "");
  for (const p of catalog) {
    if (normalizeName(p.name) !== wantName || normalizeName(p.unit ?? "") !== wantUnit) continue;
    if (type === "sale" && Number.isInteger(p.sell_price_kobo)) return p.sell_price_kobo;
    if (type === "restock") {
      if (Number.isInteger(p.cost_price_kobo)) return p.cost_price_kobo;
      if (Number.isInteger(p.sell_price_kobo)) return p.sell_price_kobo;
    }
    return null;
  }
  return null;
}

// Unclear price basis resolves after product matching, softly. Default TOTAL;
// when the shop has a known unit price, the closer reading wins. Never blocks.
function resolveUnclearBasis(entries, catalog, assumptions) {
  for (const e of entries) {
    if (e.priceBasis !== "unclear") continue;
    if (e.type !== "sale" && e.type !== "restock") {
      e.priceBasis = "total";
      continue;
    }
    const qty = e.quantity;
    if (!Number.isInteger(qty) || qty <= 1) {
      e.priceBasis = "total";
      if (qty === 1) {
        e.eachNaira = e.amountNaira;
        e.eachKobo = e.amountKobo;
      }
      continue;
    }
    if (!Number.isInteger(e.amountKobo) || !Number.isInteger(e.amountNaira)) {
      e.priceBasis = "total";
      continue;
    }
    const statedKobo = e.amountKobo;
    const statedNaira = e.amountNaira;
    const known = knownUnitPriceKobo(e.item, e.unit, e.type, catalog);
    let useEach = false;
    if (known !== null) {
      useEach = Math.abs(statedKobo - known) < Math.abs(statedKobo / qty - known);
    }
    const unitWord = e.unit ? ` ${pluralFor(qty, e.unit)}` : "";
    if (useEach) {
      e.priceBasis = "each";
      e.eachNaira = statedNaira;
      e.eachKobo = statedKobo;
      e.amountNaira = statedNaira * qty;
      e.amountKobo = statedKobo * qty;
      const line = `Taken as ${formatKobo(statedKobo)} each (${formatKobo(statedKobo * qty)} for all ${qty}${unitWord}). Tap Fix if it was total.`;
      if (!assumptions.includes(line)) assumptions.push(line);
    } else {
      e.priceBasis = "total";
      const eachKobo = Math.round(statedKobo / qty);
      e.eachKobo = eachKobo;
      e.eachNaira = statedNaira % qty === 0 ? statedNaira / qty : null;
      const line = `Taken as ${formatKobo(statedKobo)} for all ${qty}${unitWord}, ${formatKobo(eachKobo)} each. Tap Fix if it was each.`;
      if (!assumptions.includes(line)) assumptions.push(line);
    }
  }
}

function describeMissingAmount(e) {
  const word = TYPE_WORDS[e.type] ?? e.type;
  if (e.item) return `the ${e.item} ${word}`;
  if ((e.type === "sale" || e.type === "payment") && e.customer) {
    return e.type === "sale" ? `the sale to ${e.customer}` : `the payment from ${e.customer}`;
  }
  return `the ${word}`;
}

function combinedAmountQuestion(missing) {
  const parts = missing.map(describeMissingAmount);
  if (parts.length === 1) return `How much was ${parts[0]}?`;
  if (parts.length === 2) return `How much was ${parts[0]} and ${parts[1]}?`;
  return `How much was ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}?`;
}

function describeMissingCustomer(e) {
  if (e.type === "payment" && Number.isInteger(e.amountKobo)) {
    return { verb: "paid", what: formatKobo(e.amountKobo) };
  }
  if (e.item) return { verb: "bought", what: `the ${e.item}` };
  return { verb: "bought", what: "it" };
}

function combinedCustomerQuestion(missing) {
  const clauses = missing.map((e, i) => {
    const d = describeMissingCustomer(e);
    const who = i === 0 ? "Who" : "who";
    return `${who} ${d.verb} ${d.what}`;
  });
  if (clauses.length === 1) return `${clauses[0]}?`;
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}?`;
  return `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}?`;
}

// Runs every check on raw model output. BLOCKING problems (flags) lock Save
// and ask at most two one-line questions; everything else becomes a soft
// assumption line on the card with Save enabled. Blocks when an amount is
// genuinely missing (combined across entries), a customer is missing (the
// ledger needs one), the note's own numbers contradict each other (total,
// paid and stated remainder do not add up), the note says each but the
// amount was read as a total, a payment exceeds what is owed, a heard amount reads at the wrong magnitude, two customers
// are equally close, or there is nothing to record. The model's own question
// echoes back as a flag only when code found nothing to ask — code decides.
// ledgerRows and catalog are optional.
const EACH_FLAG_RE = /^note says ".+" but the amount was read as a total$/;
// A model question that only asks total versus each ("30k na total or per
// crate?"): code already resolved the basis softly, so this never echoes.
// Questions naming an amount, customer, remainder or payment still echo.
const BASIS_ASK_RE = /\bor\b/i;
const BASIS_WORD_RE = /\b(total|each|per)\b/i;
const BASIS_EXCLUDE_RE = /\b(much|who|whom|remain|remainder|correct|paid|pay|owe|owes|owed|owing|price)\b/i;
function isBasisOnlyQuestion(q) {
  return BASIS_ASK_RE.test(q) && BASIS_WORD_RE.test(q) && !BASIS_EXCLUDE_RE.test(q);
}
// The model's own question, echoed as a flag when code asked nothing. The
// card strips the prefix; the second-opinion merge below matches both forms.
const MODEL_QUESTION_PREFIX = "needs clarification: ";
export function checkModelOutput(
  raw,
  shopId,
  { existingCustomers = [], checkedNames = [], now = Date.now(), ledgerRows = null, catalog = null, hint = null } = {}
) {
  const flags = [];
  const notes = [];
  const assumptions = [];
  const questionedNames = [];
  const heard = cleanText(raw?.heard) ?? "(no transcript)";
  let entries = [];
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) {
    flags.push("model returned no entries list");
  } else {
    entries = raw.entries.map((e, i) => checkEntry(e, i, shopId, flags, notes, heard, assumptions, hint)).filter(Boolean);
  }
  const totals = checkTotals(raw?.totals, flags, notes, assumptions);
  checkStatedRemainder(heard, entries, flags, assumptions);
  const matcher = checkSimilarNames(entries, shopId, existingCustomers, checkedNames, flags, questionedNames, assumptions);
  fillRemainFromBalance(entries, ledgerRows, heard, assumptions);
  checkSimilarProducts(entries, catalog, assumptions, checkedNames);
  resolveUnclearBasis(entries, catalog, assumptions);
  entries = dedupeEntries(entries, assumptions);
  const promise = checkPromise(raw?.promise, notes, now);
  if (promise && promise.customer) {
    // The promise customer resolves exactly like entry customers, so the
    // promise row (if any) lands on the same stored spelling.
    const out = matchCustomerName(promise.customer, matcher, flags, questionedNames, assumptions);
    promise.customer = out.name;
    if (out.line && !assumptions.includes(out.line)) assumptions.push(out.line);
  }
  checkOverpayment(entries, ledgerRows, flags);
  checkPaymentBalance(entries, ledgerRows, flags, assumptions);
  checkUsualPrice(entries, catalog, assumptions);
  checkHeardMagnitude(heard, entries, flags);
  // One question at most, by priority. Missing amounts combine across
  // entries; anything not asked this round recomputes after the next Fix.
  let question = null;
  const single = (q) => {
    flags.length = 0;
    flags.push(q);
    question = q;
  };
  if (entries.length === 0) {
    if (flags.length === 0) flags.push("no entries to record");
    question = flags[0];
  } else {
    const missingAmounts = entries.filter((e) => !Number.isInteger(e.amountKobo));
    if (missingAmounts.length > 0) {
      single(combinedAmountQuestion(missingAmounts));
    } else {
      const missingCustomers = entries.filter(
        (e) => (e.type === "sale" || e.type === "payment") && !e.customer
      );
      if (missingCustomers.length > 0) {
        single(combinedCustomerQuestion(missingCustomers));
      } else {
        const mismatch = flags.find((f) => String(f).startsWith(MISMATCH_PREFIX));
        const over = flags.find((f) => /was paid\. Which is right\?$/.test(f));
        const nameQ = flags.find((f) => /Send the right name, or say new customer\.$/.test(f));
        if (mismatch) {
          single(mismatch);
        } else if (over) {
          single(over);
        } else if (nameQ) {
          single(nameQ);
        } else {
          // Leftover code flags that ask nothing (the each-word flag): keep
          // the first non-each one as the question, if any. The each-word
          // flag stands on its own and blocks without asking.
          const first = flags.find((f) => !EACH_FLAG_RE.test(String(f)));
          if (first) single(first);
        }
      }
    }
    // The model's own question echoes back only when code asked nothing: it
    // rides beside a leftover each-word flag at most, never beside a
    // code-built question, and never beside a mismatch (the card restates
    // the mismatch as the one question either way).
    if (!question) {
      const modelQ = cleanText(raw?.question);
      if (modelQ) {
        if (isBasisOnlyQuestion(modelQ)) {
          // Total-vs-each is code's call, never a question: entries already
          // resolved softly above (total by default, each when the note says
          // so, catalog price when known). Say so once if no Taken-as line
          // exists yet.
          if (!assumptions.some((a) => /^Taken as /.test(a))) {
            assumptions.push("Taken as total. Tap Fix if it was each.");
          }
        } else {
          const echo = `${MODEL_QUESTION_PREFIX}${modelQ}`;
          if (!flags.includes(echo)) flags.push(echo);
          question = modelQ;
        }
      }
    }
  }
  const effects = computeEffects(entries, { rows: ledgerRows, catalog });
  return { version: 1, entries, totals, flags, notes, heard, question, questionedNames, promise, effects, assumptions };
}

// --- Input handling --------------------------------------------------------

function normalizeInput(input) {
  if (typeof input === "string") {
    if (!input.trim()) throw voiceError(400, "input text is empty");
    return { kind: "text", text: input.trim() };
  }
  if (input && typeof input === "object") {
    if (input.audioPath) {
      const ext = extname(input.audioPath).toLowerCase();
      const format = AUDIO_FORMATS[ext];
      if (!format) throw voiceError(400, `unsupported audio format "${ext}" (use wav or mp3)`);
      let data;
      try {
        data = readFileSync(input.audioPath).toString("base64");
      } catch {
        throw voiceError(400, `cannot read audio file "${input.audioPath}"`);
      }
      return { kind: "audio", audio: { data, format } };
    }
    if (input.audioBase64) {
      const format = (input.audioFormat ?? "").toLowerCase();
      if (!["wav", "mp3"].includes(format)) {
        throw voiceError(400, 'audioFormat "wav" or "mp3" is required with audioBase64');
      }
      return { kind: "audio", audio: { data: input.audioBase64, format } };
    }
  }
  throw voiceError(400, "input must be text or an audio file");
}

function isBadJson(err) {
  return !!err && err.code === "MODEL_BAD_JSON";
}

function isTruncated(err) {
  return !!err && err.code === "MODEL_TRUNCATED";
}

function confusedEnvelope(heard, kind, modelFailed = false, message = null) {
  // A text note was never heard, so it never gets the didn't-hear line —
  // only voice notes do.
  const msg = message ?? (modelFailed ? MODEL_RETRY_FAILED : kind === "text" ? TEXT_FAILED : BAD_AUDIO_JSON);
  return { envelope: { version: 1, entries: [], totals: null, flags: [msg], notes: [], assumptions: [] }, heard, question: msg };
}

// --- Proposal operations ---------------------------------------------------

// Customer names from already-read rows (same rule as shopCustomers,
// without listing twice).
function customersOf(rows) {
  const seen = new Set();
  for (const r of rows ?? []) {
    if (typeof r.customer === "string" && r.customer.trim() && !seen.has(r.customer)) {
      seen.add(r.customer);
    }
  }
  return [...seen];
}

export async function propose(
  shopId,
  input,
  {
    proposals,
    model,
    ledger = null,
    products = null,
    hint = null,
    now = Date.now(),
    secondOpinions = null,
    secondOpinionFetch = fetch,
    secondOpinionEnv = process.env,
    secondOpinionTimeoutMs = SECOND_OPINION_TIMEOUT_MS,
    secondOpinionMode = "auto",
    timings = null,
  }
) {
  if (!shopId || typeof shopId !== "string") throw voiceError(400, "shopId is required");
  if (!proposals || !model) throw new Error("propose needs { proposals, model }");
  if (hint !== null && hint !== undefined && !HINT_TYPES.includes(String(hint).trim().toLowerCase())) {
    throw voiceError(400, `unknown hint "${String(hint)}" (want sale, payment, purchase or expense)`);
  }
  const cleanHint = hint === null || hint === undefined ? null : String(hint).trim().toLowerCase();
  const norm = normalizeInput(input);
  const fallbackHeard = norm.kind === "text" ? norm.text : "(voice note)";
  const source = norm.kind === "audio" ? "voice" : "text";
  // Second-opinion keys, read once. Without the stats store or keys the
  // feature is off entirely and legacy callers never call out.
  const secondApiKey = secondOpinionEnv?.BASETEN_API_KEY;
  const secondModel = secondOpinionEnv?.BASETEN_MODEL;
  const secondOff = !secondOpinions || !secondApiKey || !secondModel;
  // Text: start the second fetch NOW, in parallel with the main model call
  // below (same input text). Voice must wait for the transcript and starts
  // after the primary (see below), in parallel with checks. Hard 4 s cap,
  // no retry; late or failed is soft ("second check not available").
  let secondFetchPromise = null;
  if (!secondOff && norm.kind === "text" && norm.text.trim()) {
    secondFetchPromise = fetchSecondReading(norm.text, {
      apiKey: secondApiKey,
      model: secondModel,
      fetchFn: secondOpinionFetch,
      timeoutMs: secondOpinionTimeoutMs,
    });
    secondFetchPromise.catch(() => {});
  }
  // The model call starts first so its network time overlaps the local prep
  // below (ledger + catalog reads). Deferred one microtask so a
  // synchronously-throwing model still surfaces as a rejection below, exactly
  // as before. The noop catch only marks the promise handled; the await
  // below still throws into the same handler.
  const modelKey = norm.kind === "audio" ? "transcribeMs" : "classifyMs";
  let modelTruncated = false; // set when both length attempts fail
  const tModel = Date.now();
  const modelPromise = Promise.resolve().then(() =>
    norm.kind === "text"
      ? model.complete({ text: norm.text, ...(cleanHint ? { hint: cleanHint } : null), ...contextArg })
      : model.complete({ audio: norm.audio, ...(cleanHint ? { hint: cleanHint } : null), ...contextArg })
  );
  modelPromise.catch(() => {});
  const ledgerRows = ledger && typeof ledger.list === "function" ? ledger.list(shopId) : null;
  const catalog = products && typeof products.listByShop === "function" ? products.listByShop(shopId) : null;
  let raw;
  try {
  // Known names for the model call above (its callback runs after this sync
  // block, so contextArg is set in time): helps audio hear "Ada" not "dado".
  var knownContext = modelContext(ledgerRows, catalog); // var: hoisted, so the model callback above closes over these;
  var contextArg = knownContext ? { context: knownContext } : null; // assignment runs before the callback fires
    raw = await modelPromise;
  } catch (err) {
    if (isTruncated(err)) modelTruncated = true;
    else if (!isBadJson(err)) throw err; // transport/API errors propagate; nothing stored
    raw = null;
  }
  if (timings) timings[modelKey] = Date.now() - tModel;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const c = confusedEnvelope(fallbackHeard, source, modelTruncated);
    const confused = proposals.create({ shopId, envelope: c.envelope, heard: c.heard, question: c.question, source });
    if (secondOpinions) {
      secondOpinions.record({ proposalId: confused.id, agreed: "no_second_opinion", differingFields: [], latencyMs: 0 });
    }
    return toProposal(confused);
  }
  // Voice: transcript now known; start the second fetch before checks so it
  // overlaps the local checks. Text already started above.
  if (!secondOff && norm.kind === "audio" && !secondFetchPromise) {
    const heardText = typeof raw.heard === "string" ? raw.heard.trim() : "";
    if (heardText && heardText !== "(no transcript)") {
      secondFetchPromise = fetchSecondReading(raw.heard, {
        apiKey: secondApiKey,
        model: secondModel,
        fetchFn: secondOpinionFetch,
        timeoutMs: secondOpinionTimeoutMs,
      });
      secondFetchPromise.catch(() => {});
    }
  }
  const tChecks = Date.now();
  let { heard, question, questionedNames, ...envelope } = checkModelOutput(raw, shopId, {
    existingCustomers: customersOf(ledgerRows),
    now,
    ledgerRows,
    catalog,
    hint: cleanHint,
  });
  if (timings) timings.checksMs = Date.now() - tChecks;
  if (norm.kind === "audio" && envelope.entries.length === 0) {
    // Empty audio result: one silent retry with the same input before
    // telling the trader. A stale second-opinion fetch (if any) is dropped
    // and restarted from the final transcript below. Text notes never retry.
    try {
      const raw2 = await model.complete({ audio: norm.audio, ...(cleanHint ? { hint: cleanHint } : null), ...contextArg });
      if (raw2 && typeof raw2 === "object" && !Array.isArray(raw2)) {
        raw = raw2;
        secondFetchPromise = null;
        ({ heard, question, questionedNames, ...envelope } = checkModelOutput(raw, shopId, {
          existingCustomers: customersOf(ledgerRows),
          now,
          ledgerRows,
          catalog,
          hint: cleanHint,
        }));
      }
    } catch {
      // Keep the first empty result.
    }
  }
  if (norm.kind === "audio" && envelope.entries.length === 0) {
    const retryHeard = heard !== "(no transcript)" ? heard : fallbackHeard;
    const c = confusedEnvelope(retryHeard, source, false, AUDIO_EMPTY_RETRY);
    const confused = proposals.create({ shopId, envelope: c.envelope, heard: c.heard, question: c.question, source });
    if (secondOpinions) {
      secondOpinions.record({ proposalId: confused.id, agreed: "no_second_opinion", differingFields: [], latencyMs: 0 });
    }
    return toProposal(confused);
  }
  if (!secondOff && norm.kind === "audio" && !secondFetchPromise) {
    const heardText = typeof raw.heard === "string" ? raw.heard.trim() : "";
    if (heardText && heardText !== "(no transcript)") {
      secondFetchPromise = fetchSecondReading(raw.heard, {
        apiKey: secondApiKey,
        model: secondModel,
        fetchFn: secondOpinionFetch,
        timeoutMs: secondOpinionTimeoutMs,
      });
      secondFetchPromise.catch(() => {});
    }
  }
  envelope.hint = cleanHint;
  envelope.hintNote = hintMismatchNote(cleanHint, envelope.entries);
  // Second opinion: await the parallel fetch and compare with plain code.
  // A shown disagreement is a soft assumption line — except an amount
  // disagreement, which asks at most one question, merged with any
  // code-built question already on the card. Hidden disagreements (category,
  // unit and the rest) record in the stats and stay off the card. Entries
  // are never touched. Late or failed adds the soft "second check not
  // available" with Save enabled. Never throws.
  let finalQuestion = question;
  let second = { agreed: "no_second_opinion", differingFields: [], latencyMs: 0 };
  if (secondOpinions && secondFetchPromise) {
    const { reading, latencyMs } = await secondFetchPromise;
    if (timings) timings.secondMs = latencyMs;
    second.latencyMs = latencyMs;
    if (!reading) {
      if (!envelope.assumptions.includes(SECOND_CHECK_UNAVAILABLE)) envelope.assumptions.push(SECOND_CHECK_UNAVAILABLE);
    } else {
      let compared = null;
      try {
        compared = compareReadings(envelope.entries, envelope.promise ?? null, reading, {
          shopId,
          now,
          existingCustomers: customersOf(ledgerRows),
        });
      } catch {
        compared = null;
      }
      if (!compared) {
        if (!envelope.assumptions.includes(SECOND_CHECK_UNAVAILABLE)) envelope.assumptions.push(SECOND_CHECK_UNAVAILABLE);
      } else if (!compared.differingFields.some((f) => f !== NORMALISED_AMOUNT)) {
        second = { agreed: "yes", differingFields: compared.differingFields, latencyMs };
      } else {
        second = { agreed: "no", differingFields: compared.differingFields, latencyMs };
        if (compared.line) {
          if (compared.shownField === "amount") {
            if (!finalQuestion) {
              envelope.flags = [...envelope.flags, compared.line];
              finalQuestion = compared.line;
            } else {
              const merged = `${finalQuestion} ${compared.line}`;
              const at = envelope.flags.lastIndexOf(finalQuestion);
              const echoAt = envelope.flags.lastIndexOf(`${MODEL_QUESTION_PREFIX}${finalQuestion}`);
              const i = at !== -1 ? at : echoAt;
              envelope.flags = i === -1
                ? [...envelope.flags, merged]
                : envelope.flags.map((f, j) => (j === i ? merged : f));
              finalQuestion = merged;
            }
          } else if (!envelope.assumptions.includes(compared.line)) {
            envelope.assumptions.push(compared.line);
          }
          if (!envelope.assumptions.includes(SECOND_CHECK_CREDIT)) envelope.assumptions.push(SECOND_CHECK_CREDIT);
        }
      }
    }
  }
  const row = proposals.create({
    shopId,
    envelope,
    heard,
    question: finalQuestion,
    nameChecked: questionedNames.length > 0 ? questionedNames : null,
    source,
  });
  if (secondOpinions) {
    secondOpinions.record({
      proposalId: row.id,
      agreed: second.agreed,
      differingFields: second.differingFields,
      latencyMs: second.latencyMs,
    });
  }
  return toProposal(row);
}

// --- Form path ---------------------------------------------------------------
//
// Structured fields straight into a proposal, with no model call. The same
// checkModelOutput, effects, confirm card and confirm flow apply, so the
// returned proposal object is identical in shape to the voice path's.
// Present-but-wrong input is a plain 400; absent-but-needed input becomes a
// clarifying question, exactly like the voice path. Nothing here touches
// the ledger.
export function proposeFromForm(shopId, fields, { proposals, ledger = null, products = null, now = Date.now(), timings = null } = {}) {
  if (!proposals) throw new Error("proposeFromForm needs { proposals }");
  if (!shopId || typeof shopId !== "string") throw voiceError(400, "shopId is required");
  const f = fields && typeof fields === "object" ? fields : null;
  if (!f) throw voiceError(400, "form fields are required");
  const type = normalizeEntryType(f.type);
  if (!type) throw voiceError(400, `type must be one of sale, payment, purchase or expense (got "${String(f.type)}")`);

  const hasTotal = f.amountNaira !== undefined && f.amountNaira !== null;
  const hasEach = f.unitCostNaira !== undefined && f.unitCostNaira !== null;
  if (hasTotal && hasEach) throw voiceError(400, "give the total amount or the unit cost, not both");
  if (!hasTotal && !hasEach) throw voiceError(400, "an amount is required: amountNaira or unitCostNaira");
  const figure = hasTotal ? f.amountNaira : f.unitCostNaira;
  const figureName = hasTotal ? "amountNaira" : "unitCostNaira";
  if (typeof figure !== "number" || !Number.isInteger(figure) || figure < 0) {
    throw voiceError(400, `${figureName} must be a whole non-negative number (naira)`);
  }
  if (hasEach && (type === "payment" || type === "expense")) {
    throw voiceError(400, "unit cost only applies to a sale or a purchase");
  }
  const quantity = f.quantity ?? null;
  if (quantity !== null && (!Number.isInteger(quantity) || quantity <= 0)) {
    throw voiceError(400, "quantity must be a positive integer");
  }
  if (hasEach && quantity === null) throw voiceError(400, "unitCostNaira needs a quantity");
  if (quantity !== null && type === "payment") throw voiceError(400, "a payment has no quantity");
  if (quantity !== null && type === "expense") throw voiceError(400, "an expense has no quantity");
  const unit = f.unit ?? null;
  if (unit !== null && (typeof unit !== "string" || !unit.trim())) throw voiceError(400, "unit must be text");
  if (unit !== null && type === "payment") throw voiceError(400, "a payment has no unit");
  if (unit !== null && type === "expense") throw voiceError(400, "an expense has no unit");
  const customer = f.customer ?? null;
  if (customer !== null && (typeof customer !== "string" || !customer.trim())) throw voiceError(400, "customer must be text");
  const item = f.item ?? null;
  if (item !== null && (typeof item !== "string" || !item.trim())) throw voiceError(400, "item must be text");
  const category = f.category ?? null;
  if (category !== null && type !== "expense") throw voiceError(400, "category only applies to an expense");
  if (category !== null && (typeof category !== "string" || !category.trim())) throw voiceError(400, "category must be text");
  const paid = f.amountPaidNaira ?? null;
  if (paid !== null && type !== "sale") throw voiceError(400, "amount paid only applies to a sale");
  if (paid !== null && (!Number.isInteger(paid) || paid < 0)) {
    throw voiceError(400, "amountPaidNaira must be a whole non-negative number (naira)");
  }
  const note = f.note ?? null;
  if (note !== null && typeof note !== "string") throw voiceError(400, "note must be text");

  const cleanCustomer = customer && customer.trim() ? customer.trim() : null;
  const cleanItem =
    type === "expense"
      ? category && category.trim()
        ? category.trim()
        : null
      : item && item.trim()
        ? item.trim()
        : null;
  const main = {
    type,
    customer: cleanCustomer,
    item: cleanItem,
    quantity,
    unit: unit && unit.trim() ? unit.trim() : null,
    amountNaira: figure,
    amountPhrase: String(figure),
    priceBasis: hasEach ? "each" : "total",
  };
  const entries = [main];
  if (paid !== null) {
    entries.push({
      type: "payment",
      customer: cleanCustomer,
      item: null,
      quantity: null,
      unit: null,
      amountNaira: paid,
      amountPhrase: String(paid),
      priceBasis: "total",
    });
  }
  const heardAuto = [
    "Form:",
    TYPE_WORDS[type],
    cleanCustomer,
    cleanItem,
    quantity !== null ? `${quantity}${main.unit ? ` ${main.unit}` : ""}` : null,
    String(figure),
  ]
    .filter((x) => x !== null && x !== undefined && x !== "")
    .join(" ");
  const ledgerRows = ledger && typeof ledger.list === "function" ? ledger.list(shopId) : null;
  const catalog = products && typeof products.listByShop === "function" ? products.listByShop(shopId) : null;
  const tChecks = Date.now();
  const { heard: checkedHeard, question, questionedNames, ...envelope } = checkModelOutput(
    { heard: cleanText(note) ?? heardAuto, entries, totals: null, promise: null, question: null },
    shopId,
    { existingCustomers: customersOf(ledgerRows), now, ledgerRows, catalog }
  );
  if (timings) timings.checksMs = Date.now() - tChecks;
  envelope.hint = null;
  envelope.hintNote = null;
  const row = proposals.create({
    shopId,
    envelope,
    heard: checkedHeard,
    question,
    nameChecked: questionedNames.length > 0 ? questionedNames : null,
    source: "form",
  });
  return toProposal(row);
}

// --- Correct-last-entry flow -------------------------------------------------
//
// A correction of the shop's latest entry, proposed first and recorded only
// on confirm — the same rule as notes. The proposal carries exactly one
// entry (the corrected values, in the original's type) plus correctionOf /
// correctionReason; confirm appends a type "correction" row and never edits.

function latestEntry(ledger, shopId) {
  let best = null;
  for (const r of ledger.list(shopId)) {
    if (!best || r.seq > best.seq || (r.seq === best.seq && r.id > best.id)) best = r;
  }
  return best;
}

function isAlreadyCorrected(ledger, shopId, entryId) {
  return ledger.list(shopId).some((r) => r.corrects_id === entryId);
}

// Resolves and validates a correction target. entryId null/undefined means
// the shop's latest. Throws 404 (missing entry / empty shop), 403 (another
// shop), 409 (already corrected, or not the latest).
export function resolveCorrectionTarget(ledger, shopId, entryId) {
  if (!ledger) throw new Error("resolveCorrectionTarget needs a ledger");
  if (entryId === null || entryId === undefined) {
    const latest = latestEntry(ledger, shopId);
    if (!latest) throw voiceError(404, `shop ${shopId} has no entries to correct`);
    if (isAlreadyCorrected(ledger, shopId, latest.id)) {
      throw voiceError(409, `entry ${latest.id} was already corrected`);
    }
    return latest;
  }
  if (!Number.isInteger(entryId) || entryId <= 0) throw voiceError(400, `bad entry id: ${String(entryId)}`);
  const row = ledger.get(entryId);
  if (!row) throw voiceError(404, `entry ${entryId} not found`);
  if (row.shop_id !== shopId) throw voiceError(403, `entry ${entryId} belongs to another shop`);
  if (isAlreadyCorrected(ledger, shopId, row.id)) throw voiceError(409, `entry ${entryId} was already corrected`);
  const latest = latestEntry(ledger, shopId);
  if (!latest || latest.id !== row.id) throw voiceError(409, `entry ${entryId} is not the shop's latest entry`);
  return row;
}

// Trader-supplied corrected values, same rules as the immediate correct
// route: whole non-negative kobo, non-empty text, positive quantities.
// Undefined inherits the original; explicit null clears item/quantity/unit.
function checkCorrectionValues(values) {
  const v = values && typeof values === "object" ? values : {};
  const { amountKobo, customer, item, quantity, unit } = v;
  if (amountKobo !== undefined && (!Number.isInteger(amountKobo) || amountKobo < 0)) {
    throw voiceError(400, "amountKobo must be a non-negative integer (kobo)");
  }
  if (customer !== undefined && customer !== null && (typeof customer !== "string" || customer.length === 0)) {
    throw voiceError(400, "customer must be text");
  }
  if (item !== undefined && item !== null && (typeof item !== "string" || item.length === 0)) {
    throw voiceError(400, "item must be text");
  }
  if (quantity !== undefined && quantity !== null && (!Number.isInteger(quantity) || quantity <= 0)) {
    throw voiceError(400, "quantity must be a positive integer");
  }
  if (unit !== undefined && unit !== null && (typeof unit !== "string" || unit.trim().length === 0)) {
    throw voiceError(400, "unit must be text");
  }
  return { amountKobo, customer, item, quantity, unit };
}

function checkCorrectionReason(reason) {
  const clean = typeof reason === "string" ? reason.trim() : "";
  if (!clean) throw voiceError(400, "correction reason is required");
  return clean;
}

function correctionEnvelope(entry, target, reason, { flags = [], question = null, notes = [] } = {}) {
  return {
    version: 1,
    entries: [entry],
    totals: null,
    flags,
    notes: [`corrects entry ${target.id}`, ...notes],
    promise: null,
    correctionOf: target.id,
    correctionReason: reason,
    assumptions: [],
  };
}

// Proposes a correction with explicit values (the /correct-last route).
// Nothing is recorded; the trader confirms the proposal as usual.
export function proposeCorrection(shopId, entryId, values, { proposals, ledger, reason, heard = null }) {
  if (!proposals || !ledger) throw new Error("proposeCorrection needs { proposals, ledger }");
  if (!shopId || typeof shopId !== "string") throw voiceError(400, "shopId is required");
  const target = resolveCorrectionTarget(ledger, shopId, entryId);
  const cleanReason = checkCorrectionReason(reason);
  const v = checkCorrectionValues(values);
  const amountKobo = v.amountKobo ?? target.amount_kobo;
  const entry = {
    type: target.type,
    customer: v.customer ?? target.customer,
    item: v.item === undefined ? target.item : v.item,
    quantity: v.quantity === undefined ? target.quantity : v.quantity,
    unit: v.unit === undefined ? target.unit : v.unit,
    priceBasis: "total",
    amountNaira: amountKobo % 100 === 0 ? amountKobo / 100 : null,
    amountKobo,
    amountPhrase: null,
    eachNaira: null,
    eachKobo: null,
  };
  const row = proposals.create({
    shopId,
    envelope: correctionEnvelope(entry, target, cleanReason),
    heard: heard ?? cleanReason,
    question: null,
    source: "form",
  });
  return toProposal(row);
}

// Proposes a correction from free text (WhatsApp "fix last <text>"). The
// model reads the note; exactly one entry must come back. Fields the model
// leaves empty inherit the original — the trader states what changes, and
// only that. The entry type always stays the original's.
export async function proposeCorrectionFromText(shopId, entryId, text, { proposals, model, ledger, reason = null }) {
  if (!proposals || !model || !ledger) throw new Error("proposeCorrectionFromText needs { proposals, model, ledger }");
  if (!shopId || typeof shopId !== "string") throw voiceError(400, "shopId is required");
  if (!text || typeof text !== "string" || !text.trim()) throw voiceError(400, "correction text is required");
  const target = resolveCorrectionTarget(ledger, shopId, entryId);
  const raw = await model.complete({ text: text.trim() });
  const checked = checkModelOutput(raw, shopId, { existingCustomers: shopCustomers(ledger, shopId) });
  if (checked.entries.length === 0) {
    throw voiceError(400, "I no hear any entry to correct — abeg talk am again.");
  }
  if (checked.entries.length > 1) {
    throw voiceError(400, `I heard ${checked.entries.length} entries — send the correction for one entry at a time.`);
  }
  const e = checked.entries[0];
  const amountKobo = Number.isInteger(e.amountKobo) ? e.amountKobo : target.amount_kobo;
  const entry = {
    type: target.type,
    customer: e.customer ?? target.customer,
    item: e.item ?? target.item,
    quantity: Number.isInteger(e.quantity) ? e.quantity : target.quantity,
    unit: e.unit ?? target.unit,
    priceBasis: "total",
    amountNaira: amountKobo % 100 === 0 ? amountKobo / 100 : null,
    amountKobo,
    amountPhrase: e.amountPhrase ?? null,
    eachNaira: null,
    eachKobo: null,
  };
  const cleanReason = checkCorrectionReason(reason ?? checked.heard);
  const row = proposals.create({
    shopId,
    envelope: correctionEnvelope(entry, target, cleanReason, { flags: checked.flags, notes: checked.notes }),
    heard: checked.heard,
    question: checked.question,
    source: "text",
  });
  return toProposal(row);
}

// The per-shop check every proposal-scoped operation goes through.
function getOwnedRow(proposals, proposalId, shopId) {
  const id = Number(proposalId);
  if (!Number.isInteger(id) || id <= 0) throw voiceError(400, `bad proposal id: ${String(proposalId)}`);
  const row = proposals.get(id);
  if (!row) throw voiceError(404, `proposal ${id} not found`);
  if (row.shop_id !== shopId) throw voiceError(403, `proposal ${id} belongs to another shop`);
  return row;
}

function applyExpiry(proposals, row) {
  if (row.status === "pending" && Date.now() - Date.parse(row.created_at) > PROPOSAL_TTL_MS) {
    return proposals.update(row.id, { status: "expired" });
  }
  return row;
}

// The ONLY path that appends to the ledger. Idempotent: confirming twice
// records once and reports alreadyConfirmed the second time.
export function confirmProposal(proposalId, shopId, { proposals, ledger, promises = null, products = null, photoChecks = null }) {
  if (!proposals || !ledger) throw new Error("confirmProposal needs { proposals, ledger }");
  const row = applyExpiry(proposals, getOwnedRow(proposals, proposalId, shopId));
  if (row.status === "confirmed") {
    const done = toProposal(row);
    return { proposal: done, recordedIds: done.photoCheck ? [] : JSON.parse(row.recorded_ids), alreadyConfirmed: true };
  }
  if (row.status === "rejected") throw voiceError(409, `proposal ${row.id} was rejected`);
  if (row.status === "expired") throw voiceError(410, `proposal ${row.id} expired; send the note again`);
  const proposal = toProposal(row);
  const isCorrection = proposal.correctionOf !== null && proposal.correctionOf !== undefined;
  const isPhoto = proposal.photoCheck !== null && proposal.photoCheck !== undefined;
  if (proposal.flags.length > 0) {
    throw voiceError(400, `cannot confirm proposal ${row.id}: ${proposal.flags.join("; ")} — send a fix first`);
  }
  // Photo checks record a payment_checks row, never ledger entries. Unknown
  // photos never reach here: they carry flags and stay blocked above.
  if (isPhoto) {
    if (!photoChecks) throw new Error("confirmProposal needs { photoChecks } for photo proposals");
    const pc = proposal.photoCheck;
    if (!Number.isInteger(pc.fields.amountKobo)) {
      throw voiceError(400, `cannot confirm proposal ${row.id}: the alert amount is unknown`);
    }
    const check = photoChecks.create({
      shopId: row.shop_id,
      proposalId: row.id,
      photoType: pc.photoType,
      customer: pc.matchedCustomer ?? null,
      sender: pc.fields.sender,
      amountKobo: pc.fields.amountKobo,
      reference: pc.fields.reference,
      alertDate: pc.fields.date,
      alertStatus: pc.fields.status,
      warnings: pc.warnings,
    });
    const updated = proposals.update(row.id, { status: "confirmed", recordedIds: { paymentCheckId: check.id } });
    return { proposal: toProposal(updated), recordedIds: [], alreadyConfirmed: false };
  }
  if (proposal.entries.length === 0) {
    throw voiceError(400, `cannot confirm proposal ${row.id}: no entries to record`);
  }
  if (isCorrection && proposal.entries.length !== 1) {
    throw voiceError(400, `cannot confirm proposal ${row.id}: a correction records exactly one entry`);
  }
  for (const e of proposal.entries) {
    if (!Number.isInteger(e.amountKobo) || e.amountKobo < 0 || !e.customer) {
      throw voiceError(400, `cannot confirm proposal ${row.id}: an entry failed final checks`);
    }
  }
  // Corrections revalidate their target at confirm time: another entry may
  // have landed since the proposal, or the target may have been corrected
  // another way. Reads only, so this runs before the transaction opens.
  if (isCorrection) resolveCorrectionTarget(ledger, row.shop_id, proposal.correctionOf);
  // One transaction so a mid-confirm failure records nothing. The proposal is
  // marked confirmed right after; a crash in between would need manual review.
  ledger.db.exec("BEGIN IMMEDIATE");
  let recorded;
  try {
    if (isCorrection) {
      const e = proposal.entries[0];
      const created = ledger.appendCorrection(proposal.correctionOf, {
        amountKobo: e.amountKobo,
        customer: e.customer,
        item: e.item,
        quantity: e.quantity,
        unit: e.unit,
      });
      ledger.recordCorrectionReason(created.id, proposal.correctionReason);
      recorded = [created];
    } else {
      recorded = proposal.entries.map((e) =>
        ledger.append({
          shopId: row.shop_id,
          type: e.type,
          amountKobo: e.amountKobo,
          customer: e.customer,
          item: e.item,
          quantity: e.quantity,
          unit: e.unit,
        })
      );
    }
    ledger.db.exec("COMMIT");
  } catch (err) {
    try {
      ledger.db.exec("ROLLBACK");
    } catch {
      // Already rolled back.
    }
    throw err;
  }
  // Confirmed restocks and sales enter the products catalog (prices stay
  // empty until the trader sets them). Outside the ledger transaction like
  // promise creation; a missing store simply skips the catalog.
  if (products) {
    for (const r of recorded) {
      if ((r.type === "sale" || r.type === "restock") && r.item) {
        products.ensure({ shopId: row.shop_id, name: r.item, unit: r.unit });
      }
    }
  }
  // A promise on the proposal is created only now, on confirm — never on
  // propose. Same crash window as the confirmed mark below; the data was
  // validated when the proposal was checked, so this cannot fail on content.
  // A promise without a resolved due date records no row: the debt is in
  // the ledger, the card said "no pay date", and nothing else is needed.
  if (proposal.promise && proposal.promise.dueDate) {
    if (!promises) throw new Error("confirmProposal needs { promises } to record the proposal's promise");
    promises.create({
      shopId: row.shop_id,
      customer: proposal.promise.customer,
      amountKobo: proposal.promise.amountKobo ?? null,
      dueDate: proposal.promise.dueDate,
    });
  }
  const recordedIds = recorded.map((r) => r.id);
  const updated = proposals.update(row.id, { status: "confirmed", recordedIds });
  return { proposal: toProposal(updated), recordedIds, alreadyConfirmed: false };
}

// Re-proposes using the previous proposal plus the trader's correction.
// Renews the proposal clock. Never touches confirmed proposals.
export async function fixProposal(proposalId, shopId, correctionText, { proposals, model, ledger = null, products = null, now = Date.now(), timings = null }) {
  if (!proposals || !model) throw new Error("fixProposal needs { proposals, model }");
  if (!correctionText || typeof correctionText !== "string" || !correctionText.trim()) {
    throw voiceError(400, "correction text is required");
  }
  const row = getOwnedRow(proposals, proposalId, shopId);
  if (toProposal(row).photoCheck) {
    throw voiceError(409, `proposal ${row.id} is a photo check; send the photo again to change it`);
  }
  if (row.status === "confirmed") {
    throw voiceError(409, `proposal ${row.id} is already confirmed; send a new note to correct it`);
  }
  const prior = toProposal(row);
  const priorSummary = { heard: prior.heard, entries: prior.entries, totals: prior.totals, question: prior.question };
  let raw;
  const tClassify = Date.now();
  try {
    raw = await model.complete({ text: correctionText.trim(), prior: priorSummary });
  } catch (err) {
    if (!isBadJson(err) && !isTruncated(err)) throw err;
    raw = null;
  }
  if (timings) timings.classifyMs = Date.now() - tClassify;
  const stamp = new Date().toISOString();
  const priorCorrection = { correctionOf: prior.correctionOf ?? null, correctionReason: prior.correctionReason ?? null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const msg = "I no understand the correction — abeg talk am again.";
    const envelope = {
      version: 1,
      entries: prior.entries,
      totals: prior.totals,
      flags: [msg],
      notes: prior.notes,
      promise: prior.promise ?? null,
      effects: prior.effects ?? [],
      hint: prior.hint ?? null,
      hintNote: prior.hintNote ?? null,
      assumptions: prior.assumptions ?? [],
      ...priorCorrection,
    };
    const updated = proposals.update(row.id, {
      status: "pending",
      envelope,
      heard: `${prior.heard}\nTrader: ${correctionText.trim()}`,
      question: msg,
      createdAt: stamp,
      recordedIds: null,
    });
    return toProposal(updated);
  }
  const priorChecked = Array.isArray(prior.name_checked) ? prior.name_checked : [];
  // Explicit "new customer" / "new product" on a Fix settles that spelling:
  // the model's returned names stand even when they near-match something
  // stored. Exact stored spellings still win inside the matcher, so this can
  // never duplicate a customer or silently merge into one.
  const fixLower = correctionText.trim().toLowerCase();
  const extraChecked = [];
  if (Array.isArray(raw.entries)) {
    if (/\bnew customers?\b/.test(fixLower)) {
      for (const e of raw.entries) {
        const norm = normalizeName(e?.customer);
        if (norm) extraChecked.push(norm, stripTitle(norm));
      }
    }
    if (/\bnew products?\b/.test(fixLower)) {
      for (const e of raw.entries) {
        const norm = normalizeName(e?.item);
        if (norm) extraChecked.push(`item:${norm}`);
      }
    }
  }
  const ledgerRows = ledger && typeof ledger.list === "function" ? ledger.list(shopId) : null;
  const catalog = products && typeof products.listByShop === "function" ? products.listByShop(shopId) : null;
  const tChecks = Date.now();
  const checked = checkModelOutput(raw, shopId, {
    existingCustomers: customersOf(ledgerRows),
    checkedNames: [...priorChecked, ...extraChecked],
    now,
    ledgerRows,
    catalog,
    hint: prior.hint ?? null,
  });
  if (timings) timings.checksMs = Date.now() - tChecks;
  const merged = [...new Set([...priorChecked, ...extraChecked, ...checked.questionedNames])];
  // The hint describes how the note started, so it survives fixes; the
  // mismatch sentence is recomputed against the revised entries.
  const hint = prior.hint ?? null;
  const updated = proposals.update(row.id, {
    status: "pending",
    envelope: {
      version: 1,
      entries: checked.entries,
      totals: checked.totals,
      flags: checked.flags,
      notes: prior.correctionOf == null ? checked.notes : [`corrects entry ${prior.correctionOf}`, ...checked.notes],
      promise: checked.promise,
      effects: checked.effects,
      hint,
      hintNote: hintMismatchNote(hint, checked.entries),
      assumptions: checked.assumptions,
      ...priorCorrection,
    },
    heard: checked.heard !== "(no transcript)" ? checked.heard : `${prior.heard}\nTrader: ${correctionText.trim()}`,
    question: checked.question,
    createdAt: stamp,
    recordedIds: null,
    nameChecked: merged.length > 0 ? merged : null,
  });
  return toProposal(updated);
}

export function rejectProposal(proposalId, shopId, { proposals }) {
  if (!proposals) throw new Error("rejectProposal needs { proposals }");
  const row = getOwnedRow(proposals, proposalId, shopId);
  if (row.status === "confirmed") {
    throw voiceError(409, `proposal ${row.id} is already confirmed; the ledger cannot be un-written`);
  }
  if (row.status === "rejected") return toProposal(row);
  return toProposal(proposals.update(row.id, { status: "rejected" }));
}

export function getProposal(proposalId, shopId, { proposals }) {
  if (!proposals) throw new Error("getProposal needs { proposals }");
  return toProposal(applyExpiry(proposals, getOwnedRow(proposals, proposalId, shopId)));
}
