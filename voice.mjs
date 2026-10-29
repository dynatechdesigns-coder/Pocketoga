// Voice-to-confirm loop, backend only. The model only proposes; plain code
// does every check; confirmProposal() is the ONLY path that appends to the
// ledger. Uses fake data in tests; never touches real trader data.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseNaira, formatKobo } from "./money.mjs";
import { escapeMd } from "./messages.mjs";
import { resolvePromiseDate } from "./promises.mjs";
import { runSecondOpinion, SECOND_OPINION_TIMEOUT_MS } from "./secondopinion.mjs";

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;
export const ENTRY_TYPES = ["sale", "payment", "restock", "expense"];
// Expense categories, stored in the item field. Anything the model sends
// that is not on this list becomes "other" in pickExpenseCategory.
export const EXPENSE_CATEGORIES = ["transport", "rent", "power", "wages", "stock-related", "other"];
export const PRICE_BASES = ["each", "total", "unclear"];
// Words that mean a price is per item. Checked against the note when the
// model claims the amount is a total.
const EACH_WORDS = /\b(each|per|every|apiece|one-one|one one|a piece)\b/i;
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
// the original phrase. Returns { naira, kobo, phrase } with nulls when absent.
function checkLeg(naira, phrase, label, flags, notes, required = false) {
  const cleanPhrase = cleanText(phrase);
  if (naira === null || naira === undefined) {
    if (required) flags.push(`${label}: missing amount`);
    return { naira: null, kobo: null, phrase: cleanPhrase };
  }
  if (typeof naira !== "number" || !Number.isInteger(naira)) {
    flags.push(`${label}: amount must be whole naira, got ${String(naira)}`);
    return { naira: null, kobo: null, phrase: cleanPhrase };
  }
  if (naira < 0) {
    flags.push(`${label}: amount must not be negative`);
    return { naira: null, kobo: null, phrase: cleanPhrase };
  }
  const kobo = naira * 100;
  if (cleanPhrase) {
    try {
      const parsed = parseNaira(cleanPhrase);
      if (parsed.kobo !== kobo) {
        flags.push(`${label}: model says ${formatKobo(kobo)} but "${cleanPhrase}" means ${formatKobo(parsed.kobo)}`);
      }
    } catch {
      notes.push(`${label}: could not verify amount phrase "${cleanPhrase}"`);
    }
  } else {
    notes.push(`${label}: no amount phrase to cross-check`);
  }
  return { naira, kobo, phrase: cleanPhrase };
}

function checkEntry(rawEntry, index, shopId, flags, notes, heard) {
  const label = `entry ${index + 1}`;
  const e = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
  if (!ENTRY_TYPES.includes(e.type)) {
    flags.push(`${label}: unknown type "${String(e.type)}" (want sale, payment, restock or expense)`);
    return null;
  }
  const { naira, kobo, phrase } = checkLeg(e.amountNaira, e.amountPhrase, label, flags, notes, true);

  let basis = e.priceBasis;
  if (!PRICE_BASES.includes(basis)) {
    flags.push(`${label}: price basis must be each, total or unclear, got ${String(e.priceBasis)}`);
    basis = "unclear";
  }

  let customer = cleanText(e.customer);
  if (!customer) {
    if (e.type === "restock") {
      customer = shopId; // stock moves into the shop itself
      notes.push(`${label}: no supplier given, recorded for the shop`);
    } else if (e.type === "expense") {
      customer = shopId; // the shop itself paid
      notes.push(`${label}: no payee given, recorded for the shop`);
    } else {
      flags.push(`${label}: missing customer name`);
    }
  }

  let item = null;
  if (e.item !== null && e.item !== undefined && e.item !== "") {
    if (typeof e.item !== "string" || !e.item.trim()) {
      flags.push(`${label}: item must be text`);
    } else {
      item = e.item.trim();
    }
  }

  let quantity = null;
  if (e.quantity !== null && e.quantity !== undefined) {
    if (typeof e.quantity !== "number" || !Number.isInteger(e.quantity) || e.quantity <= 0) {
      flags.push(`${label}: quantity must be a positive integer, got ${String(e.quantity)}`);
    } else {
      quantity = e.quantity;
    }
  }

  let unit = null;
  if (e.unit !== null && e.unit !== undefined && e.unit !== "") {
    if (typeof e.unit !== "string" || !e.unit.trim()) {
      flags.push(`${label}: unit must be text`);
    } else {
      unit = e.unit.trim();
    }
  }

  // Payments store money only: no item, quantity or unit reaches the ledger.
  if (e.type === "payment") {
    if (basis === "each") {
      flags.push(`${label}: a payment is a total, not an each-price`);
      basis = "total";
    }
    if (item !== null || quantity !== null || unit !== null) {
      notes.push(`${label}: payment item and quantity are not stored`);
      item = null;
      quantity = null;
      unit = null;
    }
  }

  if (e.type === "restock") {
    if (item === null) flags.push(`${label}: restock needs an item`);
    if (e.quantity === null || e.quantity === undefined) flags.push(`${label}: restock needs a quantity`);
  }

  // Expenses store money and a category only: quantity and unit never reach
  // the ledger, the amount is always a total, and code picks the category.
  if (e.type === "expense") {
    if (basis === "each") {
      flags.push(`${label}: an expense is a total, not an each-price`);
      basis = "total";
    }
    if (quantity !== null || unit !== null) {
      notes.push(`${label}: expense quantity and unit are not stored`);
      quantity = null;
      unit = null;
    }
    item = pickExpenseCategory(e.item);
  }
  if (e.type === "sale" && item !== null && (e.quantity === null || e.quantity === undefined)) {
    flags.push(`${label}: how many ${item}? quantity is missing`);
  }

  // The note says per-item but the model read a total: do not trust it.
  if (basis === "total" && e.type !== "payment") {
    const match = `${heard ?? ""} ${phrase ?? ""}`.match(EACH_WORDS);
    if (match) {
      flags.push(`${label}: note says "${match[0].toLowerCase()}" but the amount was read as a total`);
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
      flags.push(`${label}: an each-price needs a quantity`);
      totalNaira = null;
      totalKobo = null;
    } else if (naira !== null) {
      totalNaira = naira * quantity;
      totalKobo = kobo * quantity;
      eachNaira = naira;
      eachKobo = kobo;
    }
  } else if (basis === "unclear" && quantity !== null && quantity > 1) {
    const figure = phrase ? `"${phrase}"` : kobo !== null ? formatKobo(kobo) : "the amount";
    flags.push(`${label}: is ${figure} for each one or for all ${quantity}?`);
  }

  return {
    type: e.type,
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

function checkTotals(rawTotals, flags, notes) {
  if (rawTotals === null || rawTotals === undefined) return null;
  const t = typeof rawTotals === "object" ? rawTotals : {};
  const total = checkLeg(t.totalNaira, t.totalPhrase, "total", flags, notes);
  const paid = checkLeg(t.paidNaira, t.paidPhrase, "paid", flags, notes);
  const remainder = checkLeg(t.remainderNaira, t.remainderPhrase, "remainder", flags, notes);
  if (total.naira !== null && paid.naira !== null && remainder.naira !== null) {
    if (total.naira !== paid.naira + remainder.naira) {
      flags.push(
        `numbers do not add up: total ${formatKobo(total.kobo)} but paid ${formatKobo(paid.kobo)} + remainder ${formatKobo(remainder.kobo)} = ${formatKobo(paid.kobo + remainder.kobo)}`
      );
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
// text must equal sales minus payments in this note. Skipped when the
// totals check already flagged the same mismatch, so the card shows one
// arithmetic question, not two.
function checkStatedRemainder(heard, entries, flags) {
  if (flags.some((f) => f.startsWith("numbers do not add up"))) return;
  const stated = statedRemainderKobo(heard);
  if (stated === null) return;
  const note = noteExpectedRemainder(entries);
  if (note === null) return;
  if (stated !== note.expected) {
    flags.push(
      `numbers do not add up: note says remainder ${formatKobo(stated)} but sales ${formatKobo(note.sales)} minus paid ${formatKobo(note.paid)} = ${formatKobo(note.expected)}`
    );
  }
}

// Leading titles stripped for the similar-name check, so "Mama Chinedu"
// matches "Chinedu".
const NAME_TITLES = ["mama", "baba", "mr", "mrs", "alhaji", "alhaja", "chief", "madam", "oga"];

function normalizeName(name) {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
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

// A leading title word plus the rest ("mama chinedu" -> "chinedu").
// Unchanged when there is no leading title.
function stripTitle(normalized) {
  const m = /^(\S+)\s+(.+)$/.exec(normalized);
  if (m && NAME_TITLES.includes(m[1])) return m[2];
  return normalized;
}

// True when two already-normalized, non-equal names may be the same person:
// a small typo, one name extending the other, or a title difference.
function namesSimilar(a, b) {
  if (editDistance(a, b) <= 2) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length >= 3 && long.startsWith(short)) return true;
  const sa = stripTitle(a);
  const sb = stripTitle(b);
  if (sa && sb && sa === sb) return true;
  return false;
}

// Similar-name check: each proposed customer against the shop's own ledger
// names. Exact-after-normalization is clean; near matches ask the trader.
// Names in checkedNames (already questioned on this proposal) are skipped.
// Questioned names are collected into questioned (normalized).
function checkSimilarNames(entries, shopId, existingCustomers, checkedNames, flags, questioned) {
  if (!existingCustomers || existingCustomers.length === 0) return;
  const checked = new Set((checkedNames ?? []).map((n) => normalizeName(n)));
  const stored = existingCustomers
    .filter((c) => typeof c === "string" && normalizeName(c))
    .map((c) => ({ raw: c.trim(), norm: normalizeName(c) }));
  const asked = new Set();
  for (const e of entries) {
    if (!e.customer || e.customer === shopId) continue;
    const norm = normalizeName(e.customer);
    if (!norm || checked.has(norm) || asked.has(norm)) continue;
    if (stored.some((s) => s.norm === norm)) continue;
    const match = stored.find((s) => namesSimilar(norm, s.norm));
    if (match) {
      asked.add(norm);
      questioned.push(norm);
      flags.push(`Is *${escapeMd(e.customer.trim())}* the same person as *${escapeMd(match.raw)}*? Send the right name, or say new customer.`);
    }
  }
}

// Distinct customer names already in the shop's own ledger. Empty when no
// ledger was supplied, so those callers skip the similar-name check.
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
function checkPromise(rawPromise, flags, nowMs) {
  if (rawPromise === null || rawPromise === undefined) return null;
  if (typeof rawPromise !== "object" || Array.isArray(rawPromise)) {
    flags.push("promise must be an object with customer, datePhrase and amountNaira");
    return null;
  }
  const customer = cleanText(rawPromise.customer);
  if (!customer) flags.push("promise needs a customer name");
  const datePhrase = cleanText(rawPromise.datePhrase);
  let dueDate = null;
  if (!datePhrase) {
    flags.push(`promise needs a day: when will ${customer ?? "the customer"} pay?`);
  } else {
    dueDate = resolvePromiseDate(datePhrase, nowMs);
    if (!dueDate) flags.push(`promise date "${datePhrase}" is unclear — which day will ${customer ?? "the customer"} pay?`);
  }
  let amountNaira = null;
  let amountBad = false;
  if (rawPromise.amountNaira !== null && rawPromise.amountNaira !== undefined) {
    if (typeof rawPromise.amountNaira !== "number" || !Number.isInteger(rawPromise.amountNaira)) {
      flags.push(`promise amount must be whole naira, got ${String(rawPromise.amountNaira)}`);
      amountBad = true;
    } else if (rawPromise.amountNaira < 0) {
      flags.push("promise amount must not be negative");
      amountBad = true;
    } else {
      amountNaira = rawPromise.amountNaira;
    }
  }
  if (!customer || !dueDate || amountBad) return null;
  return { customer, datePhrase, amountNaira, amountKobo: amountNaira === null ? null : amountNaira * 100, dueDate };
}

// Runs every check on raw model output. Missing or ambiguous input stays
// pending with a clarifying question; nothing is ever guessed.
export function checkModelOutput(raw, shopId, { existingCustomers = [], checkedNames = [], now = Date.now() } = {}) {
  const flags = [];
  const notes = [];
  const questionedNames = [];
  const heard = cleanText(raw.heard) ?? "(no transcript)";
  let entries = [];
  if (!Array.isArray(raw.entries)) {
    flags.push("model returned no entries list");
  } else {
    entries = raw.entries.map((e, i) => checkEntry(e, i, shopId, flags, notes, heard)).filter(Boolean);
  }
  const totals = checkTotals(raw.totals, flags, notes);
  checkStatedRemainder(heard, entries, flags);
  checkSimilarNames(entries, shopId, existingCustomers, checkedNames, flags, questionedNames);
  const promise = checkPromise(raw.promise, flags, now);
  if (entries.length === 0 && flags.length === 0) {
    flags.push("no entries to record");
  }
  let question = cleanText(raw.question);
  if (question) flags.push(`needs clarification: ${question}`);
  if (!question && flags.length > 0) question = `Abeg check am: ${flags.join("; ")}`;
  return { version: 1, entries, totals, flags, notes, heard, question, questionedNames, promise };
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

function confusedEnvelope(heard) {
  const msg = "I no hear am well — abeg talk am again.";
  return { envelope: { version: 1, entries: [], totals: null, flags: [msg], notes: [] }, heard, question: msg };
}

// --- Proposal operations ---------------------------------------------------

export async function propose(
  shopId,
  input,
  {
    proposals,
    model,
    ledger = null,
    now = Date.now(),
    secondOpinions = null,
    secondOpinionFetch = fetch,
    secondOpinionEnv = process.env,
    secondOpinionTimeoutMs = SECOND_OPINION_TIMEOUT_MS,
  }
) {
  if (!shopId || typeof shopId !== "string") throw voiceError(400, "shopId is required");
  if (!proposals || !model) throw new Error("propose needs { proposals, model }");
  const norm = normalizeInput(input);
  const fallbackHeard = norm.kind === "text" ? norm.text : "(voice note)";
  let raw;
  try {
    raw = norm.kind === "text" ? await model.complete({ text: norm.text }) : await model.complete({ audio: norm.audio });
  } catch (err) {
    if (!isBadJson(err)) throw err; // transport/API errors propagate; nothing stored
    raw = null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const c = confusedEnvelope(fallbackHeard);
    const confused = proposals.create({ shopId, envelope: c.envelope, heard: c.heard, question: c.question });
    if (secondOpinions) {
      secondOpinions.record({ proposalId: confused.id, agreed: "no_second_opinion", differingFields: [], latencyMs: 0 });
    }
    return toProposal(confused);
  }
  const { heard, question, questionedNames, ...envelope } = checkModelOutput(raw, shopId, {
    existingCustomers: shopCustomers(ledger, shopId),
    now,
  });
  // Second opinion: a second model re-reads the heard text and plain code
  // compares. Disagreement adds one code-built flag (the question when the
  // proposal has none, so the card asks once); entries are never touched.
  // Without the stats store the feature is off entirely, so legacy callers
  // never call out. The check itself never throws.
  let finalQuestion = question;
  let second = { agreed: "no_second_opinion", differingFields: [], latencyMs: 0 };
  if (secondOpinions) {
    second = await runSecondOpinion({
      heardText: heard,
      entries: envelope.entries,
      promise: envelope.promise ?? null,
      shopId,
      now,
      fetchFn: secondOpinionFetch,
      env: secondOpinionEnv,
      timeoutMs: secondOpinionTimeoutMs,
    });
    if (second.line) {
      envelope.flags = [...envelope.flags, second.line];
      if (!finalQuestion) finalQuestion = second.line;
    }
  }
  const row = proposals.create({
    shopId,
    envelope,
    heard,
    question: finalQuestion,
    nameChecked: questionedNames.length > 0 ? questionedNames : null,
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
export function confirmProposal(proposalId, shopId, { proposals, ledger, promises = null, products = null }) {
  if (!proposals || !ledger) throw new Error("confirmProposal needs { proposals, ledger }");
  const row = applyExpiry(proposals, getOwnedRow(proposals, proposalId, shopId));
  if (row.status === "confirmed") {
    return { proposal: toProposal(row), recordedIds: JSON.parse(row.recorded_ids), alreadyConfirmed: true };
  }
  if (row.status === "rejected") throw voiceError(409, `proposal ${row.id} was rejected`);
  if (row.status === "expired") throw voiceError(410, `proposal ${row.id} expired; send the note again`);
  const proposal = toProposal(row);
  const isCorrection = proposal.correctionOf !== null && proposal.correctionOf !== undefined;
  if (proposal.flags.length > 0) {
    throw voiceError(400, `cannot confirm proposal ${row.id}: ${proposal.flags.join("; ")} — send a fix first`);
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
  if (proposal.promise) {
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
export async function fixProposal(proposalId, shopId, correctionText, { proposals, model, ledger = null, now = Date.now() }) {
  if (!proposals || !model) throw new Error("fixProposal needs { proposals, model }");
  if (!correctionText || typeof correctionText !== "string" || !correctionText.trim()) {
    throw voiceError(400, "correction text is required");
  }
  const row = getOwnedRow(proposals, proposalId, shopId);
  if (row.status === "confirmed") {
    throw voiceError(409, `proposal ${row.id} is already confirmed; send a new note to correct it`);
  }
  const prior = toProposal(row);
  const priorSummary = { heard: prior.heard, entries: prior.entries, totals: prior.totals, question: prior.question };
  let raw;
  try {
    raw = await model.complete({ text: correctionText.trim(), prior: priorSummary });
  } catch (err) {
    if (!isBadJson(err)) throw err;
    raw = null;
  }
  const stamp = new Date().toISOString();
  const priorCorrection = { correctionOf: prior.correctionOf ?? null, correctionReason: prior.correctionReason ?? null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const msg = "I no understand the correction — abeg talk am again.";
    const envelope = { version: 1, entries: prior.entries, totals: prior.totals, flags: [msg], notes: prior.notes, promise: prior.promise ?? null, ...priorCorrection };
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
  const checked = checkModelOutput(raw, shopId, {
    existingCustomers: shopCustomers(ledger, shopId),
    checkedNames: priorChecked,
    now,
  });
  const merged = [...new Set([...priorChecked, ...checked.questionedNames])];
  const updated = proposals.update(row.id, {
    status: "pending",
    envelope: {
      version: 1,
      entries: checked.entries,
      totals: checked.totals,
      flags: checked.flags,
      notes: prior.correctionOf == null ? checked.notes : [`corrects entry ${prior.correctionOf}`, ...checked.notes],
      promise: checked.promise,
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
