// Every user-facing WhatsApp string and builder in one place. Presentation
// only: no checks, no parsing, no state. whatsapp.mjs owns all logic and
// calls in here to render replies.
//
// Conventions: WhatsApp *bold* / _italic_, short lines, blank lines between
// blocks. Only these emojis: sale, payment, restock, needs-checking,
// saved, balance, promise (see EMOJI). Amounts via formatKobo: naira sign with
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
  promise: "🤝",
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
  const mismatch = (proposal.flags ?? []).find((f) => String(f).startsWith(MISMATCH_PREFIX));
  const line = mismatch ? mismatchLine(mismatch) : null;
  const items = [];
  let inserted = false;
  for (const flag of proposal.flags ?? []) {
    const text = String(flag);
    if (line && text.startsWith(MISMATCH_PREFIX)) {
      if (!inserted) {
        items.push(line);
        inserted = true;
      }
      continue;
    }
    if (line && /^needs clarification:\s*/i.test(text)) continue;
    const stripped = text.replace(/^needs clarification:\s*/i, "");
    if (!items.some((x) => sameCheck(x, stripped))) items.push(stripped);
  }
  if (line && !inserted) items.push(line);
  const question = (proposal.question ?? "").trim();
  if (!line && question && !/^abeg check am:/i.test(question) && !items.some((x) => sameCheck(x, question))) {
    items.push(question);
  }
  return items.map(renderCheckLine);
}

// Code-built remainder-mismatch flags ("numbers do not add up: ...") are
// restated as one Pidgin-friendly line from the labelled numbers, and the
// model's own question about the same mismatch is suppressed, so the card
// asks once. Anything else on the card is untouched.
const MISMATCH_PREFIX = "numbers do not add up";

function parseKoboAmount(text) {
  const m = /^₦([\d,]+)(\.\d{2})?$/.exec(text);
  if (!m) return null;
  const naira = Number(m[1].replace(/,/g, ""));
  if (!Number.isInteger(naira)) return null;
  return naira * 100 + (m[2] ? Number(m[2].slice(1)) : 0);
}

function labeledKobo(flag, label) {
  const m = new RegExp(`${label} (₦[\\d,]+(?:\\.\\d{2})?)`).exec(String(flag));
  return m ? parseKoboAmount(m[1]) : null;
}

// "₦30,000 − ₦10,000 = ₦20,000, but you said ₦5,000 remain. Which one na
// correct?" Null when the flag has no readable labelled numbers, in which
// case the card keeps the old rendering.
function mismatchLine(flag) {
  const total = labeledKobo(flag, "(?:total|sales)");
  const paid = labeledKobo(flag, "paid");
  const stated = labeledKobo(flag, "remainder");
  if (total === null || paid === null || stated === null) return null;
  return `${formatKobo(total)} − ${formatKobo(paid)} = ${formatKobo(total - paid)}, but you said ${formatKobo(stated)} remain. Which one na correct?`;
}

// Similar-name flags carry code-added *bold* around the two names. The names
// are escaped again here (idempotent for code-built flags) so a forged shape
// with raw markdown still cannot break card formatting.
const SAME_PERSON_RE = /^Is \*(.+?)\* the same person as \*(.+?)\*\? Send the right name, or say new customer\.$/;

function renderCheckLine(text) {
  const match = SAME_PERSON_RE.exec(text);
  if (match) {
    return `Is *${escapeMd(match[1])}* the same person as *${escapeMd(match[2])}*? Send the right name, or say new customer.`;
  }
  return escapeMd(text);
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
    promiseCardLine(proposal.promise),
    owesLines(proposal, existing, shopId, " after saving").join("\n"),
    heardLine(proposal.heard, heardMax),
  ]);
}

function renderCheckCard(proposal, { heardMax = MAX_HEARD_CHARS }) {
  const multi = multipleCustomers(proposal.entries);
  const arithmetic = [...proposal.entries.map((e) => entryLine(e, multi)), ...totalsLines(proposal.totals), promiseCardLine(proposal.promise)]
    .filter(Boolean)
    .join("\n");
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

// --- Debts and promises ------------------------------------------------------
// Only these emojis: balance, promise, checks. Every reply is capped at
// MAX_BODY_CHARS so no debt message can overflow WhatsApp limits.

function fitBody(text) {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS - 1)}…` : text;
}

function ageText(ageDays) {
  if (!Number.isInteger(ageDays) || ageDays <= 0) return "today";
  return ageDays === 1 ? "1 day old" : `${ageDays} days old`;
}

function brokenText(broken) {
  if (!Number.isInteger(broken) || broken <= 0) return null;
  return broken === 1 ? "1 broken promise" : `${broken} broken promises`;
}

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-10-30" -> "Fri 30 Oct". A pure calendar date: no timezone involved.
export function formatDueDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ""));
  if (!m) return "date unknown";
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(dt.getTime())) return "date unknown";
  return `${DOW_SHORT[dt.getUTCDay()]} ${dt.getUTCDate()} ${MONTH_SHORT[dt.getUTCMonth()]}`;
}

// " Ada to pay ₦20,000 by Fri 30 Oct". Null when there is no promise.
export function promiseCardLine(promise) {
  if (!promise) return null;
  const name = escapeMd(String(promise.customer ?? "?").trim() || "?");
  const amount = Number.isInteger(promise.amountKobo) ? ` to pay ${formatKobo(promise.amountKobo)}` : " to pay";
  return `${EMOJI.promise} ${name}${amount} by ${formatDueDay(promise.dueDate)}`;
}

export function renderWhoOwes(debts) {
  const owing = (debts ?? [])
    .filter((d) => Number.isInteger(d.owedKobo) && d.owedKobo > 0)
    .sort((a, b) => b.owedKobo - a.owedKobo);
  if (owing.length === 0) return `${EMOJI.balance} *Who owes*\n\nNobody owes you anything.`;
  const lines = owing
    .slice(0, 10)
    .map((d) => `${escapeMd(d.customer)} owes *${formatKobo(d.owedKobo)}* (${ageText(d.oldestUnpaidAgeDays)})`);
  if (owing.length > 10) lines.push(`…and ${owing.length - 10} more.`);
  return fitBody(`${EMOJI.balance} *Who owes*\n${lines.join("\n")}`);
}

// Fixed reminder templates in the trader's own voice. Values only — the
// ranking and numbers always come from code.
const REMINDER_TEMPLATES = {
  friendly: (name, amount, age) =>
    `Hello ${name}, trust you are well. This is a friendly reminder that your balance of ${amount} (${age}) is still open. Please pay soon. Thank you!`,
  firm: (name, amount, age) =>
    `Hello ${name}, your balance of ${amount} (${age}) is still unpaid. Please pay it today. Thank you.`,
  final: (name, amount, age) =>
    `${name}, final reminder: pay your ${amount} balance (${age}) today, or I will take further steps.`,
};

export function draftReminder(tone, { name, amountKobo, ageDays } = {}) {
  const template = REMINDER_TEMPLATES[tone];
  if (!template) throw new Error(`unknown reminder tone: ${String(tone)}`);
  const amount = Number.isInteger(amountKobo) ? formatKobo(amountKobo) : "amount unknown";
  const age =
    !Number.isInteger(ageDays) || ageDays <= 0 ? "from today" : ageDays === 1 ? "1 day old" : `${ageDays} days old`;
  return template(escapeMd(name), amount, age);
}

export function renderChase(ranked) {
  const top = (ranked ?? []).filter((r) => Number.isInteger(r.owedKobo) && r.owedKobo > 0).slice(0, 5);
  if (top.length === 0) return `${EMOJI.check} *Chase list*\n\nNobody owes you anything.`;
  const lines = top.map((r, i) => {
    const note = [ageText(r.ageDays), brokenText(r.broken)].filter(Boolean).join(", ");
    return `${i + 1}. ${escapeMd(r.customer)}: *${formatKobo(r.owedKobo)}* (${note})`;
  });
  const first = top[0];
  const drafts = ["friendly", "firm", "final"]
    .map((tone) => {
      const label = tone[0].toUpperCase() + tone.slice(1);
      return `${EMOJI.promise} ${label}: ${draftReminder(tone, { name: first.customer, amountKobo: first.owedKobo, ageDays: first.ageDays })}`;
    })
    .join("\n");
  return fitBody(`${EMOJI.check} *Chase list*\n${lines.join("\n")}\n\n${drafts}`);
}

export function renderBalance(debt, rate) {
  const name = escapeMd(debt.customer);
  const first =
    debt.owedKobo > 0
      ? `${EMOJI.balance} ${name} owes *${formatKobo(debt.owedKobo)}* (${ageText(debt.oldestUnpaidAgeDays)})`
      : `${EMOJI.balance} ${name} owes nothing.`;
  const second = rate ? `Promises kept: ${rate.kept} of ${rate.total} (${Math.round(rate.rate * 100)}%)` : "No promises yet.";
  return fitBody(`${first}\n${second}`);
}

export function unknownCustomer(name) {
  const clean = String(name ?? "").trim();
  return fitBody(`Sorry, I have no record for "${escapeMd(clean || "?")}". Check the spelling and try again.`);
}

// Money check: one block per non-zero leak category, top 3 per list with
// "+N more". Categories stay separate; they are never totalled. The header
// carries a warning only when something needs attention, and no emoji
// appears twice: balance, promise, restock, payment each own one block.
export function renderReport(report) {
  const lines = [];
  let attention = false;
  const owed = report?.owed;
  if (owed && owed.totalKobo > 0) {
    attention = true;
    let line = `${EMOJI.balance} Owed *${formatKobo(owed.totalKobo)}* (${owed.customers} customer${owed.customers === 1 ? "" : "s"})`;
    if (report?.overdue && report.overdue.amountKobo > 0) {
      line += `, *${formatKobo(report.overdue.amountKobo)}* over 30 days`;
    }
    lines.push(line);
  }
  const broken = report?.broken;
  if (broken && broken.count > 0) {
    attention = true;
    let line = `${EMOJI.promise} ${broken.count} broken promise${broken.count === 1 ? "" : "s"}`;
    if (broken.amountKobo > 0) line += ` (*${formatKobo(broken.amountKobo)}* at risk)`;
    lines.push(line);
  }
  const shortfalls = report?.shortfalls ?? [];
  if (shortfalls.length > 0) {
    attention = true;
    lines.push(`${EMOJI.restock} Sold more than bought:`);
    for (const s of shortfalls.slice(0, 3)) lines.push(`${escapeMd(s.display)}: short ${s.shortfallQty}`);
    if (shortfalls.length > 3) lines.push(`+${shortfalls.length - 3} more`);
  }
  const noStockRecord = report?.noStockRecord ?? 0;
  if (noStockRecord > 0) {
    lines.push(`No stock record for ${noStockRecord} item${noStockRecord === 1 ? "" : "s"}.`);
  }
  const below = report?.belowCost?.items ?? [];
  if (below.length > 0) {
    attention = true;
    lines.push(`${EMOJI.payment} Margin lost on below-cost sales:`);
    for (const f of below.slice(0, 3)) lines.push(`${escapeMd(f.display)}: *${formatKobo(f.marginKobo)}*`);
    if (below.length > 3) lines.push(`+${below.length - 3} more`);
  }
  const header = attention ? `${EMOJI.check} *Money check*` : "*Money check*";
  if (!attention) lines.push("Nothing alarming yet.");
  const gap = attention ? "\n" : "\n\n";
  return fitBody(`${header}${gap}${lines.join("\n")}`);
}

// One line per promise due today, capped at five plus an overflow line.
export function dueTodayLines(promises) {
  const rows = promises ?? [];
  const lines = rows.slice(0, 5).map((p) => {
    const amount = Number.isInteger(p.amount_kobo) ? ` promised ${formatKobo(p.amount_kobo)}` : " promised to pay";
    return `${EMOJI.promise} Due today: ${escapeMd(p.customer)}${amount}`;
  });
  if (rows.length > lines.length) lines.push(`…and ${rows.length - lines.length} more due today.`);
  return lines;
}
