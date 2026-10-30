// Muse Spark Open check served through Baseten: a Baseten-hosted text
// model re-reads the note's heard text with a minimal extraction prompt,
// and plain code compares the two readings. The second model never changes
// an entry — disagreement only adds one code-built flag — and any failure
// (missing keys, timeout, bad output) degrades to "no second opinion" and
// never blocks or fails a proposal. A late or failed attempt with keys set
// adds the soft assumption "second check not available" with Save enabled.
//
// Runs off the critical path: propose() starts the fetch in parallel with
// the main classification for text notes (same input text), with a hard
// 4 s cap and no retry, so the worst add is 4 s and typically zero.
// Voice notes must wait for the transcript, then run with the same cap.
//
// Import cycle with voice.mjs, by design: propose() calls runSecondOpinion,
// and the comparison reuses voice's checkModelOutput so both readings are
// normalized identically (each-price maths, money parsing, promise dates).
// Both sides only touch the import inside function bodies, after both
// modules initialize, so the cycle is safe.
import { DatabaseSync } from "node:sqlite";
import { parseModelJson, fetchWithRetry } from "./model.mjs";
import { formatKobo } from "./money.mjs";
import { resolvePromiseDate } from "./promises.mjs";
import { checkModelOutput } from "./voice.mjs";

export const BASETEN_BASE_URL = "https://inference.baseten.co/v1";
export const SECOND_OPINION_TIMEOUT_MS = 4000;
// Output cap: reasoning + visible JSON combined. 400 starved the short JSON
// answer whenever the model reasoned first (2 usable answers in 11 notes);
// 1000 leaves room for a short thought plus the JSON without slowing the
// fast path — the 4 s cap still bounds every attempt.
export const SECOND_OPINION_MAX_TOKENS = 1000;
export const SECOND_OPINION_AGREED = ["yes", "no", "no_second_opinion"];
export const SECOND_CHECK_UNAVAILABLE = "Second check not available (Muse Spark Open via Baseten).";
export const SECOND_CHECK_CREDIT = "Checked by Muse Spark Open via Baseten.";

// Minimal extraction prompt for the second reading: only the fields the
// code comparison needs, no totals, no question, no explanation. Compact
// JSON keeps output small and fast.
export const SECOND_OPINION_SYSTEM_PROMPT = `You are a bookkeeping checker. Reply JSON only, no explanation: {"entries":[{"type":"sale|payment|purchase|expense","customer":"name or null","item":"rice or null","unit":"bag or null","quantity":2 or null,"amountNaira":15000 or null,"priceBasis":"each|total|unclear"}],"promise":{"customer":"name","datePhrase":"Friday","amountNaira":20000} or null}. k means thousand. Never invent names or amounts.`;

// Accuracy stats, one row per proposal. The note text is never stored here.
export const SECOND_OPINION_SCHEMA = `
CREATE TABLE IF NOT EXISTS second_opinions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  agreed TEXT NOT NULL CHECK (agreed IN ('yes','no','no_second_opinion')),
  differing_fields TEXT NOT NULL,
  latency_ms INTEGER NOT NULL CHECK (typeof(latency_ms) = 'integer' AND latency_ms >= 0),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_second_opinions_proposal ON second_opinions(proposal_id);
`;

export class SecondOpinionStore {
  // dbPathOrDb: a path (owned connection) or a shared DatabaseSync.
  constructor(dbPathOrDb = ":memory:") {
    if (typeof dbPathOrDb === "string") {
      this.db = new DatabaseSync(dbPathOrDb);
      this.ownsDb = true;
    } else {
      this.db = dbPathOrDb;
      this.ownsDb = false;
    }
    this.db.exec(SECOND_OPINION_SCHEMA);
  }

  record({ proposalId, agreed, differingFields = [], latencyMs = 0, createdAt = null }) {
    if (!Number.isInteger(proposalId)) throw new Error("proposalId must be an integer");
    if (!SECOND_OPINION_AGREED.includes(agreed)) {
      throw new Error(`agreed must be one of ${SECOND_OPINION_AGREED.join(", ")}`);
    }
    if (!Number.isInteger(latencyMs) || latencyMs < 0) {
      throw new Error("latencyMs must be an integer >= 0");
    }
    const fields = Array.isArray(differingFields) ? differingFields : [];
    const result = this.db
      .prepare(
        "INSERT INTO second_opinions (proposal_id, agreed, differing_fields, latency_ms, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(proposalId, agreed, JSON.stringify(fields), latencyMs, createdAt ?? new Date().toISOString());
    return this.db.prepare("SELECT * FROM second_opinions WHERE id = ?").get(Number(result.lastInsertRowid));
  }

  listByProposal(proposalId) {
    return this.db
      .prepare("SELECT * FROM second_opinions WHERE proposal_id = ? ORDER BY id ASC")
      .all(proposalId);
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}

// Reasoning-channel markers the hosted model sometimes wraps its thinking
// in (see baseten-test.mjs): the JSON answer follows the last marker, so
// everything up to it is cut before parsing. Plain JSON has no marker and
// parses exactly as before.
const REASONING_MARKERS = ["</think>", "assistantfinal", "<|channel|>final<|message|>", "Final answer:"];

function stripReasoning(content) {
  const text = String(content ?? "");
  let idx = -1;
  let len = 0;
  for (const m of REASONING_MARKERS) {
    const i = text.lastIndexOf(m);
    if (i !== -1 && i > idx) {
      idx = i;
      len = m.length;
    }
  }
  return idx === -1 ? text : text.slice(idx + len);
}

// Dev-only one-liner per second-opinion attempt: HTTP status, finish reason,
// whether the content was empty, reasoning and output token counts.
// Numbers only — never the note text or model output. Silent unless
// POCKETOGA_TIMING=1.
function logSecondAttempt({ status, finish, empty, reasoning, output, ms }) {
  if (process.env.POCKETOGA_TIMING !== "1") return;
  console.log(
    `secondopinion status=${status} finish=${finish} empty=${empty} reasoning_tokens=${reasoning} output_tokens=${output} ms=${ms}`
  );
}

// One Baseten reading of the note text. Returns { reading, latencyMs };
// reading is null on any failure (transport, status, unparseable shape).
// Sends only the single note text — never audio, images, phone numbers or
// ledger data. Minimal prompt, minimal reasoning, small max output, no
// retry: a timeout fails fast to "not available" instead of doubling to 8 s.
// Exported so propose() can start the fetch in parallel with classification.
export async function fetchSecondReading(heardText, { apiKey, model, fetchFn, timeoutMs = SECOND_OPINION_TIMEOUT_MS }) {
  const start = Date.now();
  const info = { status: "error", finish: "none", empty: true, reasoning: "n/a", output: "n/a" };
  const failed = () => {
    logSecondAttempt({ ...info, ms: Date.now() - start });
    return { reading: null, latencyMs: Date.now() - start };
  };
  try {
    const res = await fetchWithRetry(
      fetchFn,
      `${BASETEN_BASE_URL}/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          reasoning_effort: "minimal",
          max_tokens: SECOND_OPINION_MAX_TOKENS,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SECOND_OPINION_SYSTEM_PROMPT },
            { role: "user", content: heardText },
          ],
        }),
      },
      { timeoutMs, retries: 0 }
    );
    info.status = Number.isInteger(res?.status) ? res.status : (res?.ok ? 200 : "error");
    if (!res.ok) return failed();
    const data = await res.json().catch(() => null);
    const choice = data?.choices?.[0] ?? {};
    info.finish = choice.finish_reason ?? "none";
    const usage = data?.usage ?? {};
    info.output = Number.isInteger(usage.completion_tokens) ? usage.completion_tokens : "n/a";
    const details = usage.completion_tokens_details ?? {};
    info.reasoning = Number.isInteger(details.reasoning_tokens) ? details.reasoning_tokens : "n/a";
    const content = choice.message?.content ?? "";
    info.empty = !String(content).trim();
    let reading;
    try {
      reading = parseModelJson(stripReasoning(content));
    } catch {
      return failed();
    }
    if (!reading || typeof reading !== "object" || Array.isArray(reading)) return failed();
    logSecondAttempt({ ...info, ms: Date.now() - start });
    return { reading, latencyMs: Date.now() - start };
  } catch {
    return failed();
  }
}

function normText(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function showText(value) {
  const clean = String(value ?? "").trim().replace(/\s+/g, " ");
  return clean ? clean : "unknown";
}

function showMoney(kobo) {
  return Number.isInteger(kobo) ? formatKobo(kobo) : "unknown";
}

function showQty(qty) {
  return Number.isInteger(qty) ? String(qty) : "unknown";
}

function pluralize(n, one, many) {
  return n === 1 ? one : many;
}

// Only these disagreements may ever reach the trader: the amount, the
// customer, the number of entries, the promise date. Anything else the
// comparison finds (category, unit, quantity, type, price basis, promise
// wording or amount) is recorded in the stats and never shown, never asked.
const SHOWN_FIELDS = new Set(["entries", "customer", "amount", "promise.date"]);
// Stats marker when crossed-basis normalisation turned a would-be amount
// difference into agreement. Never shown, never asked, never blocks.
export const NORMALISED_AMOUNT = "amount-normalised";

// True when one reading's each-side unit price equals the other's total-side
// figure: the same stated money read with a crossed price basis ("45k each,
// 10 bags" vs "45k total"), not a real total difference. Kobo integers, so
// equality is exact — anything unequal is a real difference, not rounding.
function sameFigureCrossedBasis(x, y) {
  if (!Number.isInteger(x.amountKobo) || !Number.isInteger(y.amountKobo)) return false;
  const [eachSide, totalSide] =
    x.priceBasis === "each" && y.priceBasis !== "each" ? [x, y]
    : y.priceBasis === "each" && x.priceBasis !== "each" ? [y, x]
    : [null, null];
  if (!eachSide || !totalSide) return false;
  return Number.isInteger(eachSide.eachKobo) && eachSide.eachKobo === totalSide.amountKobo;
}

// Compares the primary checked entries against the second raw reading,
// normalized through the same checks (each-price maths, money parsing,
// promise dates). Returns { differingFields, line, shownField }: every field
// name in comparison order (for the stats), the single code-built line for
// the first SHOWABLE difference (null when the readings agree, or when only
// hidden fields differ), and the field that line is about. Item, heard-text
// and question wording never count; neither does casing. The one exception
// is the expense category, which lives in item and is compared as
// "category" — stats only, never shown.
export function compareReadings(primaryEntries, primaryPromise, secondRaw, { shopId, now = Date.now(), existingCustomers = [] } = {}) {
  // The second reading runs the same customer matching as the primary, so
  // the comparison is on recorded values ("Chinedu" both sides) rather than
  // raw hearings ("Mama Chinedu" vs "Chinedu").
  const second = checkModelOutput(secondRaw, shopId, { existingCustomers, now });
  const fields = [];
  let line = null;
  let shownField = null;
  const note = (field, text) => {
    if (!fields.includes(field)) fields.push(field);
    if (!line && SHOWN_FIELDS.has(field)) {
      line = text;
      shownField = field;
    }
  };
  const a = primaryEntries ?? [];
  const b = second.entries ?? [];
  if (a.length !== b.length) {
    note(
      "entries",
      `Two readings differ: one heard ${a.length} ${pluralize(a.length, "entry", "entries")} and the other heard ${b.length} ${pluralize(b.length, "entry", "entries")}. Which one na correct?`
    );
  }
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x.type !== y.type) {
      note("type", `Two readings differ: type is ${showText(x.type)} in one and ${showText(y.type)} in the other. Which one na correct?`);
    }
    if (normText(x.customer) !== normText(y.customer)) {
      note(
        "customer",
        `Two readings differ: customer is ${showText(x.customer)} in one and ${showText(y.customer)} in the other. Which one na correct?`
      );
    }
    if (x.amountKobo !== y.amountKobo && sameFigureCrossedBasis(x, y)) {
      // Same figure, crossed basis: agreement, recorded in the stats.
      if (!fields.includes(NORMALISED_AMOUNT)) fields.push(NORMALISED_AMOUNT);
    } else if (x.amountKobo !== y.amountKobo) {
      note(
        "amount",
        `Two readings differ: amount is ${showMoney(x.amountKobo)} in one and ${showMoney(y.amountKobo)} in the other. Which one na correct?`
      );
    }
    if (x.quantity !== y.quantity) {
      note(
        "quantity",
        `Two readings differ: quantity is ${showQty(x.quantity)} in one and ${showQty(y.quantity)} in the other. Which one na correct?`
      );
    }
    if (normText(x.unit) !== normText(y.unit)) {
      note("unit", `Two readings differ: unit is ${showText(x.unit)} in one and ${showText(y.unit)} in the other. Which one na correct?`);
    }
    if (x.priceBasis !== y.priceBasis && !sameFigureCrossedBasis(x, y)) {
      note(
        "priceBasis",
        `Two readings differ: price basis is ${showText(x.priceBasis)} in one and ${showText(y.priceBasis)} in the other. Which one na correct?`
      );
    }
    // Categories live in item, which is otherwise ignored — but for two
    // expense entries the category is the reading's substance, so compare it.
    if (x.type === "expense" && y.type === "expense" && normText(x.item) !== normText(y.item)) {
      note(
        "category",
        `Two readings differ: expense category is ${showText(x.item)} in one and ${showText(y.item)} in the other. Which one na correct?`
      );
    }
  }
  const pa = primaryPromise ?? null;
  const pb = second.promise ?? null;
  if ((pa === null) !== (pb === null)) {
    note("promise", "Two readings differ: one heard a promise and the other did not. Which one na correct?");
  } else if (pa && pb) {
    if (normText(pa.customer) !== normText(pb.customer)) {
      note(
        "promise.customer",
        `Two readings differ: promise customer is ${showText(pa.customer)} in one and ${showText(pb.customer)} in the other. Which one na correct?`
      );
    }
    if (pa.amountKobo !== pb.amountKobo) {
      note(
        "promise.amount",
        `Two readings differ: promise amount is ${showMoney(pa.amountKobo)} in one and ${showMoney(pb.amountKobo)} in the other. Which one na correct?`
      );
    }
    // Same words agree; otherwise the code-resolved dates decide, so a
    // wording variant ("Friday" vs "friday") stays silent.
    if (normText(pa.datePhrase) !== normText(pb.datePhrase)) {
      const da = resolvePromiseDate(pa.datePhrase, now);
      const db = resolvePromiseDate(pb.datePhrase, now);
      if (da === null || db === null || da !== db) {
        note(
          "promise.date",
          `Two readings differ: promise day is ${showText(pa.datePhrase)} in one and ${showText(pb.datePhrase)} in the other. Which one na correct?`
        );
      }
    }
  }
  return { differingFields: fields, line, shownField };
}

// Full check for one proposal: fetches the second reading and compares it
// against the primary checked entries. Always resolves — { agreed,
// differingFields, latencyMs, line, shownField } — and never throws: missing
// keys, an empty transcript, transport errors and unparseable output all
// degrade to no_second_opinion. Keys come from env (process.env in
// production).
export async function runSecondOpinion({
  heardText,
  entries,
  promise,
  shopId,
  now = Date.now(),
  fetchFn = fetch,
  env = process.env,
  timeoutMs = SECOND_OPINION_TIMEOUT_MS,
  existingCustomers = [],
}) {
  const quiet = { agreed: "no_second_opinion", differingFields: [], latencyMs: 0, line: null, shownField: null };
  const apiKey = env?.BASETEN_API_KEY;
  const model = env?.BASETEN_MODEL;
  if (!apiKey || !model) return quiet;
  if (typeof heardText !== "string" || !heardText.trim() || heardText.trim() === "(no transcript)") return quiet;
  const { reading, latencyMs } = await fetchSecondReading(heardText, { apiKey, model, fetchFn, timeoutMs });
  if (!reading) return { ...quiet, latencyMs };
  let compared;
  try {
    compared = compareReadings(entries ?? [], promise ?? null, reading, { shopId, now, existingCustomers });
  } catch {
    return { ...quiet, latencyMs };
  }
  const real = compared.differingFields.filter((f) => f !== NORMALISED_AMOUNT);
  if (real.length === 0) return { agreed: "yes", differingFields: compared.differingFields, latencyMs, line: null, shownField: null };
  return { agreed: "no", differingFields: compared.differingFields, latencyMs, line: compared.line, shownField: compared.shownField };
}
