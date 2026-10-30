// The "Check alert" screen's logic: what to wait on, how to read a photo
// proposal into a card, and the save / saw-it-in-my-bank flow. Plain
// JavaScript so the web tests can run it under node. The wording rule lives
// here: a card only ever says "warning signs found" or "no warning signs
// found". It never claims an alert is good; the bank app decides that.
import { confirmProposal, friendlyError, markSeenInBank } from "./api.js";
import { formatKobo } from "./format.js";

export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_SIDE = 1600;
export const MAX_BYTES = 1_000_000;

// Shown in order; the third is the 25 s long-wait line. At 40 s we stop.
export const ALERT_STAGES = ["Reading the alert…", "Checking the details…", "Still working… this is taking longer than usual."];
export const ALERT_STAGE_DELAYS_MS = [3000, 25_000];
export const ALERT_TIMEOUT_MS = 40_000;

export const FIXED_LINE = "This is a check, not proof. Confirm in your bank app before releasing goods.";

export const FILE_MESSAGES = {
  type: "Please use a JPEG, PNG or WebP photo.",
  read: "We could not open that photo. Please try another one.",
};

export const isAcceptedType = (type) => ACCEPTED_TYPES.includes(String(type).toLowerCase());

// The size to draw at: the long side at most `max`, never scaled up.
export function fitWithin(width, height, max = MAX_SIDE) {
  const long = Math.max(width, height);
  if (!(long > 0)) return { width: 0, height: 0 };
  if (long <= max) return { width, height };
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Base64 length to bytes (for the ~1 MB check).
export const base64Bytes = (b64) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

// Warnings the server flags as serious: a status that is not successful, a
// future date, a reference used before, an amount that disagrees with itself.
// Everything else (missing details, no matching sale or customer) is caution.
const SERIOUS = [/not successful/i, /in the future/i, /already used/i, /doesn't match the/i];
export const warningSeverity = (text) => (SERIOUS.some((re) => re.test(text)) ? "serious" : "caution");

const FIELD_ROWS = [
  ["sender", "Sender"],
  ["amount", "Amount"],
  ["date", "Date"],
  ["status", "Status"],
  ["reference", "Reference"],
];

const dateWords = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
};

// A photo proposal into what the card shows.
// kind: clean | warned | unreadable | notAlert. `canSave` is false only for a
// photo that is not a payment alert; warned alerts can still be saved.
export function describeCheck(proposal) {
  const pc = proposal?.photoCheck;
  if (!pc || pc.photoType !== "payment_alert") {
    return {
      kind: "notAlert",
      title: "This does not look like a payment alert",
      detail: proposal?.question || "PocketOga can only check bank SMS and transfer screenshots for now.",
      rows: [],
      warnings: [],
      canSave: false,
      fixedLine: FIXED_LINE,
    };
  }
  const f = pc.fields ?? {};
  const values = {
    sender: f.sender ?? null,
    amount: Number.isInteger(f.amountKobo) ? formatKobo(f.amountKobo) : null,
    date: f.date ? dateWords(f.date) : null,
    status: f.status ?? null,
    reference: f.reference ?? null,
  };
  const rows = FIELD_ROWS.map(([key, label]) => ({ key, label, value: values[key] ?? "Not shown" }));
  const warnings = (pc.warnings ?? []).map((text) => ({ text, severity: warningSeverity(text) }));
  if (FIELD_ROWS.every(([key]) => values[key] === null)) {
    return {
      kind: "unreadable",
      title: "We could not read this alert",
      detail: "Try again in good light, with the whole alert in the photo.",
      rows: [],
      warnings: [],
      canSave: false,
      fixedLine: FIXED_LINE,
    };
  }
  const warned = warnings.length > 0;
  return {
    kind: warned ? "warned" : "clean",
    title: warned ? `Warning signs found (${warnings.length})` : "No warning signs found",
    detail: warned ? "Look at these before you hand over goods." : null,
    rows,
    warnings,
    canSave: true,
    fixedLine: FIXED_LINE,
  };
}

// Save the check as unconfirmed (POST /confirm/:id, the existing route) and,
// when `markSeen` is set, only then mark it seen in the bank. Nothing is
// marked unless the save went through. Returns { saved, already, checkId,
// seen, seenMessage }; a failed save throws, a failed mark does not (the
// check stays saved and unconfirmed).
export async function saveAlert(proposal, { markSeen = false, mark = markSeenInBank } = {}) {
  const res = await confirmProposal(proposal.id);
  const checkId = res.recordedIds?.paymentCheckId ?? null;
  const out = { saved: true, already: !!res.alreadyConfirmed, checkId, seen: false, seenMessage: null };
  if (markSeen) Object.assign(out, await markSeenSafely(checkId, mark));
  return out;
}

// "I saw it in my bank" for a check that is already saved. A failure keeps the
// check saved and unconfirmed and gives a plain sentence for Try again.
export async function markSeenSafely(checkId, mark = markSeenInBank) {
  try {
    await mark(checkId);
    return { seen: true, seenMessage: null };
  } catch (err) {
    return { seen: false, seenMessage: friendlyError(err) };
  }
}

// --- Browser only: picking and shrinking the photo ----------------------------

const readAsDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("read"));
    r.readAsDataURL(blob);
  });

// Shrinks the picked file to JPEG, long side at most MAX_SIDE and about
// MAX_BYTES, and returns { base64, format: "jpg", thumbUrl }. JPEG always, so
// a WebP pick still matches the route's png/jpg/jpeg. The caller revokes
// thumbUrl as soon as the result is shown.
export async function prepareAlertPhoto(file) {
  if (!file || !isAcceptedType(file.type)) throw new Error("type");
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("read");
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  let base64 = "";
  let blob = null;
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new Error("read");
    if (blob.size <= MAX_BYTES) break;
  }
  base64 = (await readAsDataUrl(blob)).split(",")[1] ?? "";
  if (!base64) throw new Error("read");
  return { base64, format: "jpg", thumbUrl: URL.createObjectURL(blob) };
}

// Age of a saved check for the list ("today", "2 days").
export function checkAgeDays(createdAt, now = Date.now()) {
  const ms = now - Date.parse(createdAt);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 86_400_000) : 0;
}
