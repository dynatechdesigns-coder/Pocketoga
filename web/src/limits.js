// What the app says when the server answers HTTP 429 (a daily or hourly limit).
// The server's own {error} sentence is shown when it is plain words; otherwise
// one of the fixed sentences below. A limit is a calm notice, never a crash.
// Plain JavaScript with no imports, so api.js, the queue and the tests can use it.

export const LIMIT_MESSAGE = "PocketOga has reached today's limit. Please try again later.";
export const FEEDBACK_LIMIT_MESSAGE = "You've sent a few messages already. Please try again in an hour.";
// A queued entry that got a 429 stays in Waiting to send with this line.
export const LIMIT_QUEUED_MESSAGE = "PocketOga has reached today's limit. It will try again later.";
export const LIMIT_RETRY_MS = 15 * 60 * 1000; // a queued entry tries again after this

export const isLimit = (err) => err?.status === 429;

// Code-style text (names like audioBase64, snake_case, JSON, "server error 429")
// is not for a trader.
const TECHNICAL_WORDS = /\b(undefined|null|payload|json|exception|stack|exactly\s+one\s+of)\b|^server error \d+$/i;
const CODE_NAMES = /[a-z][A-Z]|_/;
export const isPlainText = (m) => !!m && !TECHNICAL_WORDS.test(m) && !CODE_NAMES.test(m.replace(/PocketOga/g, "Pocket"));

// The sentence to show for a 429: the server's own, else `fallback`.
export function limitText(err, fallback = LIMIT_MESSAGE) {
  const m = typeof err?.message === "string" ? err.message.trim() : "";
  if (!isPlainText(m)) return fallback;
  return m.charAt(0).toUpperCase() + m.slice(1);
}
