// Voice-to-confirm loop, backend only. The model only proposes; plain code
// does every check; confirmProposal() is the ONLY path that appends to the
// ledger. Uses fake data in tests; never touches real trader data.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseNaira, formatKobo } from "./money.mjs";

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;
export const ENTRY_TYPES = ["sale", "payment", "restock"];
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
  };
}

function cleanText(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
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
    flags.push(`${label}: unknown type "${String(e.type)}" (want sale, payment or restock)`);
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

// Runs every check on raw model output. Missing or ambiguous input stays
// pending with a clarifying question; nothing is ever guessed.
export function checkModelOutput(raw, shopId) {
  const flags = [];
  const notes = [];
  const heard = cleanText(raw.heard) ?? "(no transcript)";
  let entries = [];
  if (!Array.isArray(raw.entries)) {
    flags.push("model returned no entries list");
  } else {
    entries = raw.entries.map((e, i) => checkEntry(e, i, shopId, flags, notes, heard)).filter(Boolean);
  }
  const totals = checkTotals(raw.totals, flags, notes);
  checkStatedRemainder(heard, entries, flags);
  if (entries.length === 0 && flags.length === 0) {
    flags.push("no entries to record");
  }
  let question = cleanText(raw.question);
  if (question) flags.push(`needs clarification: ${question}`);
  if (!question && flags.length > 0) question = `Abeg check am: ${flags.join("; ")}`;
  return { version: 1, entries, totals, flags, notes, heard, question };
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

export async function propose(shopId, input, { proposals, model }) {
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
    return toProposal(proposals.create({ shopId, envelope: c.envelope, heard: c.heard, question: c.question }));
  }
  const { heard, question, ...envelope } = checkModelOutput(raw, shopId);
  return toProposal(proposals.create({ shopId, envelope, heard, question }));
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
export function confirmProposal(proposalId, shopId, { proposals, ledger }) {
  if (!proposals || !ledger) throw new Error("confirmProposal needs { proposals, ledger }");
  const row = applyExpiry(proposals, getOwnedRow(proposals, proposalId, shopId));
  if (row.status === "confirmed") {
    return { proposal: toProposal(row), recordedIds: JSON.parse(row.recorded_ids), alreadyConfirmed: true };
  }
  if (row.status === "rejected") throw voiceError(409, `proposal ${row.id} was rejected`);
  if (row.status === "expired") throw voiceError(410, `proposal ${row.id} expired; send the note again`);
  const proposal = toProposal(row);
  if (proposal.flags.length > 0) {
    throw voiceError(400, `cannot confirm proposal ${row.id}: ${proposal.flags.join("; ")} — send a fix first`);
  }
  if (proposal.entries.length === 0) {
    throw voiceError(400, `cannot confirm proposal ${row.id}: no entries to record`);
  }
  for (const e of proposal.entries) {
    if (!Number.isInteger(e.amountKobo) || e.amountKobo < 0 || !e.customer) {
      throw voiceError(400, `cannot confirm proposal ${row.id}: an entry failed final checks`);
    }
  }
  // One transaction so a mid-confirm failure records nothing. The proposal is
  // marked confirmed right after; a crash in between would need manual review.
  ledger.db.exec("BEGIN IMMEDIATE");
  let recorded;
  try {
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
    ledger.db.exec("COMMIT");
  } catch (err) {
    try {
      ledger.db.exec("ROLLBACK");
    } catch {
      // Already rolled back.
    }
    throw err;
  }
  const recordedIds = recorded.map((r) => r.id);
  const updated = proposals.update(row.id, { status: "confirmed", recordedIds });
  return { proposal: toProposal(updated), recordedIds, alreadyConfirmed: false };
}

// Re-proposes using the previous proposal plus the trader's correction.
// Renews the proposal clock. Never touches confirmed proposals.
export async function fixProposal(proposalId, shopId, correctionText, { proposals, model }) {
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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const msg = "I no understand the correction — abeg talk am again.";
    const envelope = { version: 1, entries: prior.entries, totals: prior.totals, flags: [msg], notes: prior.notes };
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
  const checked = checkModelOutput(raw, shopId);
  const updated = proposals.update(row.id, {
    status: "pending",
    envelope: { version: 1, entries: checked.entries, totals: checked.totals, flags: checked.flags, notes: checked.notes },
    heard: checked.heard !== "(no transcript)" ? checked.heard : `${prior.heard}\nTrader: ${correctionText.trim()}`,
    question: checked.question,
    createdAt: stamp,
    recordedIds: null,
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
