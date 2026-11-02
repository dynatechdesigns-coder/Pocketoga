// General photo pipeline, first use Alert Guard: the trader sends a photo,
// the AI classifies its type and extracts fields as JSON, plain code runs
// every check, the trader confirms. The AI never decides "real" or "fake"
// and its words never steer code: all text from the photo is data.
//
// Nothing from the raw photo is stored — extracted fields only. Recording
// happens through the normal proposal flow: a photo proposal carries
// photoCheck { photoType, fields, warnings, matchedCustomer }, has no
// ledger entries, and confirm writes a payment_checks row (never the
// ledger). Photo types today: payment_alert (screenshot or SMS), unknown.
import { DatabaseSync } from "node:sqlite";
import { voiceError, namesSimilar, toProposal, resolveOccurredAt } from "./voice.mjs";
import { TEXT_MODEL } from "./model.mjs";
import { parseNaira, formatKobo } from "./money.mjs";
import { allocatedSales, customerDebts, lagosDay, daysBetween } from "./debts.mjs";

export const PHOTO_TYPES = ["payment_alert", "unknown"];

// Alert dates may be today or up to this many days back (Lagos calendar).
export const ALERT_MAX_AGE_DAYS = 2;
const SUCCESS_STATUSES = ["successful", "success"];

export const PHOTO_SYSTEM_PROMPT = `You read one photo for PocketOga, a bookkeeping assistant for Nigerian market traders. Reply with JSON only, exactly this shape:
{
  "photoType": "payment_alert",
  "status": "successful",
  "date": "2026-10-29",
  "amountNaira": 12000,
  "amountPhrase": "12k",
  "sender": "Ada",
  "reference": "000123456789"
}
Rules:
- photoType is "payment_alert" for a bank transfer screenshot or SMS alert, otherwise "unknown" (then send only {"photoType": "unknown"}).
- Copy every field exactly as shown; never judge whether the alert is real or fake.
- status is the alert's status word (or null when not shown).
- date is the alert's calendar date as YYYY-MM-DD (or null when not shown).
- amountNaira is a whole non-negative naira integer; amountPhrase is the exact digits shown (or null).
- sender is the sender name shown; reference is the reference number shown (or null each).
- Never invent a field that is not shown; use null.`;

export const UNKNOWN_PHOTO_FLAG = "I don't recognise this photo — I can only read payment alerts for now.";
const CONFUSED_PHOTO_FLAG = "I couldn't read that photo — abeg send am again.";

export const PAYMENT_CHECK_SCHEMA = `
CREATE TABLE IF NOT EXISTS payment_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  proposal_id INTEGER,
  photo_type TEXT NOT NULL,
  customer TEXT,
  sender TEXT,
  amount_kobo INTEGER NOT NULL CHECK (typeof(amount_kobo) = 'integer' AND amount_kobo >= 0),
  reference TEXT,
  alert_date TEXT,
  alert_status TEXT,
  warnings_json TEXT NOT NULL,
  check_status TEXT NOT NULL CHECK (check_status IN ('unconfirmed','confirmed')),
  created_at TEXT NOT NULL,
  occurred_at TEXT,
  seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_checks_shop ON payment_checks(shop_id);
`;

export class PhotoCheckStore {
  // dbPathOrDb: a path (owned connection) or a shared DatabaseSync.
  constructor(dbPathOrDb = ":memory:") {
    if (typeof dbPathOrDb === "string") {
      this.db = new DatabaseSync(dbPathOrDb);
      this.ownsDb = true;
    } else {
      this.db = dbPathOrDb;
      this.ownsDb = false;
    }
    this.db.exec(PAYMENT_CHECK_SCHEMA);
    // Databases created before the offline queue get it now.
    const columns = this.db
      .prepare("PRAGMA table_info(payment_checks)")
      .all()
      .map((c) => c.name);
    if (!columns.includes("occurred_at")) {
      this.db.exec("ALTER TABLE payment_checks ADD COLUMN occurred_at TEXT");
    }
  }

  create({ shopId, proposalId = null, photoType, customer = null, sender = null, amountKobo, reference = null, alertDate = null, alertStatus = null, warnings = [], createdAt = null, occurredAt = null }) {
    if (!shopId || typeof shopId !== "string") throw new Error("shopId is required");
    if (!Number.isInteger(amountKobo) || amountKobo < 0) throw new Error("amountKobo must be a non-negative integer (kobo)");
    const stamp = createdAt ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO payment_checks
           (shop_id, proposal_id, photo_type, customer, sender, amount_kobo, reference, alert_date, alert_status, warnings_json, check_status, created_at, occurred_at, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unconfirmed', ?, ?, NULL)`
      )
      .run(shopId, proposalId, photoType, customer, sender, amountKobo, reference, alertDate, alertStatus, JSON.stringify(warnings ?? []), stamp, occurredAt ?? stamp);
    return this.get(Number(result.lastInsertRowid));
  }

  get(id) {
    return this.db.prepare("SELECT * FROM payment_checks WHERE id = ?").get(id) ?? null;
  }

  listByShop(shopId) {
    return this.db.prepare("SELECT * FROM payment_checks WHERE shop_id = ? ORDER BY id ASC").all(shopId);
  }

  listUnconfirmedByShop(shopId) {
    return this.db
      .prepare("SELECT * FROM payment_checks WHERE shop_id = ? AND check_status = 'unconfirmed' ORDER BY created_at ASC, id ASC")
      .all(shopId);
  }

  // A reference counts as seen case-insensitively; a missing one never does.
  referenceSeen(shopId, reference) {
    if (typeof reference !== "string" || !reference.trim()) return false;
    const row = this.db
      .prepare("SELECT 1 AS seen FROM payment_checks WHERE shop_id = ? AND reference IS NOT NULL AND UPPER(reference) = UPPER(?) LIMIT 1")
      .get(shopId, reference.trim());
    return !!row;
  }

// Public check shape for the web "Check alert" screen: extracted fields
// only — never the photo (raw photos are never stored) and no phone
// numbers. `sender` is the stored sender name as recorded. `warnings` is
// the stored list, parsed defensively.
  toPublicCheck(row) {
  let warnings = [];
  try {
    const parsed = JSON.parse(row.warnings_json ?? "[]");
    if (Array.isArray(parsed)) warnings = parsed.filter((w) => typeof w === "string");
  } catch {
    warnings = [];
  }
  return {
    id: row.id,
    amount_kobo: row.amount_kobo,
    sender: row.sender ?? null,
    alert_date: row.alert_date ?? null,
    created_at: row.created_at,
    occurred_at: row.occurred_at ?? row.created_at ?? null,
    warnings,
  };
}

  // "I saw it in my bank": unconfirmed -> confirmed, stamping seen_at.
  // Idempotent: an already-confirmed row comes back unchanged.
  markSeen(id) {
    const row = this.get(id);
    if (!row) throw new Error(`payment check ${id} not found`);
    if (row.check_status === "confirmed") return row;
    this.db.prepare("UPDATE payment_checks SET check_status = 'confirmed', seen_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return this.get(id);
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}

function cleanStr(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function validAlertDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10) === value ? value : null;
}

// The model's raw JSON into validated fields. Anything unreadable becomes
// null and is reported by the checks; nothing here throws on content.
function readAlertFields(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const amountNaira = Number.isInteger(r.amountNaira) && r.amountNaira >= 0 ? r.amountNaira : null;
  return {
    status: cleanStr(r.status),
    date: validAlertDate(typeof r.date === "string" ? r.date.trim() : null),
    amountKobo: amountNaira === null ? null : amountNaira * 100,
    amountPhrase: cleanStr(r.amountPhrase),
    sender: cleanStr(r.sender),
    reference: cleanStr(r.reference),
  };
}

// Alert Guard checks, in code. Returns { warnings, matchedCustomer }.
// Every check degrades silently on missing input: the fields check owns
// missing values, so no problem is ever reported twice.
export function checkPaymentAlert(fields, { ledgerRows = [], checkRows = [], now = Date.now() } = {}) {
  const warnings = [];
  const missing = [];
  if (!fields.status) missing.push("status");
  if (!fields.date) missing.push("date");
  if (!Number.isInteger(fields.amountKobo)) missing.push("amount");
  if (!fields.sender) missing.push("sender");
  if (missing.length > 0) warnings.push(`Some alert fields are missing or unreadable: ${missing.join(", ")}.`);
  if (fields.status && !SUCCESS_STATUSES.includes(fields.status.toLowerCase())) {
    warnings.push(`Status is "${fields.status}", not successful.`);
  }
  if (fields.date) {
    const today = lagosDay(now);
    if (fields.date > today) {
      warnings.push(`Date ${fields.date} is in the future.`);
    } else if (daysBetween(fields.date, today) > ALERT_MAX_AGE_DAYS) {
      warnings.push(`Date ${fields.date} is more than ${ALERT_MAX_AGE_DAYS} days old.`);
    }
  }
  let matchedSales = [];
  if (Number.isInteger(fields.amountKobo)) {
    matchedSales = allocatedSales(ledgerRows, { now }).filter((s) => s.remainingKobo > 0 && s.remainingKobo === fields.amountKobo);
    if (matchedSales.length === 0) warnings.push(`Amount ${formatKobo(fields.amountKobo)} matches no unpaid sale.`);
  }
  if (fields.sender) {
    const pool = matchedSales.length > 0 ? matchedSales.map((s) => s.customer) : customerDebts(ledgerRows, { now }).filter((d) => d.owedKobo > 0).map((d) => d.customer);
    const want = normName(fields.sender);
    const ok = pool.some((c) => {
      const norm = normName(c);
      return norm && (norm === want || namesSimilar(want, norm));
    });
    if (!ok) warnings.push(`Sender "${fields.sender}" matches no customer.`);
  }
  if (!fields.reference) {
    warnings.push("No reference number found.");
  } else if ((checkRows ?? []).some((c) => typeof c.reference === "string" && c.reference.trim().toUpperCase() === fields.reference.toUpperCase())) {
    warnings.push(`Reference ${fields.reference} was already used in this shop.`);
  }
  if (fields.amountPhrase && Number.isInteger(fields.amountKobo)) {
    try {
      if (parseNaira(fields.amountPhrase).kobo !== fields.amountKobo) {
        warnings.push(`Amount "${fields.amountPhrase}" doesn't match the ${formatKobo(fields.amountKobo)} figure.`);
      }
    } catch {
      // An unreadable phrase is not evidence either way; stay silent.
    }
  }
  const matchedCustomer =
    matchedSales.length > 0
      ? String(matchedSales[0].customer).trim()
      : (() => {
          const debtors = customerDebts(ledgerRows, { now }).filter((d) => d.owedKobo > 0);
          const want = normName(fields.sender);
          const hit = debtors.find((d) => {
            const norm = normName(d.customer);
            return norm && (norm === want || namesSimilar(want, norm));
          });
          return hit ? hit.customer : null;
        })();
  return { warnings, matchedCustomer };
}

const PHOTO_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

function checkPhotoInput(input) {
  const data = input && typeof input === "object" ? input.photoBase64 : null;
  const format = input && typeof input === "object" ? input.photoFormat : null;
  if (typeof data !== "string" || !data) throw voiceError(400, "photoBase64 is required");
  const mime = typeof format === "string" ? PHOTO_MIME[format.toLowerCase()] : null;
  if (!mime) throw voiceError(400, 'photoFormat "png", "jpg" or "jpeg" is required');
  return { data, mime };
}

function isBadJson(err) {
  return !!err && err.code === "MODEL_BAD_JSON";
}

// Classifies one photo, extracts its fields and runs the code checks,
// storing a proposal the trader confirms as usual. Unknown photos become
// flagged proposals with no Save button; nothing is ever recorded here.
export async function proposePhotoCheck(shopId, input, { proposals, model, ledger, photoChecks, now = Date.now(), occurredAt = null }) {
  if (!proposals || !model || !ledger || !photoChecks) {
    throw new Error("proposePhotoCheck needs { proposals, model, ledger, photoChecks }");
  }
  if (!shopId || typeof shopId !== "string") throw voiceError(400, "shopId is required");
  const photo = checkPhotoInput(input);
  const happenedAt =
    resolveOccurredAt(occurredAt ?? input?.occurred_at, now) ?? new Date(now).toISOString();
  // The ai block for a photo run: nothing is transcribed, the photo model
  // understands, and no second opinion ever runs on photos.
  const photoAi = (ms) => ({
    heard: { model: null, ms: 0 },
    understood: { model: TEXT_MODEL, ms },
    secondOpinion: { model: null, ms: 0, result: "off" },
  });
  let raw;
  let modelMs = 0;
  try {
    const tModel = Date.now();
    raw = await model.complete({ image: { data: photo.data, format: photo.mime }, system: PHOTO_SYSTEM_PROMPT });
    modelMs = Date.now() - tModel;
  } catch (err) {
    if (!isBadJson(err)) throw err; // transport/API errors propagate; nothing stored
    raw = null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const row = proposals.create({
      shopId,
      envelope: {
        version: 1,
        entries: [],
        totals: null,
        flags: [CONFUSED_PHOTO_FLAG],
        notes: [],
        promise: null,
        photoCheck: { photoType: "unknown", fields: null, warnings: [], matchedCustomer: null },
        ai: photoAi(modelMs),
      },
      heard: "(photo)",
      question: CONFUSED_PHOTO_FLAG,
      occurredAt: happenedAt,
    });
    return toProposal(row);
  }
  if (raw.photoType !== "payment_alert") {
    const row = proposals.create({
      shopId,
      envelope: {
        version: 1,
        entries: [],
        totals: null,
        flags: [UNKNOWN_PHOTO_FLAG],
        notes: [],
        promise: null,
        photoCheck: { photoType: "unknown", fields: null, warnings: [], matchedCustomer: null },
        ai: photoAi(modelMs),
      },
      heard: "(photo)",
      question: UNKNOWN_PHOTO_FLAG,
      occurredAt: happenedAt,
    });
    return toProposal(row);
  }
  const fields = readAlertFields(raw);
  const { warnings, matchedCustomer } = checkPaymentAlert(fields, {
    ledgerRows: ledger.list(shopId),
    checkRows: photoChecks.listByShop(shopId),
    now,
  });
  const row = proposals.create({
    shopId,
    envelope: {
      version: 1,
      entries: [],
      totals: null,
      flags: [],
      notes: [],
      promise: null,
      photoCheck: { photoType: "payment_alert", fields, warnings, matchedCustomer },
      ai: photoAi(modelMs),
    },
    heard: "(photo)",
    question: null,
    occurredAt: happenedAt,
  });
  return toProposal(row);
}
