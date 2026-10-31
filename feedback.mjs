// Trader feedback inbox: typed or voice notes about the app itself (never
// ledger data). POST /feedback validates the body in plain code, transcribes
// audio with the same model call as a voice note, stores the row and answers
// 201. Rate limit: 5 per hour per IP and per shop (429 past that).
// Fake data only in tests; the mock model client stands in for the network.
import { DatabaseSync } from "node:sqlite";
import { logLine } from "./log.mjs";

// Field names are the API contract: type, rating, text, audio (audioBase64,
// audioFormat — the same fields as the POST /propose voice note). Never
// rename them: the web app and WhatsApp flows send exactly these.
export const FEEDBACK_TYPES = ["suggestion", "problem", "review"];
export const FEEDBACK_TEXT_MAX = 1000;
// Voice feedback must fit in one short note.
export const FEEDBACK_AUDIO_MAX_SECONDS = 45;
// Hourly budget, tracked separately per IP and per shop.
export const FEEDBACK_RATE_LIMIT = 5;
export const FEEDBACK_WINDOW_MS = 60 * 60 * 1000;
const AUDIO_FORMATS = ["wav", "mp3"];

export const FEEDBACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  type TEXT NOT NULL,
  rating INTEGER,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback_attempts (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_attempts_kind_key ON feedback_attempts(kind, key);
`;

export function feedbackError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Optional owner inbox: after a row is stored, the same feedback is POSTed
// as JSON to FEEDBACK_WEBHOOK_URL with the shared FEEDBACK_WEBHOOK_SECRET
// in the body ({ secret, type, rating, message, source }). Best-effort: a
// missing config or a failed delivery never reaches the trader (still 201)
// and the only log line is "feedback-webhook failed status=<...>" — the
// URL, secret and message text never appear in logs.
export const FEEDBACK_WEBHOOK_TIMEOUT_MS = 5000;
const FEEDBACK_WEBHOOK_RETRY_DELAY_MS = 300;

async function postFeedbackOnce({ url, payload, fetchFn, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    // Drain the body so the socket can be reused. The content is untrusted
    // and never logged.
    try {
      await res.text();
    } catch {
      // Unreadable body: the status below is all that matters.
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Sends one feedback row to the owner inbox: one attempt plus one retry on
// any failure (thrown error or non-2xx), each bounded by timeoutMs. Never
// throws and never logs the URL, secret or message — only the fixed failure
// line with the HTTP status ("timeout"/"error" when no status exists,
// "missing" when the variables are absent).
export async function notifyFeedbackWebhook({
  url,
  secret,
  type,
  rating = null,
  message,
  source,
  fetchFn = fetch,
  timeoutMs = FEEDBACK_WEBHOOK_TIMEOUT_MS,
  log = logLine,
} = {}) {
  const fail = (status) => {
    try {
      log(`feedback-webhook failed status=${status}`);
    } catch {
      // Logging must never break the trader's 201.
    }
    return { sent: false, status };
  };
  if (!url || !secret) return fail("missing");
  const payload = { secret, type, rating: rating ?? null, message, source };
  let status = "error";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await postFeedbackOnce({ url, payload, fetchFn, timeoutMs });
      if (res && res.ok) return { sent: true, status: res.status };
      status = res ? res.status : "error";
    } catch (err) {
      status = err?.name === "AbortError" ? "timeout" : "error";
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, FEEDBACK_WEBHOOK_RETRY_DELAY_MS));
      }
    }
  }
  return fail(status);
}

// Seconds of audio in a WAV or MP3 buffer, or null when the bytes cannot be
// read. Pure code, no ffmpeg: WAV reads the fmt/data chunks, MP3 sums valid
// frame durations (skipping an ID3v2 tag). Anything else is null.
export function audioSeconds(buffer, format) {
  if (!buffer || buffer.length === 0) return null;
  try {
    if (format === "wav") return wavSeconds(buffer);
    if (format === "mp3") return mp3Seconds(buffer);
  } catch {
    return null;
  }
  return null;
}

function wavSeconds(buf) {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let fmt = null;
  let dataSize = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt " && size >= 16 && pos + 8 + 16 <= buf.length) {
      fmt = {
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        byteRate: buf.readUInt32LE(pos + 16),
        bitsPerSample: buf.readUInt16LE(pos + 22),
      };
    } else if (id === "data") {
      dataSize = size;
    }
    if (fmt && dataSize !== null) break;
    pos += 8 + size + (size % 2);
  }
  if (!fmt || dataSize === null) return null;
  const { channels, sampleRate, bitsPerSample } = fmt;
  let { byteRate } = fmt;
  if (!Number.isFinite(byteRate) || byteRate <= 0) {
    if (!channels || !sampleRate || !bitsPerSample) return null;
    byteRate = (sampleRate * channels * bitsPerSample) / 8;
  }
  if (!Number.isFinite(byteRate) || byteRate <= 0) return null;
  return Math.min(dataSize, buf.length) / byteRate;
}

const MP3_SAMPLE_RATES = [
  [11025, 12000, 8000], // MPEG 2.5
  null, // reserved
  [22050, 24000, 16000], // MPEG 2
  [44100, 48000, 32000], // MPEG 1
];
const MP3_BITRATES = {
  // key: version (1 = MPEG1, 2 = MPEG2/2.5) + layer (1 = I, 2 = II, 3 = III)
  11: [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  12: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  13: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  21: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  22: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  23: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

function mp3Seconds(buf) {
  let pos = 0;
  if (buf.length > 10 && buf.toString("ascii", 0, 3) === "ID3") {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    pos = 10 + size;
  }
  let seconds = 0;
  let frames = 0;
  let guard = 0;
  while (pos + 4 <= buf.length && guard++ < 200000) {
    if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) {
      pos += 1;
      continue;
    }
    const versionBits = (buf[pos + 1] >> 3) & 0x03;
    const layerBits = (buf[pos + 1] >> 1) & 0x03;
    const bitrateIdx = (buf[pos + 2] >> 4) & 0x0f;
    const sampleIdx = (buf[pos + 2] >> 2) & 0x03;
    const padding = (buf[pos + 2] >> 1) & 0x01;
    const rates = MP3_SAMPLE_RATES[versionBits];
    const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : layerBits === 1 ? 3 : 0;
    const version = versionBits === 3 ? 1 : versionBits === 2 || versionBits === 0 ? 2 : 0;
    const table = version && layer ? MP3_BITRATES[Number(`${version}${layer}`)] : null;
    if (!rates || !table || bitrateIdx === 0 || bitrateIdx === 15 || sampleIdx === 3) {
      pos += 1;
      continue;
    }
    const sampleRate = rates[sampleIdx];
    const bitrate = table[bitrateIdx - 1] * 1000;
    const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;
    const frameLen =
      layer === 1
        ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
        : Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;
    if (!Number.isFinite(frameLen) || frameLen < 1 || pos + frameLen > buf.length + 1) {
      pos += 1;
      continue;
    }
    seconds += samplesPerFrame / sampleRate;
    frames += 1;
    pos += frameLen;
  }
  return frames > 0 ? seconds : null;
}

// Validates a POST /feedback body in plain code. Returns the cleaned
// { type, rating, text, audio } where exactly one of text/audio is set —
// text is the trimmed string, audio is { data, format } ready for the model.
// Throws feedbackError(400, "<plain message>") on anything else.
export function validateFeedbackBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw feedbackError(400, "feedback needs a type and exactly one of text or audio");
  }
  if (!FEEDBACK_TYPES.includes(body.type)) {
    throw feedbackError(400, 'type must be "suggestion", "problem" or "review"');
  }
  let rating = null;
  if (body.rating !== undefined && body.rating !== null) {
    if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) {
      throw feedbackError(400, "rating must be an integer from 1 to 5");
    }
    rating = body.rating;
  }
  const hasText = body.text !== undefined && body.text !== null;
  const hasAudio = body.audio !== undefined && body.audio !== null;
  if (hasText === hasAudio) {
    throw feedbackError(400, "send exactly one of text or audio");
  }
  let text = null;
  let audio = null;
  if (hasText) {
    if (typeof body.text !== "string") throw feedbackError(400, "text must be 1 to 1000 characters");
    text = body.text.trim();
    if (!text || text.length > FEEDBACK_TEXT_MAX) {
      throw feedbackError(400, "text must be 1 to 1000 characters");
    }
  } else {
    const raw = body.audio;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw feedbackError(400, 'audioFormat "wav" or "mp3" is required with audioBase64');
    }
    const format = typeof raw.audioFormat === "string" ? raw.audioFormat.toLowerCase() : "";
    if (!AUDIO_FORMATS.includes(format)) {
      throw feedbackError(400, 'audioFormat "wav" or "mp3" is required with audioBase64');
    }
    if (typeof raw.audioBase64 !== "string" || !raw.audioBase64.trim()) {
      throw feedbackError(400, "audioBase64 must be a non-empty base64 string");
    }
    const compact = raw.audioBase64.replace(/\s+/g, "");
    if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
      throw feedbackError(400, "audioBase64 is not valid base64 audio");
    }
    const data = Buffer.from(compact, "base64");
    if (data.length === 0) throw feedbackError(400, "audioBase64 is not valid base64 audio");
    const seconds = audioSeconds(data, format);
    if (seconds === null) {
      throw feedbackError(400, "could not read that audio file (use wav or mp3)");
    }
    if (seconds > FEEDBACK_AUDIO_MAX_SECONDS) {
      throw feedbackError(400, `audio must be ${FEEDBACK_AUDIO_MAX_SECONDS} seconds or shorter`);
    }
    audio = { data: data.toString("base64"), format };
  }
  return { type: body.type, rating, text, audio };
}

export class FeedbackStore {
  // dbPathOrDb: a path (owned connection) or a shared DatabaseSync.
  constructor(dbPathOrDb = ":memory:") {
    if (typeof dbPathOrDb === "string") {
      this.db = new DatabaseSync(dbPathOrDb);
      this.ownsDb = true;
    } else {
      this.db = dbPathOrDb;
      this.ownsDb = false;
    }
    this.db.exec(FEEDBACK_SCHEMA);
  }

  iso(now) {
    return new Date(now).toISOString();
  }

  // Drops attempts past the hourly window so the table stays bounded.
  prune(now = Date.now()) {
    this.db
      .prepare("DELETE FROM feedback_attempts WHERE created_at < ?")
      .run(this.iso(now - FEEDBACK_WINDOW_MS));
  }

  recentAttempts(kind, key, now = Date.now()) {
    return this.db
      .prepare("SELECT COUNT(*) AS c FROM feedback_attempts WHERE kind = ? AND key = ? AND created_at > ?")
      .get(kind, key, this.iso(now - FEEDBACK_WINDOW_MS)).c;
  }

  // True past the hourly budget on either dimension (each allows 5/hour).
  limited(ip, shopId, now = Date.now()) {
    this.prune(now);
    return (
      this.recentAttempts("ip", ip, now) >= FEEDBACK_RATE_LIMIT ||
      this.recentAttempts("shop", shopId, now) >= FEEDBACK_RATE_LIMIT
    );
  }

  // Stores the feedback row and consumes one attempt on each dimension, in
  // one transaction so a crash never counts quota without storing (or the
  // reverse). Returns the stored row id.
  record({ shopId, ip, type, rating = null, text, now = Date.now() }) {
    if (!shopId || !ip || !FEEDBACK_TYPES.includes(type) || typeof text !== "string" || !text) {
      throw new Error("record needs { shopId, ip, type, text }");
    }
    const createdAt = this.iso(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare("INSERT INTO feedback (shop_id, ip, type, rating, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(shopId, ip, type, rating, text, createdAt);
      this.db.prepare("INSERT INTO feedback_attempts (kind, key, created_at) VALUES ('ip', ?, ?)").run(ip, createdAt);
      this.db
        .prepare("INSERT INTO feedback_attempts (kind, key, created_at) VALUES ('shop', ?, ?)")
        .run(shopId, createdAt);
      this.db.exec("COMMIT");
      return Number(result.lastInsertRowid);
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw err;
    }
  }

  listByShop(shopId) {
    return this.db.prepare("SELECT * FROM feedback WHERE shop_id = ? ORDER BY id ASC").all(shopId);
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}
