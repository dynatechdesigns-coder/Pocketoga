// Editing any entry: the request, what the Edit sheet may change, which rows the
// list shows, and the plain "Was ₦6,300, now ₦63,000" line. Plain JavaScript so
// the web tests can run it.
//
//   POST /entries/:id/correct
//   header  x-request-id: <the item's request id, the same on every retry>
//   body    { amountKobo?, customer?, item?, quantity?, unit?, date?, type?, reason? }
//   201     { proposal }  (nothing is saved until POST /confirm/:id)
//   400/409 { error } in plain words (for example a sale that already has payments)
//   list fields on GET /ledger: canCorrect, wasCorrected, currentVersionId
import { formatDueDay, formatKobo, itemText, lagosToday, nairaInput, parseNaira } from "./format.js";

export const CORRECTION_KIND = "correction"; // the offline queue's kind for an edit
export const QUEUED_EDIT_MESSAGE = "Saved on your phone. It will be sent when you are back online.";
export const EDIT_FAILED_MESSAGE = "Could not check the change. Please try again.";

export const correctionPath = (entryId) => `/entries/${encodeURIComponent(entryId)}/correct`;

// meta: { requestId }.
export function buildCorrectionRequest(entryId, changes, meta = {}) {
  return {
    path: correctionPath(entryId),
    body: { ...changes },
    headers: meta.requestId ? { "x-request-id": meta.requestId } : undefined,
  };
}

// The Edit action shows only when the backend says the row can be corrected.
export const canEdit = (entry) => entry?.canCorrect === true;

// Newest version only: an entry that a later correction replaced is not listed.
// A server that sends canCorrect/wasCorrected says it directly; an older one is
// read from correctedById or the corrects_id links.
export function currentEntries(entries) {
  const all = entries ?? [];
  return all.filter((e) => {
    if (e.wasCorrected === true && e.canCorrect === false) return false;
    if (e.canCorrect === undefined && (e.correctedById ?? all.find((x) => x.corrects_id === e.id)?.id) != null) return false;
    return true;
  });
}

// The version that counts now, for an entry that may have been corrected once or
// many times. Follows currentVersionId, else correctedById, else the links.
export function currentOf(entry, all) {
  const list = all ?? [];
  let cur = entry;
  const seen = new Set([entry.id]);
  for (;;) {
    const nextId = cur.currentVersionId !== undefined && cur.currentVersionId !== cur.id ? cur.currentVersionId : cur.correctedById ?? list.find((x) => x.corrects_id === cur.id)?.id ?? null;
    const next = nextId == null || seen.has(nextId) ? null : list.find((x) => x.id === nextId) ?? null;
    if (!next) return cur;
    seen.add(next.id);
    cur = next;
  }
}

// The amount the entry had before it was corrected, when it changed; else null.
export function wasKobo(entry, all) {
  const was = earlierVersion(entry, all);
  return was && was.amount_kobo !== entry.amount_kobo ? was.amount_kobo : null;
}

// Rows for a list of one kind of entry (for example sales): one row per original
// entry, each at its current version, so the amount shown is the amount that
// counts and the rows match the totals. -> [{ entry, wasKobo, corrected }]
export function currentRows(all, keep) {
  return (all ?? [])
    .filter((e) => e.corrects_id == null && keep(e))
    .map((original) => {
      const entry = currentOf(original, all);
      return { entry: { ...entry, type: original.type }, wasKobo: wasKobo(entry, all), corrected: entry.id !== original.id };
    });
}

// The row an entry corrects, when it is itself a correction.
export const earlierVersion = (entry, all) => (entry.corrects_id != null ? (all ?? []).find((x) => x.id === entry.corrects_id) ?? null : null);

// "Was ₦6,300, now ₦63,000" for what changed between two versions, in plain
// words. Null when there is nothing to compare.
export function wasNowLine(entry, all) {
  const was = earlierVersion(entry, all);
  if (!was) return null;
  const parts = [];
  if (was.amount_kobo !== entry.amount_kobo) parts.push(`Was ${formatKobo(was.amount_kobo)}, now ${formatKobo(entry.amount_kobo)}`);
  if ((was.customer ?? null) !== (entry.customer ?? null)) parts.push(`name was ${was.customer ?? "empty"}, now ${entry.customer ?? "empty"}`);
  if (itemText(was) !== itemText(entry)) parts.push(`item was ${itemText(was) || "empty"}, now ${itemText(entry) || "empty"}`);
  if (dayOf(was.created_at) !== dayOf(entry.created_at)) parts.push(`date was ${formatDueDay(dayOf(was.created_at))}, now ${formatDueDay(dayOf(entry.created_at))}`);
  if (parts.length === 0) return null;
  const text = parts.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const dayOf = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });

// --- The Edit sheet -----------------------------------------------------------

// What the sheet starts with: the entry as it is now. `shopId` is the name an
// entry for the shop itself carries; it shows as an empty label.
export function editStart(entry, shopId) {
  return {
    amount: nairaInput(entry.amount_kobo),
    item: entry.item ?? "",
    customer: entry.customer === shopId ? "" : entry.customer ?? "",
    date: dayOf(entry.created_at),
  };
}

// A chosen day as the ISO time the server wants: noon in Lagos, or right now
// when that is still ahead of us (today). Null for a day that is not a date.
export function dateToIso(day, nowMs = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ""))) return null;
  const noon = Date.parse(`${day}T12:00:00+01:00`);
  if (Number.isNaN(noon)) return null;
  return new Date(Math.min(noon, nowMs)).toISOString();
}

// -> { changes } with only what changed, or { error, field } in plain words.
export function editChanges(start, v, { today = lagosToday(), nowMs = Date.now() } = {}) {
  const changes = {};
  const amountKobo = parseNaira(v.amount);
  if (String(v.amount ?? "").trim() === "") return { error: "Type the amount.", field: "amount" };
  if (amountKobo === null) return { error: "Type the amount in numbers, like 15000 or 15,000.50.", field: "amount" };
  if (amountKobo <= 0) return { error: "The amount must be more than ₦0.", field: "amount" };
  if (v.amount !== start.amount && amountKobo !== parseNaira(start.amount)) changes.amountKobo = amountKobo;

  if (String(v.customer ?? "").length > 100) return { error: "The name can be at most 100 characters.", field: "customer" };
  if (String(v.item ?? "").length > 100) return { error: "The item can be at most 100 characters.", field: "item" };
  if (v.customer.trim() && v.customer.trim() !== start.customer) changes.customer = v.customer.trim();
  if (v.item.trim() !== start.item) changes.item = v.item.trim() || null;

  if (v.date !== start.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date ?? "")) return { error: "Pick the date.", field: "date" };
    if (v.date > today) return { error: "The date cannot be in the future.", field: "date" };
    changes.date = dateToIso(v.date, nowMs);
  }
  if (Object.keys(changes).length === 0) return { error: "Change at least one detail above.", field: null, unchanged: true };
  return { changes };
}

// One plain sentence for a refused edit. The server's own message is shown
// when it is plain words (for example, a sale with payments cannot change
// its amount); code-style text never is.
const TECHNICAL_WORDS = /\b(undefined|null|payload|json|exception|stack|sqlite)\b|^server error \d+$/i;
const CODE_NAMES = /[a-z][A-Z]|_/;
export function correctionError(err) {
  const status = err?.status;
  if (status === 0) return "Cannot reach PocketOga. Check your connection and try again.";
  if (status === 404) return "We could not find that entry. Please reload and try again.";
  const m = typeof err?.message === "string" ? err.message.trim() : "";
  if ((status === 400 || status === 409) && m && !TECHNICAL_WORDS.test(m) && !CODE_NAMES.test(m.replace(/PocketOga/g, "Pocket"))) {
    return m.charAt(0).toUpperCase() + m.slice(1) + (/[.!?]$/.test(m) ? "" : ".");
  }
  if (status === 400 || status === 409) return "This entry cannot be changed that way. Check the details and try again.";
  return EDIT_FAILED_MESSAGE;
}

// The one line "Waiting to send" shows for a queued edit.
export function correctionSummary(payload) {
  const c = payload?.changes ?? {};
  const parts = ["Edit"];
  if (Number.isInteger(c.amountKobo)) parts.push(`new amount ${formatKobo(c.amountKobo)}`);
  if (c.customer) parts.push(c.customer);
  if (c.item) parts.push(c.item);
  if (c.date) parts.push(`dated ${formatDueDay(dayOf(c.date))}`);
  return parts.join(" · ");
}
