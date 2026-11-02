// Safe logging: every line built here carries methods, paths, status
// codes, durations and short labels only — never request bodies, note
// text, audio or image data, phone numbers, tokens, API keys, headers,
// or secret values. Digit runs are masked so a stray number can't leak.
import { execFileSync } from "node:child_process";

// Single sink for every line below, so tests can silence or capture the
// output without touching console. Production always logs through here.
const defaultSink = (...args) => console.log(...args);
let sink = defaultSink;
export function setLogSink(fn) {
  sink = typeof fn === "function" ? fn : defaultSink;
}
export function logLine(text) {
  sink(String(text));
}

// Shop ids are opaque but stable per shop, so keep the first 3 characters
// for correlating a shop's requests and mask the rest.
export function maskShopId(shopId) {
  const s = String(shopId ?? "");
  return s ? `${s.slice(0, 3)}***` : "-";
}

// Masks runs of 7+ digits (phone numbers, tokens, key fragments) wherever
// they appear, keeping the last 2 for shape.
export function scrub(text) {
  return String(text ?? "").replace(/\d{7,}/g, (m) => `***${m.slice(-2)}`);
}

// Why a provider call failed, from its status or thrown error — never from
// message text. "auth" means the provider rejected the key (401/403).
export function failureReason({ status = null, err = null } = {}) {
  if (err?.name === "TimeoutError") return "timeout";
  if (err instanceof TypeError) return "network";
  if (status === 401 || status === 403) return "auth";
  return "error";
}

// One finished HTTP request: method, path without query string, status,
// duration, masked shop, the client request id when one rode along, and
// for failures a short scrubbed error fragment.
// Only the fields above ever reach a line: bodies, headers, keys and note
// text are never read here, so they cannot leak through it.
export function formatRequestLog({ method, path, status, ms, shop = null, rid = null, error = null }) {
  const cleanPath = String(path ?? "/").split("?")[0] || "/";
  let line = `${method} ${cleanPath} ${status} ${ms}ms shop=${maskShopId(shop)}`;
  if (rid) line += ` rid=${scrub(String(rid).slice(0, 64))}`;
  if (error) {
    let frag = scrub(error.code ?? error.message ?? error).slice(0, 120);
    // Some code-written messages name the shop ("shop X has no entries"):
    // mask it there too, so the id appears nowhere unmasked.
    const s = String(shop ?? "");
    if (s) frag = frag.split(s).join(maskShopId(s));
    if (frag) line += ` err=${frag}`;
  }
  return line;
}

// One finished model call, always logged (host logs, not just dev): which
// kind, which model id, the outcome, how long it took, and the request id.
// Metadata only — never message text, transcripts, audio, phone numbers or
// keys. Status is one of ok, failed, timeout, skipped.
export function formatModelCallLog({ kind, model, status, ms, rid }) {
  return `model-call kind=${kind} model=${model ?? "none"} status=${status} ms=${ms} rid=${rid}`;
}

// One failed model call: which kind, which provider, the provider HTTP
// status, and the classified reason. Logged always, not just in dev, so a
// dead voice/photo path is visible in host logs.
export function formatModelLog({ kind, provider, status = null, reason, attempts = null, ms }) {
  let line = `model-error kind=${kind} provider=${provider} status=${status ?? "-"} reason=${reason}`;
  if (attempts !== null && attempts !== undefined) line += ` attempts=${attempts}`;
  line += ` ms=${ms}`;
  return line;
}

// Start-up feature lines: which paid features are on or off and why.
// Names only, never values — model ids and cap budgets are not secrets.
// The Meta key is the only required variable; everything else degrades.
export function startupEnvLines(env = process.env) {
  const e = env ?? {};
  const lines = [];
  if (e.META_API_KEY) lines.push("model reads: on (muse-spark-1.3 text, muse-spark-1.2 audio)");
  else lines.push("model reads: off (no META_API_KEY)");
  if (e.BASETEN_API_KEY && e.BASETEN_MODEL) lines.push(`second opinion: on (Baseten ${e.BASETEN_MODEL})`);
  else if (!e.BASETEN_API_KEY) lines.push("second opinion: off (no BASETEN_API_KEY)");
  else lines.push("second opinion: off (no BASETEN_MODEL)");
  if (e.WHATSAPP_ALLOWED_NUMBERS) lines.push("whatsapp: on");
  else lines.push("whatsapp: off (no WHATSAPP_ALLOWED_NUMBERS)");
  if (e.FEEDBACK_WEBHOOK_URL) lines.push("feedback forward: on");
  else lines.push("feedback forward: off (no FEEDBACK_WEBHOOK_URL)");
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  lines.push(`daily caps: on (demo ${num(e.DAILY_CAP_DEMO, 40)}, shop ${num(e.DAILY_CAP_SHOP, 200)}, service ${num(e.DAILY_CAP_SERVICE, 1500)})`);
  return lines;
}

// True when an ffmpeg binary answers, false otherwise. Runs once at boot.
export function ffmpegAvailable() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
