// WhatsApp Cloud API webhook. Text and voice notes in, proposal cards with
// Save/Fix/Reject buttons out. Reuses the voice loop directly (propose,
// confirmProposal, fixProposal, rejectProposal) with the sender's shop id.
//
// Fake data in tests. Never logs tokens, secrets, or full phone numbers:
// every log line goes through maskForLog via the context logger.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFile as cpExecFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { propose, confirmProposal, fixProposal, rejectProposal, proposeCorrectionFromText } from "./voice.mjs";
import { PhotoCheckStore, proposePhotoCheck } from "./photos.mjs";
import { AuthStore } from "./auth.mjs";
import { customerDebts, chaseForShop, lagosDay } from "./debts.mjs";
import { PromiseStore, refreshPromises, keptRate } from "./promises.mjs";
import { moneyLeakReport } from "./leak.mjs";
import { withStock } from "./products.mjs";
import { formatKobo } from "./money.mjs";
import { profitForPeriod, expensesForPeriod, lagosHour } from "./profit.mjs";
import { SummaryStore, collectDailySummary } from "./summary.mjs";
import {
  NOT_REGISTERED,
  FFMPEG_MISSING,
  AUDIO_FAILED,
  VOICE_ACK,
  FIX_ASK,
  ALREADY_SAVED,
  UNSUPPORTED,
  GENERIC_ERROR,
  UNKNOWN_BUTTON,
  PROPOSAL_NOT_FOUND,
  OTHER_SHOP,
  HEAR_FAILED,
  BAD_AUDIO_JSON,
  CORRECTION_AS_TEXT,
  FIX_LAST_HELP,
  FIX_LAST_NO_ENTRIES,
  FIX_LAST_ALREADY_FIXED,
  PHOTO_FAILED,
  FIX_PHOTO_AGAIN,
  BANK_NOTHING,
  BANK_ALREADY,
  BANK_DONE,
  DASHBOARD_LIMIT,
  dashboardCode,
  REJECTED,
  MAX_BODY_CHARS,
  alreadyConfirmedFix,
  friendlyErrorText,
  renderProposalCard,
  renderSavedReply,
  renderWhoOwes,
  renderChase,
  renderBalance,
  unknownCustomer,
  dueTodayLines,
  renderReport,
  renderStock,
  renderProfit,
  renderExpenses,
  renderPhotoSaved,
  renderDailySummary,
  SUMMARY_EMPTY_DAY,
  waButton,
} from "./messages.mjs";

export const GRAPH_VERSION = "v25.0";
const graphUrl = (path) => `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;

const defaultExecFile = promisify(cpExecFile);

export const WHATSAPP_SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shops (
  shop_id TEXT PRIMARY KEY,
  wa_number TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wa_sender_state (
  wa_number TEXT PRIMARY KEY,
  fix_proposal_id INTEGER,
  updated_at TEXT NOT NULL
);
`;

export class WhatsAppStore {
  constructor(db) {
    this.db = db;
    db.exec(WHATSAPP_SCHEMA);
  }

  // Returns true the first time a message id is seen, false on redelivery.
  claimMessage(messageId) {
    if (!messageId) return true;
    const result = this.db
      .prepare("INSERT OR IGNORE INTO processed_messages (message_id, received_at) VALUES (?, ?)")
      .run(messageId, new Date().toISOString());
    return result.changes > 0;
  }

  getOrCreateShop(digits) {
    const found = this.db.prepare("SELECT shop_id FROM shops WHERE wa_number = ?").get(digits);
    if (found) return found.shop_id;
    // Stable and opaque: derived from the number, reveals nothing in logs.
    const shopId = `wa-${createHash("sha256").update(digits).digest("hex").slice(0, 16)}`;
    this.db
      .prepare("INSERT INTO shops (shop_id, wa_number, created_at) VALUES (?, ?, ?)")
      .run(shopId, digits, new Date().toISOString());
    return shopId;
  }

  // Shop id for a sender, or null. Never creates a shop (unlike
  // getOrCreateShop), so stranger replies stay shop-free.
  findShop(digits) {
    return this.db.prepare("SELECT shop_id FROM shops WHERE wa_number = ?").get(digits)?.shop_id ?? null;
  }

  getFixState(digits) {
    return (
      this.db
        .prepare("SELECT fix_proposal_id AS fixProposalId FROM wa_sender_state WHERE wa_number = ?")
        .get(digits) ?? null
    );
  }

  setFixState(digits, proposalId) {
    this.db
      .prepare(
        `INSERT INTO wa_sender_state (wa_number, fix_proposal_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(wa_number) DO UPDATE SET fix_proposal_id = excluded.fix_proposal_id, updated_at = excluded.updated_at`
      )
      .run(digits, proposalId, new Date().toISOString());
  }

  clearFixState(digits) {
    this.db.prepare("DELETE FROM wa_sender_state WHERE wa_number = ?").run(digits);
  }
}

export function digitsOf(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export function readWhatsAppConfig(env = process.env) {
  return {
    token: env.WHATSAPP_TOKEN || null,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || null,
    appSecret: env.WHATSAPP_APP_SECRET || null,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || null,
    allowed: String(env.WHATSAPP_ALLOWED_NUMBERS ?? "")
      .split(",")
      .map(digitsOf)
      .filter(Boolean),
  };
}

// Defense in depth: secrets redacted, digit runs of 7+ masked to last 2.
// Replies to the trader are NOT masked; only log lines pass through here.
export function maskForLog(text, config) {
  let out = String(text ?? "");
  for (const secret of [config?.token, config?.appSecret, config?.verifyToken]) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.replace(/\d{7,}/g, (m) => `***${m.slice(-2)}`);
}

export function verifyWhatsAppSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || typeof signatureHeader !== "string") return false;
  const match = signatureHeader.match(/^sha256=([0-9a-fA-F]+)$/);
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(match[1].toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyWebhookSubscription(params, verifyToken) {
  if (!verifyToken) return null;
  if (params.get("hub.mode") !== "subscribe") return null;
  if (params.get("hub.verify_token") !== verifyToken) return null;
  return params.get("hub.challenge") || null;
}

export function getWhatsAppStore(deps) {
  if (deps.whatsapp) return deps.whatsapp;
  deps._waStore ??= new WhatsAppStore(deps.ledger.db);
  return deps._waStore;
}

export function getPromiseStore(deps) {
  if (deps.promises) return deps.promises;
  if (!deps.ledger) return null;
  deps._promiseStore ??= new PromiseStore(deps.ledger.db);
  return deps._promiseStore;
}

export function getPhotoCheckStore(deps) {
  if (deps.photoChecks) return deps.photoChecks;
  if (!deps.ledger) return null;
  deps._photoCheckStore ??= new PhotoCheckStore(deps.ledger.db);
  return deps._photoCheckStore;
}

export function getSummaryStore(deps) {
  if (deps.summary) return deps.summary;
  if (!deps.ledger) return null;
  deps._summaryStore ??= new SummaryStore(deps.ledger.db);
  return deps._summaryStore;
}

export function getAuthStore(deps) {
  if (deps.auths) return deps.auths;
  if (!deps.ledger) return null;
  deps._authStore ??= new AuthStore(deps.ledger.db);
  return deps._authStore;
}

export function buildWhatsAppContext(deps, env = deps.env ?? process.env) {
  const config = readWhatsAppConfig(env);
  const sink = deps.log ?? console.log;
  return {
    store: getWhatsAppStore(deps),
    ledger: deps.ledger,
    proposals: deps.proposals,
    promises: getPromiseStore(deps),
    products: deps.products ?? null,
    secondOpinions: deps.secondOpinions ?? null,
    photoChecks: getPhotoCheckStore(deps),
    summary: getSummaryStore(deps),
    auths: getAuthStore(deps),
    model: deps.model,
    nowMs: deps.nowMs ?? Date.now(),
    config,
    fetchFn: deps.fetch ?? fetch,
    log: (line) => sink(maskForLog(line, config)),
    execFileFn: deps.execFile ?? defaultExecFile,
    tmpBase: deps.waTmpDir ?? tmpdir(),
  };
}

function normCustomerName(name) {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Exact debt, stock, profit and expenses commands, matched before any model
// call: "who owes", "chase", "report", "stock", "profit", "profit week",
// "profit month", "expenses", "balance <name>", "fix last" and "dashboard"
// (case-insensitive, trailing punctuation ignored). "fix last <text>"
// carries the corrected note; bare "fix last" gets usage help. Anything
// else returns null and flows to the model as a note.
export function parseCommand(text) {
  const clean = String(text ?? "").trim().replace(/\s+/g, " ").replace(/[?!.\s]+$/, "");
  if (!clean) return null;
  const lower = clean.toLowerCase();
  if (lower === "who owes") return { name: "whoowes" };
  if (lower === "chase") return { name: "chase" };
  if (lower === "report") return { name: "report" };
  if (lower === "stock") return { name: "stock" };
  if (lower === "profit") return { name: "profit", period: "today" };
  if (lower === "profit week") return { name: "profit", period: "week" };
  if (lower === "profit month") return { name: "profit", period: "month" };
  if (lower === "expenses") return { name: "expenses", period: "today" };
  if (lower === "fix last") return { name: "fixlast" };
  if (lower === "dashboard") return { name: "dashboard" };
  if (lower === "summary on") return { name: "summary", arg: "on" };
  if (lower === "summary off") return { name: "summary", arg: "off" };
  if (lower === "summary now") return { name: "summary", arg: "now" };
  const sm = /^summary\s+(\d{1,2})\s*([ap]m)?$/.exec(lower);
  if (sm) {
    const n = Number(sm[1]);
    if ((sm[2] === undefined || sm[2] === "pm") && n >= 5 && n <= 11) return { name: "summary", arg: `hour:${n + 12}` };
    return { name: "summary", arg: "bad" };
  }
  const m = /^balance\s+(.+)$/i.exec(clean);
  if (m && m[1].trim()) return { name: "balance", arg: m[1].trim() };
  const fl = /^fix last\s+(.+)$/i.exec(clean);
  if (fl && fl[1].trim()) return { name: "fixlast", arg: fl[1].trim() };
  return null;
}

// --- Sending ---------------------------------------------------------------

async function graphSend(ctx, payload) {
  const { token, phoneNumberId } = ctx.config;
  if (!token || !phoneNumberId) {
    ctx.log("whatsapp sender not configured; skipping reply");
    return null;
  }
  const res = await ctx.fetchFn(graphUrl(`${phoneNumberId}/messages`), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    ctx.log(`whatsapp send failed ${res.status}: ${body.slice(0, 200)}`);
    return null;
  }
  return res.json().catch(() => ({}));
}

async function sendText(ctx, to, body, { timings = null } = {}) {
  if (!to) return null;
  let text = String(body);
  const extra = dueTodayBlock(ctx, ctx.store.findShop(digitsOf(to)));
  if (extra && text.length + extra.length <= MAX_BODY_CHARS) text += extra;
  const t0 = Date.now();
  const out = await graphSend(ctx, { to, type: "text", text: { body: text.slice(0, 4000) } });
  if (timings) timings.sendMs = (timings.sendMs ?? 0) + (Date.now() - t0);
  return out;
}

async function sendCard(ctx, to, proposal, shopId, { timings = null } = {}) {
  const tRender = Date.now();
  const existing = ctx.ledger && shopId ? ctx.ledger.list(shopId) : [];
  const products = ctx.products && shopId ? ctx.products.listByShop(shopId) : [];
  const { text: cardText, buttons } = renderProposalCard(proposal, { existing, shopId, products });
  if (timings) timings.renderMs = Date.now() - tRender;
  let text = cardText;
  const extra = dueTodayBlock(ctx, shopId);
  if (extra && text.length + extra.length <= MAX_BODY_CHARS) text += extra;
  const tSend = Date.now();
  const out = await graphSend(ctx, {
    to,
    type: "interactive",
    interactive: { type: "button", body: { text }, action: { buttons } },
  });
  if (timings) timings.sendMs = (timings.sendMs ?? 0) + (Date.now() - tSend);
  return out;
}

// Dev-only one-line timing report for a finished note: step durations in ms
// plus the question count. Numbers only — never message text, names or
// amounts. Silent unless POCKETOGA_TIMING=1.
function logNoteTiming(ctx, kind, timings, proposal, t0) {
  if (process.env.POCKETOGA_TIMING !== "1") return;
  const ms = (k) => timings[k] ?? 0;
  const questions = Array.isArray(proposal?.flags) ? proposal.flags.length : 0;
  ctx.log(
    `timing kind=${kind} download=${ms("downloadMs")} convert=${ms("convertMs")} ` +
      `transcribe=${ms("transcribeMs")} classify=${ms("classifyMs")} checks=${ms("checksMs")} ` +
      `second=${ms("secondMs")} render=${ms("renderMs")} send=${ms("sendMs")} ` +
      `total=${Date.now() - t0} questions=${questions}`
  );
}

// Promises due today ride on the reply to the trader's own message — never
// as a proactive send, so nothing ever leaves the 24-hour customer service
// window. Empty string when there is nothing due (or no promises store).
function dueTodayBlock(ctx, shopId) {
  if (!shopId || !ctx.promises || !ctx.ledger) return "";
  refreshPromises(ctx.promises, ctx.ledger, shopId, { now: ctx.nowMs });
  const today = lagosDay(ctx.nowMs);
  const due = ctx.promises.listOpenByShop(shopId).filter((p) => p.due_date === today);
  if (due.length === 0) return "";
  return `\n\n${dueTodayLines(due).join("\n")}`;
}

// --- Daily summary scheduler -------------------------------------------------
// Free-form text only works within 24 hours of the trader's last message;
// anything older must go through the approved template instead.
const SUMMARY_DAY_MS = 24 * 3600 * 1000;

async function sendTemplateSummary(ctx, to, template, data) {
  return graphSend(ctx, {
    to,
    type: "template",
    template: {
      name: template,
      language: { code: "en" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: data.date },
            { type: "text", text: formatKobo(data.salesKobo) },
            { type: "text", text: formatKobo(data.collectedKobo) },
            { type: "text", text: formatKobo(data.expensesKobo) },
          ],
        },
      ],
    },
  });
}

async function sendScheduledSummary(ctx, store, row, template, now, day) {
  const data = todaySummaryData(ctx, row.shop_id, now);
  store.markSent(row.shop_id, row.wa_number, day);
  if (!data) return; // quiet day still counts as handled for today
  const lastIn = Number.isInteger(row.last_inbound_at) ? row.last_inbound_at : 0;
  if (now - lastIn <= SUMMARY_DAY_MS) {
    await sendText(ctx, row.wa_number, renderDailySummary(data));
    return;
  }
  if (template) {
    await sendTemplateSummary(ctx, row.wa_number, template, data);
    return;
  }
  ctx.log("summary waiting for template");
  store.setPending(row.shop_id, row.wa_number, renderDailySummary(data), day);
}

// Once-a-minute scheduler tick (main server process only): every opted-in
// shop whose Lagos hour has come and which hasn't been served today gets one
// summary. last_sent_date makes a restart unable to double-send. The clock
// is injectable for tests.
export async function runSummaryTick(deps, { now = Date.now() } = {}) {
  const ctx = buildWhatsAppContext(deps);
  const store = ctx.summary;
  if (!ctx.ledger || !store) return;
  const template = (deps.env ?? process.env).WHATSAPP_SUMMARY_TEMPLATE ?? null;
  const day = lagosDay(now);
  const hour = Number(lagosHour(now));
  for (const row of store.listEnabled()) {
    if (row.last_sent_date === day) continue;
    if (hour < row.hour) continue;
    try {
      await sendScheduledSummary(ctx, store, row, template || null, now, day);
    } catch (err) {
      ctx.log(`summary tick failed: ${err?.message ?? err}`);
    }
  }
}

function hourLabel(hour) {
  return `${hour - 12} PM`;
}

function todaySummaryData(ctx, shopId, now) {
  const rows = ctx.ledger ? ctx.ledger.list(shopId) : [];
  if (ctx.promises && ctx.ledger) refreshPromises(ctx.promises, ctx.ledger, shopId, { now });
  return collectDailySummary({
    shopId,
    rows,
    openPromises: ctx.promises ? ctx.promises.listOpenByShop(shopId) : [],
    catalog: ctx.products ? ctx.products.listByShop(shopId) : [],
    paymentChecks: ctx.photoChecks ? ctx.photoChecks.listUnconfirmedByShop(shopId) : [],
    now,
  });
}

// Today's summary text for the logged-in shop (GET /summary/preview).
// Null on a quiet day.
export function previewSummaryText(deps, shopId, now = Date.now()) {
  return buildTodaySummary(buildWhatsAppContext(deps), shopId, now);
}

function buildTodaySummary(ctx, shopId, now) {
  const data = todaySummaryData(ctx, shopId, now);
  return data ? renderDailySummary(data) : null;
}

async function handleSummaryCommand(ctx, sender, shopId, cmd) {
  const store = ctx.summary;
  if (!store) {
    await sendText(ctx, sender, GENERIC_ERROR);
    return;
  }
  if (cmd.arg === "now") {
    await sendText(ctx, sender, buildTodaySummary(ctx, shopId, ctx.nowMs) ?? SUMMARY_EMPTY_DAY);
    return;
  }
  if (cmd.arg === "on") {
    const row = store.setEnabled(shopId, sender, true, null, ctx.nowMs);
    await sendText(ctx, sender, `Daily summary on — I'll send it around ${hourLabel(row.hour)}. Send "summary 7pm" to change the time.`);
    return;
  }
  if (cmd.arg === "off") {
    store.setEnabled(shopId, sender, false, null, ctx.nowMs);
    await sendText(ctx, sender, `Daily summary off. Send "summary on" anytime to restart it.`);
    return;
  }
  if (cmd.arg && cmd.arg.startsWith("hour:")) {
    const row = store.setEnabled(shopId, sender, true, Number(cmd.arg.slice(5)), ctx.nowMs);
    await sendText(ctx, sender, `Daily summary on — I'll send it around ${hourLabel(row.hour)}.`);
    return;
  }
  await sendText(ctx, sender, `Send "summary on", "summary off" or "summary 7pm" (5 to 11 PM).`);
}

async function handleDebtCommand(ctx, sender, shopId, cmd) {
  if (cmd.name === "summary") {
    await handleSummaryCommand(ctx, sender, shopId, cmd);
    return;
  }
  const rows = ctx.ledger.list(shopId);
  if (cmd.name === "whoowes") {
    await sendText(ctx, sender, renderWhoOwes(customerDebts(rows, { now: ctx.nowMs })));
    return;
  }
  if (cmd.name === "profit") {
    await sendText(ctx, sender, renderProfit(profitForPeriod(rows, cmd.period, { now: ctx.nowMs })));
    return;
  }
  if (cmd.name === "expenses") {
    await sendText(ctx, sender, renderExpenses(expensesForPeriod(rows, cmd.period, { now: ctx.nowMs }), cmd.period));
    return;
  }
  if (cmd.name === "dashboard") {
    await sendLoginCode(ctx, sender, shopId);
    return;
  }
  refreshPromises(ctx.promises, ctx.ledger, shopId, { now: ctx.nowMs });
  const promises = ctx.promises ? ctx.promises.listByShop(shopId) : [];
  if (cmd.name === "chase") {
    await sendText(ctx, sender, renderChase(chaseForShop(rows, promises, { now: ctx.nowMs })));
    return;
  }
  if (cmd.name === "report") {
    const paymentChecks = ctx.photoChecks ? ctx.photoChecks.listUnconfirmedByShop(shopId) : [];
    await sendText(ctx, sender, renderReport(moneyLeakReport(rows, promises, { now: ctx.nowMs, paymentChecks })));
    return;
  }
  if (cmd.name === "stock") {
    const catalog = ctx.products ? ctx.products.listByShop(shopId) : [];
    await sendText(ctx, sender, renderStock(withStock(catalog, rows)));
    return;
  }
  const want = normCustomerName(cmd.arg);
  const debts = customerDebts(rows, { now: ctx.nowMs });
  let debt = debts.find((d) => normCustomerName(d.customer) === want);
  if (!debt) {
    const prom = promises.find((p) => normCustomerName(p.customer) === want);
    if (!prom) {
      await sendText(ctx, sender, unknownCustomer(cmd.arg));
      return;
    }
    debt = { customer: prom.customer, owedKobo: 0, oldestUnpaidAgeDays: null };
  }
  await sendText(ctx, sender, renderBalance(debt, keptRate(promises, cmd.arg)));
}

// "dashboard": issues a one-time login code for this sender's shop. The
// reply carries the code; nothing here logs it (maskForLog cannot redact
// short codes, so they never reach a log line).
async function sendLoginCode(ctx, sender, shopId) {
  if (!ctx.auths) {
    await sendText(ctx, sender, GENERIC_ERROR);
    return;
  }
  const out = ctx.auths.issueCode(shopId, sender, { now: ctx.nowMs });
  if (out.limited) {
    await sendText(ctx, sender, DASHBOARD_LIMIT);
    return;
  }
  await sendText(ctx, sender, dashboardCode(out.code));
}

// "fix last <text>": the model reads the corrected note and the trader gets
// the usual proposal card with Save/Fix/Reject. Bare "fix last" explains
// the usage. Unlike the debt commands above, this one calls the model.
async function handleFixLast(ctx, sender, shopId, cmd) {
  if (!cmd.arg) {
    await sendText(ctx, sender, FIX_LAST_HELP);
    return;
  }
  let proposal;
  try {
    proposal = await proposeCorrectionFromText(shopId, null, cmd.arg, {
      proposals: ctx.proposals,
      model: ctx.model,
      ledger: ctx.ledger,
    });
  } catch (err) {
    // With no entryId only two target failures are possible: an empty shop
    // (404) or a latest entry that was already corrected (409).
    if (err && err.status === 404) {
      await sendText(ctx, sender, FIX_LAST_NO_ENTRIES);
      return;
    }
    if (err && err.status === 409) {
      await sendText(ctx, sender, FIX_LAST_ALREADY_FIXED);
      return;
    }
    throw err;
  }
  await sendCard(ctx, sender, proposal, shopId);
}

// --- Media -----------------------------------------------------------------

async function fetchMediaUrl(ctx, mediaId) {
  const res = await ctx.fetchFn(graphUrl(mediaId), {
    headers: { Authorization: `Bearer ${ctx.config.token}` },
  });
  if (!res.ok) throw new Error(`media lookup failed: ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (!data?.url) throw new Error("media lookup returned no url");
  return data.url;
}

async function downloadMedia(ctx, url) {
  const res = await ctx.fetchFn(url, {
    headers: { Authorization: `Bearer ${ctx.config.token}` },
  });
  if (!res.ok) throw new Error(`media download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Downloads the voice note immediately (links expire) and converts OGG Opus
// to 16 kHz mono WAV. Returns { converted: false } when ffmpeg is missing;
// the temp directory is always removed.
async function withWavFromMedia(ctx, mediaId, fn, timings = null) {
  const tDownload = Date.now();
  const url = await fetchMediaUrl(ctx, mediaId);
  const bytes = await downloadMedia(ctx, url);
  if (timings) timings.downloadMs = Date.now() - tDownload;
  const dir = mkdtempSync(join(ctx.tmpBase, "wa-audio-"));
  try {
    const oggPath = join(dir, "note.ogg");
    const wavPath = join(dir, "note.wav");
    writeFileSync(oggPath, bytes);
    const tConvert = Date.now();
    try {
      await ctx.execFileFn("ffmpeg", ["-y", "-i", oggPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]);
    } catch (err) {
      if (err && err.code === "ENOENT") return { converted: false };
      throw err;
    }
    if (timings) timings.convertMs = Date.now() - tConvert;
    return { converted: true, result: await fn(wavPath) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Incoming ----------------------------------------------------------------

async function replyFriendly(ctx, to, fn) {
  try {
    await fn();
  } catch (err) {
    if (!(err && typeof err.status === "number")) ctx.log(`request failed: ${err?.message ?? err}`);
    await sendText(ctx, to, friendlyErrorText(err));
  }
}

function proposalPhotoCheck(row) {
  try {
    return JSON.parse(row.entries_json)?.photoCheck ?? null;
  } catch {
    return null;
  }
}

function recordedCheckId(row) {
  try {
    const recorded = row.recorded_ids ? JSON.parse(row.recorded_ids) : null;
    return Number.isInteger(recorded?.paymentCheckId) ? recorded.paymentCheckId : null;
  } catch {
    return null;
  }
}

async function handleButtonReply(ctx, sender, shopId, reply) {
  const match = /^(\w+):(\d+)$/.exec(reply?.id ?? "");
  const action = match?.[1];
  if (!match || !["confirm", "fix", "reject", "bank"].includes(action)) {
    await sendText(ctx, sender, UNKNOWN_BUTTON);
    return;
  }
  const proposalId = Number(match[2]);
  const row = ctx.proposals.get(proposalId);
  if (!row) {
    await sendText(ctx, sender, PROPOSAL_NOT_FOUND);
    return;
  }
  if (row.shop_id !== shopId) {
    await sendText(ctx, sender, OTHER_SHOP);
    return;
  }
  if (action === "bank") {
    const checkId = row.status === "confirmed" ? recordedCheckId(row) : null;
    const check = checkId !== null && ctx.photoChecks ? ctx.photoChecks.get(checkId) : null;
    if (!check || check.shop_id !== shopId) {
      await sendText(ctx, sender, BANK_NOTHING);
      return;
    }
    if (check.check_status === "confirmed") {
      await sendText(ctx, sender, BANK_ALREADY);
      return;
    }
    ctx.photoChecks.markSeen(check.id);
    await sendText(ctx, sender, BANK_DONE);
    return;
  }
  if (action === "fix") {
    if (proposalPhotoCheck(row)) {
      await sendText(ctx, sender, FIX_PHOTO_AGAIN);
      return;
    }
    if (row.status === "confirmed") {
      await sendText(ctx, sender, alreadyConfirmedFix(proposalId));
      return;
    }
    ctx.store.setFixState(sender, proposalId);
    await sendText(ctx, sender, FIX_ASK);
    return;
  }
  await replyFriendly(ctx, sender, async () => {
    if (action === "confirm") {
      const out = confirmProposal(proposalId, shopId, { proposals: ctx.proposals, ledger: ctx.ledger, promises: ctx.promises, products: ctx.products, photoChecks: ctx.photoChecks });
      ctx.store.clearFixState(sender);
      if (out.alreadyConfirmed) {
        await sendText(ctx, sender, ALREADY_SAVED);
        return;
      }
      if (out.proposal.photoCheck) {
        const fields = out.proposal.photoCheck.fields;
        await sendPhotoSaved(ctx, sender, out.proposal.id, { amountKobo: fields.amountKobo, sender: fields.sender });
        return;
      }
      const recorded = out.recordedIds.map((id) => ctx.ledger.get(id));
      await sendText(ctx, sender, renderSavedReply({ recorded, existing: ctx.ledger.list(shopId) }));
    } else {
      rejectProposal(proposalId, shopId, { proposals: ctx.proposals });
      ctx.store.clearFixState(sender);
      await sendText(ctx, sender, REJECTED);
    }
  });
}

// Saved photo check: the transfer stays unconfirmed until the trader taps
// the bank button below. One button only — WhatsApp allows three per card
// and this card needs just the one.
async function sendPhotoSaved(ctx, to, proposalId, { amountKobo, sender }) {
  const text = renderPhotoSaved({ amountKobo, sender });
  return graphSend(ctx, {
    to,
    type: "interactive",
    interactive: { type: "button", body: { text }, action: { buttons: [waButton(`bank:${proposalId}`, "I saw it in my bank")] } },
  });
}

async function handleFixError(ctx, sender, err) {
  // Terminal proposal states clear the pending fix; anything else keeps it
  // so the trader can send the correction again.
  if (err && [404, 409, 410].includes(err.status)) ctx.store.clearFixState(sender);
  if (!(err && typeof err.status === "number")) ctx.log(`fix failed: ${err?.message ?? err}`);
  await sendText(ctx, sender, friendlyErrorText(err));
}

async function handleCorrection(ctx, sender, shopId, fixProposalId, message) {
  if (message?.type === "text") {
    const t0 = Date.now();
    const timings = {};
    try {
      const revised = await fixProposal(fixProposalId, shopId, message.text?.body ?? "", {
        proposals: ctx.proposals,
        model: ctx.model,
        ledger: ctx.ledger,
        products: ctx.products,
        timings,
      });
      ctx.store.clearFixState(sender);
      await sendCard(ctx, sender, revised, shopId, { timings });
      logNoteTiming(ctx, "text-fix", timings, revised, t0);
    } catch (err) {
      await handleFixError(ctx, sender, err);
    }
    return;
  }
  if (message?.type === "audio") {
    const mediaId = message.audio?.id;
    if (!mediaId) {
      await sendText(ctx, sender, AUDIO_FAILED);
      return;
    }
    const t0 = Date.now();
    const timings = {};
    let data;
    try {
      const got = await withWavFromMedia(ctx, mediaId, async (wavPath) => readFileSync(wavPath).toString("base64"), timings);
      if (!got.converted) {
        await sendText(ctx, sender, FFMPEG_MISSING);
        return;
      }
      data = got.result;
    } catch (err) {
      ctx.log(`voice correction download failed: ${err?.message ?? err}`);
      await sendText(ctx, sender, AUDIO_FAILED);
      return;
    }
    let heard;
    try {
      await sendText(ctx, sender, VOICE_ACK, { timings });
      const tTranscribe = Date.now();
      const raw = await ctx.model.complete({ audio: { data, format: "wav" } });
      timings.transcribeMs = Date.now() - tTranscribe;
      heard = typeof raw?.heard === "string" && raw.heard.trim() ? raw.heard.trim() : null;
      if (!heard) {
        await sendText(ctx, sender, HEAR_FAILED);
        return;
      }
    } catch (err) {
      if (err && err.code === "MODEL_BAD_JSON") {
        await sendText(ctx, sender, BAD_AUDIO_JSON);
        return;
      }
      ctx.log(`voice correction failed: ${err?.message ?? err}`);
      await sendText(ctx, sender, GENERIC_ERROR);
      return;
    }
    try {
      const revised = await fixProposal(fixProposalId, shopId, heard, { proposals: ctx.proposals, model: ctx.model, ledger: ctx.ledger, products: ctx.products, timings });
      ctx.store.clearFixState(sender);
      await sendCard(ctx, sender, revised, shopId, { timings });
      logNoteTiming(ctx, "audio-fix", timings, revised, t0);
    } catch (err) {
      await handleFixError(ctx, sender, err);
    }
    return;
  }
  await sendText(ctx, sender, CORRECTION_AS_TEXT);
}

async function handleIncomingMessage(message, ctx) {
  const id = message?.id;
  if (id && !ctx.store.claimMessage(id)) {
    ctx.log(`duplicate delivery ${id} ignored`);
    return;
  }
  const sender = digitsOf(message?.from);
  if (!sender) {
    ctx.log("message without sender ignored");
    return;
  }
  ctx.log(`incoming ${message?.type ?? "?"} from ${sender}`);
  if (!ctx.config.allowed.includes(sender)) {
    await sendText(ctx, sender, NOT_REGISTERED);
    ctx.log(`unregistered sender ${sender} replied once`);
    return;
  }
  const shopId = ctx.store.getOrCreateShop(sender);
  if (ctx.summary) {
    ctx.summary.touchInbound(shopId, sender, ctx.nowMs);
    const pending = ctx.summary.takePending(shopId, sender);
    if (pending) {
      try {
        await sendText(ctx, sender, `Your summary from last evening:\n${pending.text}`);
      } catch (err) {
        ctx.log(`pending summary failed: ${err?.message ?? err}`);
        ctx.summary.setPending(shopId, sender, pending.text, pending.date);
      }
    }
  }
  // Reply-button taps arrive as type "interactive" with the tapped id in
  // interactive.button_reply.id. Other interactive types (e.g. list replies,
  // which our cards never send) fall through to the text/audio handling.
  if (message?.type === "interactive" && message.interactive?.type === "button_reply") {
    await handleButtonReply(ctx, sender, shopId, message.interactive.button_reply);
    return;
  }
  const state = ctx.store.getFixState(sender);
  if (state?.fixProposalId) {
    await handleCorrection(ctx, sender, shopId, state.fixProposalId, message);
    return;
  }
  // Exact debt commands run before any model call and never touch the model.
  // "fix last" is matched here too but runs separately: it needs the model
  // to read the corrected note.
  if (message?.type === "text") {
    const cmd = parseCommand(message.text?.body ?? "");
    if (cmd && cmd.name === "fixlast") {
      await replyFriendly(ctx, sender, () => handleFixLast(ctx, sender, shopId, cmd));
      return;
    }
    if (cmd) {
      await replyFriendly(ctx, sender, () => handleDebtCommand(ctx, sender, shopId, cmd));
      return;
    }
  }
  await replyFriendly(ctx, sender, async () => {
    if (message?.type === "text") {
      const t0 = Date.now();
      const timings = {};
      const proposal = await propose(shopId, message.text?.body ?? "", {
        proposals: ctx.proposals,
        model: ctx.model,
        ledger: ctx.ledger,
        products: ctx.products,
        secondOpinions: ctx.secondOpinions,
        timings,
      });
      await sendCard(ctx, sender, proposal, shopId, { timings });
      logNoteTiming(ctx, "text", timings, proposal, t0);
    } else if (message?.type === "audio") {
      const mediaId = message.audio?.id;
      if (!mediaId) {
        await sendText(ctx, sender, AUDIO_FAILED);
        return;
      }
      const t0 = Date.now();
      const timings = {};
      let got;
      try {
        got = await withWavFromMedia(ctx, mediaId, async (wavPath) => {
          // The audio is in hand and the slow part (transcription +
          // classification) starts now: say so before it, not after.
          await sendText(ctx, sender, VOICE_ACK, { timings });
          return propose(shopId, { audioPath: wavPath }, { proposals: ctx.proposals, model: ctx.model, ledger: ctx.ledger, products: ctx.products, secondOpinions: ctx.secondOpinions, timings });
        }, timings);
      } catch (err) {
        ctx.log(`audio download failed: ${err?.message ?? err}`);
        await sendText(ctx, sender, AUDIO_FAILED);
        return;
      }
      if (!got.converted) {
        await sendText(ctx, sender, FFMPEG_MISSING);
        return;
      }
      await sendCard(ctx, sender, got.result, shopId, { timings });
      logNoteTiming(ctx, "audio", timings, got.result, t0);
    } else if (message?.type === "image") {
      const mediaId = message.image?.id;
      const mime = message.image?.mime_type;
      const photoFormat = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpeg" : null;
      if (!mediaId || !photoFormat) {
        await sendText(ctx, sender, PHOTO_FAILED);
        return;
      }
      let bytes;
      try {
        bytes = await downloadMedia(ctx, await fetchMediaUrl(ctx, mediaId));
      } catch (err) {
        ctx.log(`photo download failed: ${err?.message ?? err}`);
        await sendText(ctx, sender, PHOTO_FAILED);
        return;
      }
      const proposal = await proposePhotoCheck(
        shopId,
        { photoBase64: bytes.toString("base64"), photoFormat },
        { proposals: ctx.proposals, model: ctx.model, ledger: ctx.ledger, photoChecks: ctx.photoChecks, now: ctx.nowMs }
      );
      await sendCard(ctx, sender, proposal, shopId);
    } else {
      await sendText(ctx, sender, UNSUPPORTED);
    }
  });
}

export async function processWhatsAppPayload(payload, ctx) {
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const message of change?.value?.messages ?? []) {
        try {
          await handleIncomingMessage(message, ctx);
        } catch (err) {
          ctx.log(`message ${message?.id ?? "?"} failed: ${err?.message ?? err}`);
        }
      }
    }
  }
}

// Jobs tracked so the route can answer 200 first and tests can drain them.
const pendingJobs = new Set();

export function trackWhatsAppJob(promise) {
  pendingJobs.add(promise);
  promise.then(
    () => pendingJobs.delete(promise),
    () => pendingJobs.delete(promise)
  );
  return promise;
}

export async function drainWhatsAppJobs() {
  while (pendingJobs.size > 0) await Promise.allSettled([...pendingJobs]);
}
