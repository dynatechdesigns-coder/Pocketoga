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
import { propose, confirmProposal, fixProposal, rejectProposal } from "./voice.mjs";
import { formatKobo } from "./money.mjs";

export const GRAPH_VERSION = "v25.0";
const graphUrl = (path) => `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;

const defaultExecFile = promisify(cpExecFile);

const NOT_REGISTERED = "Sorry, this number is not registered on PocketOga. Ask your shop owner to register it first.";
const FFMPEG_MISSING = "Sorry, I can't listen to voice notes right now. Please send it as text.";
const AUDIO_FAILED = "Sorry, I couldn't process that voice note. Please send it as text.";
const FIX_ASK = "What should I change? Send the correction as text or a voice note.";

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

export function buildWhatsAppContext(deps, env = deps.env ?? process.env) {
  const config = readWhatsAppConfig(env);
  const sink = deps.log ?? console.log;
  return {
    store: getWhatsAppStore(deps),
    ledger: deps.ledger,
    proposals: deps.proposals,
    model: deps.model,
    config,
    fetchFn: deps.fetch ?? fetch,
    log: (line) => sink(maskForLog(line, config)),
    execFileFn: deps.execFile ?? defaultExecFile,
    tmpBase: deps.waTmpDir ?? tmpdir(),
  };
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

async function sendText(ctx, to, body) {
  if (!to) return null;
  return graphSend(ctx, { to, type: "text", text: { body: String(body).slice(0, 4000) } });
}

function waButton(id, title) {
  return { type: "reply", reply: { id, title } };
}

function renderEntryLine(index, e) {
  const parts = [`${index + 1}. ${e.type}`, e.customer ?? "?"];
  if (e.item) parts.push(e.quantity ? `${e.item} x${e.quantity}${e.unit ? ` ${e.unit}` : ""}` : e.item);
  else if (e.quantity) parts.push(`x${e.quantity}`);
  parts.push(e.amountKobo == null ? "amount unknown" : formatKobo(e.amountKobo));
  const line = parts.filter(Boolean).join(" — ");
  return e.eachKobo != null ? `${line} (${formatKobo(e.eachKobo)} each)` : line;
}

function renderTotalsLine(totals) {
  if (!totals) return null;
  const legs = [];
  if (totals.totalKobo != null) legs.push(`Total ${formatKobo(totals.totalKobo)}`);
  if (totals.paidKobo != null) legs.push(`paid ${formatKobo(totals.paidKobo)}`);
  if (totals.remainderKobo != null) legs.push(`remainder ${formatKobo(totals.remainderKobo)}`);
  return legs.length ? legs.join(", ") : null;
}

// Card for a proposal: what was heard, entries with naira amounts, flags or
// the clarifying question. A pending question/flag means no Save button.
export function renderProposalCard(proposal) {
  const lines = [`Heard: ${proposal.heard}`];
  proposal.entries.forEach((e, i) => lines.push(renderEntryLine(i, e)));
  const totals = renderTotalsLine(proposal.totals);
  if (totals) lines.push(totals);
  if (proposal.flags.length) lines.push(`⚠ ${proposal.flags.join("; ")}`);
  if (proposal.question) lines.push(`❓ ${proposal.question}`);
  let text = lines.join("\n");
  if (text.length > 900) text = `${text.slice(0, 897)}...`;
  const blocked = proposal.flags.length > 0 || !!proposal.question;
  const buttons = blocked
    ? [waButton(`fix:${proposal.id}`, "Fix"), waButton(`reject:${proposal.id}`, "Reject")]
    : [
        waButton(`confirm:${proposal.id}`, "Save"),
        waButton(`fix:${proposal.id}`, "Fix"),
        waButton(`reject:${proposal.id}`, "Reject"),
      ];
  return { text, buttons };
}

async function sendCard(ctx, to, proposal) {
  const { text, buttons } = renderProposalCard(proposal);
  return graphSend(ctx, {
    to,
    type: "interactive",
    interactive: { type: "button", body: { text }, action: { buttons } },
  });
}

function summarizeRecorded(ctx, recordedIds) {
  return recordedIds
    .map((id) => {
      const row = ctx.ledger.get(id);
      return `${row.type} ${formatKobo(row.amount_kobo)} (${row.customer})`;
    })
    .join(" + ");
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
async function withWavFromMedia(ctx, mediaId, fn) {
  const url = await fetchMediaUrl(ctx, mediaId);
  const bytes = await downloadMedia(ctx, url);
  const dir = mkdtempSync(join(ctx.tmpBase, "wa-audio-"));
  try {
    const oggPath = join(dir, "note.ogg");
    const wavPath = join(dir, "note.wav");
    writeFileSync(oggPath, bytes);
    try {
      await ctx.execFileFn("ffmpeg", ["-y", "-i", oggPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]);
    } catch (err) {
      if (err && err.code === "ENOENT") return { converted: false };
      throw err;
    }
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
    if (err && typeof err.status === "number") {
      await sendText(ctx, to, err.message);
      return;
    }
    ctx.log(`request failed: ${err?.message ?? err}`);
    await sendText(ctx, to, "Sorry, something went wrong. Please try again.");
  }
}

async function handleButtonReply(ctx, sender, shopId, reply) {
  const match = /^(\w+):(\d+)$/.exec(reply?.id ?? "");
  const action = match?.[1];
  if (!match || !["confirm", "fix", "reject"].includes(action)) {
    await sendText(ctx, sender, "I didn't understand that button. Send your note again.");
    return;
  }
  const proposalId = Number(match[2]);
  const row = ctx.proposals.get(proposalId);
  if (!row) {
    await sendText(ctx, sender, "I can't find that proposal. Send your note again.");
    return;
  }
  if (row.shop_id !== shopId) {
    await sendText(ctx, sender, "That proposal belongs to another shop.");
    return;
  }
  if (action === "fix") {
    if (row.status === "confirmed") {
      await sendText(ctx, sender, `Proposal ${proposalId} is already confirmed; send a new note to correct it.`);
      return;
    }
    ctx.store.setFixState(sender, proposalId);
    await sendText(ctx, sender, FIX_ASK);
    return;
  }
  await replyFriendly(ctx, sender, async () => {
    if (action === "confirm") {
      const out = confirmProposal(proposalId, shopId, { proposals: ctx.proposals, ledger: ctx.ledger });
      ctx.store.clearFixState(sender);
      if (out.alreadyConfirmed) {
        await sendText(ctx, sender, "Already saved — recorded once.");
        return;
      }
      await sendText(ctx, sender, `Saved: ${summarizeRecorded(ctx, out.recordedIds)}.`);
    } else {
      rejectProposal(proposalId, shopId, { proposals: ctx.proposals });
      ctx.store.clearFixState(sender);
      await sendText(ctx, sender, "Discarded — nothing was saved.");
    }
  });
}

async function handleFixError(ctx, sender, err) {
  // Terminal proposal states clear the pending fix; anything else keeps it
  // so the trader can send the correction again.
  if (err && [404, 409, 410].includes(err.status)) ctx.store.clearFixState(sender);
  if (err && typeof err.status === "number") {
    await sendText(ctx, sender, err.message);
    return;
  }
  ctx.log(`fix failed: ${err?.message ?? err}`);
  await sendText(ctx, sender, "Sorry, something went wrong. Please try again.");
}

async function handleCorrection(ctx, sender, shopId, fixProposalId, message) {
  if (message?.type === "text") {
    try {
      const revised = await fixProposal(fixProposalId, shopId, message.text?.body ?? "", {
        proposals: ctx.proposals,
        model: ctx.model,
      });
      ctx.store.clearFixState(sender);
      await sendCard(ctx, sender, revised);
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
    let data;
    try {
      const got = await withWavFromMedia(ctx, mediaId, async (wavPath) => readFileSync(wavPath).toString("base64"));
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
      const raw = await ctx.model.complete({ audio: { data, format: "wav" } });
      heard = typeof raw?.heard === "string" && raw.heard.trim() ? raw.heard.trim() : null;
      if (!heard) {
        await sendText(ctx, sender, "I couldn't hear that — please send the correction again.");
        return;
      }
    } catch (err) {
      if (err && err.code === "MODEL_BAD_JSON") {
        await sendText(ctx, sender, "I no hear am well — abeg talk am again.");
        return;
      }
      ctx.log(`voice correction failed: ${err?.message ?? err}`);
      await sendText(ctx, sender, "Sorry, something went wrong. Please try again.");
      return;
    }
    try {
      const revised = await fixProposal(fixProposalId, shopId, heard, { proposals: ctx.proposals, model: ctx.model });
      ctx.store.clearFixState(sender);
      await sendCard(ctx, sender, revised);
    } catch (err) {
      await handleFixError(ctx, sender, err);
    }
    return;
  }
  await sendText(ctx, sender, "Please send the correction as text or a voice note.");
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
  await replyFriendly(ctx, sender, async () => {
    if (message?.type === "text") {
      const proposal = await propose(shopId, message.text?.body ?? "", {
        proposals: ctx.proposals,
        model: ctx.model,
      });
      await sendCard(ctx, sender, proposal);
    } else if (message?.type === "audio") {
      const mediaId = message.audio?.id;
      if (!mediaId) {
        await sendText(ctx, sender, AUDIO_FAILED);
        return;
      }
      let got;
      try {
        got = await withWavFromMedia(ctx, mediaId, async (wavPath) =>
          propose(shopId, { audioPath: wavPath }, { proposals: ctx.proposals, model: ctx.model })
        );
      } catch (err) {
        ctx.log(`audio download failed: ${err?.message ?? err}`);
        await sendText(ctx, sender, AUDIO_FAILED);
        return;
      }
      if (!got.converted) {
        await sendText(ctx, sender, FFMPEG_MISSING);
        return;
      }
      await sendCard(ctx, sender, got.result);
    } else {
      await sendText(ctx, sender, "I can only read text and voice notes for now.");
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
