// Second-opinion check: a Baseten-hosted text model re-reads the note's
// heard text with the same extraction prompt as the primary reading, and
// plain code compares the two readings. The second model never changes an
// entry — disagreement only adds one code-built flag — and any failure
// (missing keys, timeout, bad output) degrades silently to "no second
// opinion" and never blocks or fails a proposal.
//
// Import cycle with voice.mjs, by design: propose() calls runSecondOpinion,
// and the comparison reuses voice's checkModelOutput so both readings are
// normalized identically (each-price maths, money parsing, promise dates).
// Both sides only touch the import inside function bodies, after both
// modules initialize, so the cycle is safe.
import { DatabaseSync } from "node:sqlite";
import { SYSTEM_PROMPT, parseModelJson } from "./model.mjs";
import { formatKobo } from "./money.mjs";
import { resolvePromiseDate } from "./promises.mjs";
import { checkModelOutput } from "./voice.mjs";

export const BASETEN_BASE_URL = "https://inference.baseten.co/v1";
export const SECOND_OPINION_TIMEOUT_MS = 6000;
export const SECOND_OPINION_AGREED = ["yes", "no", "no_second_opinion"];

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

// One Baseten reading of the note text. Returns { reading, latencyMs };
// reading is null on any failure (transport, status, unparseable shape).
// Sends only the single note text — never audio, images, phone numbers or
// ledger data.
async function fetchSecondReading(heardText, { apiKey, model, fetchFn, timeoutMs }) {
  const start = Date.now();
  const failed = () => ({ reading: null, latencyMs: Date.now() - start });
  try {
    const res = await fetchFn(`${BASETEN_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: heardText },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return failed();
    const data = await res.json().catch(() => null);
    const reading = parseModelJson(data?.choices?.[0]?.message?.content ?? "");
    if (!reading || typeof reading !== "object" || Array.isArray(reading)) return failed();
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

// Compares the primary checked entries against the second raw reading,
// normalized through the same checks (each-price maths, money parsing,
// promise dates). Returns { differingFields, line }: field names in
// comparison order, and the single code-built line for the first money or
// customer difference (null when the readings agree). Item, heard-text and
// question wording never count; neither does casing. The one exception is
// the expense category, which lives in item and is compared as "category".
export function compareReadings(primaryEntries, primaryPromise, secondRaw, { shopId, now = Date.now() } = {}) {
  const second = checkModelOutput(secondRaw, shopId, { existingCustomers: [], now });
  const fields = [];
  let line = null;
  const note = (field, text) => {
    if (!fields.includes(field)) fields.push(field);
    if (!line) line = text;
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
    if (x.amountKobo !== y.amountKobo) {
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
    if (x.priceBasis !== y.priceBasis) {
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
  return { differingFields: fields, line };
}

// Full check for one proposal: fetches the second reading and compares it
// against the primary checked entries. Always resolves — { agreed,
// differingFields, latencyMs, line } — and never throws: missing keys, an
// empty transcript, transport errors and unparseable output all degrade to
// no_second_opinion. Keys come from env (process.env in production).
export async function runSecondOpinion({
  heardText,
  entries,
  promise,
  shopId,
  now = Date.now(),
  fetchFn = fetch,
  env = process.env,
  timeoutMs = SECOND_OPINION_TIMEOUT_MS,
}) {
  const quiet = { agreed: "no_second_opinion", differingFields: [], latencyMs: 0, line: null };
  const apiKey = env?.BASETEN_API_KEY;
  const model = env?.BASETEN_MODEL;
  if (!apiKey || !model) return quiet;
  if (typeof heardText !== "string" || !heardText.trim() || heardText.trim() === "(no transcript)") return quiet;
  const { reading, latencyMs } = await fetchSecondReading(heardText, { apiKey, model, fetchFn, timeoutMs });
  if (!reading) return { ...quiet, latencyMs };
  let compared;
  try {
    compared = compareReadings(entries ?? [], promise ?? null, reading, { shopId, now });
  } catch {
    return { ...quiet, latencyMs };
  }
  if (compared.differingFields.length === 0) return { agreed: "yes", differingFields: [], latencyMs, line: null };
  return { agreed: "no", differingFields: compared.differingFields, latencyMs, line: compared.line };
}
