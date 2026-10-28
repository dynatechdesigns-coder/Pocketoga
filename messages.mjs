// Every user-facing WhatsApp string and builder in one place. Presentation
// only: no checks, no parsing, no state. whatsapp.mjs owns all logic and
// calls in here to render replies.
//
// Conventions: WhatsApp *bold* / _italic_, short lines, blank lines between
// blocks. Only these emojis: sale, payment, restock, needs-checking,
// saved, balance (see EMOJI). Amounts via formatKobo: naira sign with
// thousands separators, kobo only when non-zero. Interactive bodies stay
// under 1024 characters (the heard quote shrinks first); button titles stay
// under 20 characters; no footer unless a card ever needs one.
import { formatKobo } from "./money.mjs";

export const MAX_BODY_CHARS = 1024;
export const MAX_HEARD_CHARS = 120;

export const EMOJI = {
  sale: "🛒",
  payment: "💵",
  restock: "📦",
  check: "⚠️",
  saved: "✅",
  balance: "⚖️",
};

// --- One-line replies --------------------------------------------------------
// Short and polite; only the error reply carries an emoji.

export const REJECTED = "Not saved. Send a new note anytime.";
export const FIX_ASK = "What should I change? Send the correction as text or a voice note.";
export const ALREADY_SAVED = "Already saved — recorded once.";
export const NOT_REGISTERED = "Sorry, this number is not registered on PocketOga — ask your shop owner to register it.";
export const UNSUPPORTED = "I can only read text and voice notes for now.";
export const EXPIRED_PROPOSAL = "That proposal has expired — please send the note again.";
export const GENERIC_ERROR = "⚠️ Sorry, something went wrong. Please try again.";
export const UNKNOWN_BUTTON = "I didn't understand that button. Send your note again.";
export const PROPOSAL_NOT_FOUND = "I can't find that proposal. Send your note again.";
export const OTHER_SHOP = "That proposal belongs to another shop.";
export const FFMPEG_MISSING = "Sorry, I can't listen to voice notes right now. Please send it as text.";
export const AUDIO_FAILED = "Sorry, I couldn't process that voice note. Please send it as text.";
export const HEAR_FAILED = "I couldn't hear that — please send the correction again.";
export const BAD_AUDIO_JSON = "I no hear am well — abeg talk am again.";
export const CORRECTION_AS_TEXT = "Please send the correction as text or a voice note.";

export const alreadyConfirmedFix = (proposalId) =>
  `Proposal ${proposalId} is already confirmed; send a new note to correct it.`;

// Maps a thrown error to the sentence the trader sees. Expiry gets its own
// polite line; other status errors keep their specific message (they name
// the exact problem and remedy); anything else is the generic error.
export function friendlyErrorText(err) {
  if (err && err.status === 410) return EXPIRED_PROPOSAL;
  if (err && typeof err.status === "number") return err.message;
  return GENERIC_ERROR;
}

// --- Formatting helpers ------------------------------------------------------

// WhatsApp has no backslash escape, so formatting characters inside
// user/model text are swapped for fullwidth lookalikes that render almost
// the same but can never open or close *bold* / _italic_ / ~strike~ / `mono`.
const MD_SWAP = { "*": "＊", _: "＿", "~": "～", "`": "｀" };

export function escapeMd(text) {
  return String(text ?? "").replace(/[*_~`]/g, (ch) => MD_SWAP[ch]);
}

function boldAmount(kobo) {
  return Number.isInteger(kobo) ? `*${formatKobo(kobo)}*` : "amount unknown";
}

function pluralUnit(quantity, unit) {
  return quantity === 1 ? unit : `${unit}s`;
}

// "2 bags of rice", "rice x 2", "rice". Null when there is nothing to say.
function describeGoods(e) {
  const item = e.item ? escapeMd(e.item) : null;
  const unit = e.unit ? escapeMd(e.unit) : null;
  const qty = Number.isInteger(e.quantity) ? e.quantity : null;
  if (item && qty !== null && unit) return `${qty} ${pluralUnit(qty, unit)} of ${item}`;
  if (item && qty !== null) return `${item} × ${qty}`;
  if (item) return item;
  if (qty !== null && unit) return `${qty} ${pluralUnit(qty, unit)}`;
  if (qty !== null) return `× ${qty}`;
  return null;
}

function saleBody(e) {
  const goods = describeGoods(e);
  const total = boldAmount(e.amountKobo);
  if (goods && Number.isInteger(e.eachKobo)) {
    return `${goods} × ${formatKobo(e.eachKobo)} = ${total}`;
  }
  if (goods) return `${goods}: ${total}`;
  return `Sale: ${total}`;
}

function restockBody(e) {
  const goods = describeGoods(e) ?? "Restock";
  const total = boldAmount(e.amountKobo);
  if (Number.isInteger(e.eachKobo)) {
    return `${goods} × ${formatKobo(e.eachKobo)} = ${total}`;
  }
  return `${goods}: ${total}`;
}

// One proposal entry as a card line. In multi-customer cards every line is
// prefixed with its customer; otherwise the header already names them.
function entryLine(e, prefixCustomer) {
  const pre = prefixCustomer && e.customer ? `*${escapeMd(e.customer)}*: ` : "";
  if (e.type === "payment") return `${pre}${EMOJI.payment} Paid: ${boldAmount(e.amountKobo)}`;
  if (e.type === "restock") return `${pre}${EMOJI.restock} ${restockBody(e)}`;
  return `${pre}${saleBody(e)}`;
}

function multipleCustomers(entries) {
  return new Set(entries.map((e) => e.customer).filter((c) => c !== null && c !== undefined)).size > 1;
}

function cardHeader(proposal, shopId) {
  const first = proposal.entries[0];
  const emoji = first && EMOJI[first.type] ? `${EMOJI[first.type]} ` : "";
  const customer = first?.customer;
  if (customer && customer !== shopId) return `${emoji}*${escapeMd(customer)}*`;
  const label = first ? first.type[0].toUpperCase() + first.type.slice(1) : "Note";
  return `${emoji}*${label}*`;
}

// Heard quote, one line, in italics. maxChars bounds the quoted text;
// non-positive hides the quote (used when shrinking an over-long card).
export function heardLine(heard, maxChars = MAX_HEARD_CHARS) {
  if (maxChars <= 0) return null;
  const flat = String(heard ?? "").trim().replace(/\s+/g, " ");
  if (!flat) return null;
  const cut = flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
  return `_"${escapeMd(cut)}"_`;
}

// --- Balances ----------------------------------------------------------------

// What the customer owes: sales minus payments over the shop's existing
// ledger rows plus the proposal's own entries. Customer match is
// case-insensitive exact. Restock is stock, not debt, so it never counts.
export function customerOwedKobo({ existing = [], proposalEntries = [], customer }) {
  const want = String(customer).toLowerCase();
  const same = (name) => typeof name === "string" && name.toLowerCase() === want;
  let owed = 0;
  for (const r of existing) {
    if (!same(r.customer)) continue;
    if (r.type === "sale") owed += r.amount_kobo;
    else if (r.type === "payment") owed -= r.amount_kobo;
  }
  for (const e of proposalEntries) {
    if (!same(e.customer) || !Number.isInteger(e.amountKobo)) continue;
    if (e.type === "sale") owed += e.amountKobo;
    else if (e.type === "payment") owed -= e.amountKobo;
  }
  return owed;
}

// "Ada owes ..." lines, one per known customer with a positive balance.
// Customers with nothing owed (or the shop itself on self-restock) stay out.
function owesLines(proposal, existing, shopId, suffix) {
  const seen = new Set();
  const lines = [];
  for (const e of proposal.entries) {
    if (!e.customer || e.customer === shopId || seen.has(e.customer)) continue;
    seen.add(e.customer);
    const owed = customerOwedKobo({ existing, proposalEntries: proposal.entries, customer: e.customer });
    if (owed > 0) lines.push(`${EMOJI.balance} ${escapeMd(e.customer)} owes *${formatKobo(owed)}*${suffix}`);
  }
  return lines;
}

// --- Proposal cards ------------------------------------------------------------

function totalsLines(totals) {
  if (!totals) return [];
  const legs = [];
  if (Number.isInteger(totals.totalKobo)) legs.push(`Total: *${formatKobo(totals.totalKobo)}*`);
  if (Number.isInteger(totals.paidKobo)) legs.push(`Paid: *${formatKobo(totals.paidKobo)}*`);
  if (Number.isInteger(totals.remainderKobo)) legs.push(`Remainder: *${formatKobo(totals.remainderKobo)}*`);
  return legs;
}

function sameCheck(a, b) {
  const norm = (s) => String(s).trim().toLowerCase().replace(/[?!.\s]+$/g, "");
  return norm(a) === norm(b);
}

// Flags plus the question, each exactly once. The model's question echoes
// back as a "needs clarification:" flag, and code-built questions wrap the
// flags ("Abeg check am: ..."), so both shapes collapse to single lines.
export function dedupeChecks(proposal) {
  const items = [];
  for (const flag of proposal.flags ?? []) {
    const text = String(flag).replace(/^needs clarification:\s*/i, "");
    if (!items.some((x) => sameCheck(x, text))) items.push(text);
  }
  const question = (proposal.question ?? "").trim();
  if (question && !/^abeg check am:/i.test(question) && !items.some((x) => sameCheck(x, question))) {
    items.push(question);
  }
  return items.map(escapeMd);
}

function joinBlocks(blocks) {
  return blocks.filter((b) => b && b.length > 0).join("\n\n");
}

function renderCleanCard(proposal, { existing = [], shopId = null, heardMax = MAX_HEARD_CHARS }) {
  const multi = multipleCustomers(proposal.entries);
  const entries = proposal.entries.map((e) => entryLine(e, multi)).join("\n");
  return joinBlocks([
    cardHeader(proposal, shopId),
    entries,
    owesLines(proposal, existing, shopId, " after saving").join("\n"),
    heardLine(proposal.heard, heardMax),
  ]);
}

function renderCheckCard(proposal, { heardMax = MAX_HEARD_CHARS }) {
  const multi = multipleCustomers(proposal.entries);
  const arithmetic = [...proposal.entries.map((e) => entryLine(e, multi)), ...totalsLines(proposal.totals)].join("\n");
  return joinBlocks([
    `${EMOJI.check} *Check this one*`,
    arithmetic,
    dedupeChecks(proposal).join("\n"),
    heardLine(proposal.heard, heardMax),
  ]);
}

export function waButton(id, title) {
  return { type: "reply", reply: { id, title } };
}

// Button ids and titles are part of the contract with the tap handler:
// confirm/fix/reject, Save/Fix/Reject, titles under 20 characters.
export function cardButtons(proposal, blocked) {
  if (blocked) {
    return [waButton(`fix:${proposal.id}`, "Fix"), waButton(`reject:${proposal.id}`, "Reject")];
  }
  return [
    waButton(`confirm:${proposal.id}`, "Save"),
    waButton(`fix:${proposal.id}`, "Fix"),
    waButton(`reject:${proposal.id}`, "Reject"),
  ];
}

// Full card: { text, buttons }. The heard quote shrinks first when the body
// would exceed 1024 characters; the body itself is the last resort.
export function renderProposalCard(proposal, { existing = [], shopId = null } = {}) {
  const blocked = proposal.flags.length > 0 || !!proposal.question;
  const render = (heardMax) =>
    blocked
      ? renderCheckCard(proposal, { heardMax })
      : renderCleanCard(proposal, { existing, shopId, heardMax });
  let heardMax = MAX_HEARD_CHARS;
  let text = render(heardMax);
  while (text.length > MAX_BODY_CHARS && heardMax > 0) {
    heardMax = Math.max(0, heardMax - (text.length - MAX_BODY_CHARS) - 1);
    text = render(heardMax);
  }
  if (text.length > MAX_BODY_CHARS) text = `${text.slice(0, MAX_BODY_CHARS - 1)}…`;
  return { text, buttons: cardButtons(proposal, blocked) };
}

// --- Saved reply ---------------------------------------------------------------

function savedLeg(row) {
  const amount = Number.isInteger(row.amount_kobo) ? `*${formatKobo(row.amount_kobo)}*` : "amount unknown";
  if (row.type === "payment") return `paid ${amount}`;
  const goods = describeGoods(row);
  if (row.type === "restock") return goods ? `restock ${goods} ${amount}` : `restock ${amount}`;
  if (row.type === "sale") return goods ? `sale ${goods} ${amount}` : `sale ${amount}`;
  return `${row.type} ${amount}`;
}

// "Saved", one line per customer, then each owing customer's balance.
// Recorded rows are already in the ledger, so balances read straight from it.
export function renderSavedReply({ recorded = [], existing = [] }) {
  const groups = new Map();
  for (const row of recorded) {
    const name = row.customer ?? "?";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }
  const summaries = [];
  const balances = [];
  for (const [name, rows] of groups) {
    summaries.push(`*${escapeMd(name)}*: ${rows.map(savedLeg).join(", ")}`);
    const owed = customerOwedKobo({ existing, customer: name });
    if (owed > 0) balances.push(`${EMOJI.balance} ${escapeMd(name)} owes *${formatKobo(owed)}*`);
  }
  let text = joinBlocks([`${EMOJI.saved} *Saved*`, summaries.join("\n"), balances.join("\n")]);
  if (text.length > MAX_BODY_CHARS) text = `${text.slice(0, MAX_BODY_CHARS - 1)}…`;
  return text;
}
