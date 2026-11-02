// "Send feedback": the form's rules, its state and what happens on a send.
// Plain JavaScript so the web tests can run it under node. Feedback never goes
// through the offline queue: offline, or on any error, the trader keeps what
// they typed and sends it again by hand.
import { FEEDBACK_LIMIT_MESSAGE, limitText } from "./limits.js";
import { FEEDBACK_PRIVACY } from "./privacyNotes.js";
import { FEEDBACK_AUDIO_MAX_SECONDS, FEEDBACK_TEXT_MAX, buildFeedbackRequest, parseFeedbackReply } from "./feedbackFormat.js";

export { FEEDBACK_AUDIO_MAX_SECONDS, FEEDBACK_TEXT_MAX };

export const PRIVACY_NOTE = FEEDBACK_PRIVACY;
export const OFFLINE_MESSAGE = "You are offline. Your feedback is still here. Send it when you are back online.";
export const TOO_MANY_MESSAGE = FEEDBACK_LIMIT_MESSAGE; // when the server sends no sentence of its own
export const NETWORK_MESSAGE = "Could not reach PocketOga. Your feedback is still here. Try again in a moment.";
export const FAILED_MESSAGE = "Something went wrong and your feedback was not sent. It is still here. Try again in a moment.";
export const THANKS = "Thank you";
export const COLLAPSE_AFTER_MS = 6000; // the Thank you stays a few seconds, then the card folds up
export const EMPTY_HINT = "Write or record your message";
export const SENDING_VOICE = "We'll send your voice message.";
export const SENDING_TEXT = "We'll send your typed message.";
export const MIC_BLOCKED_MESSAGE = "PocketOga needs your microphone. Allow it in your browser settings, or type your message.";
export const MIC_EMPTY_MESSAGE = "We did not catch anything. Tap the mic, talk, then tap again to stop.";
export const UNREADABLE_MESSAGE = "We could not read that recording. Record it again, or type your message.";
export const REFUSED_MESSAGE = "We could not send that. Please check your message and try again. It is still here.";

export const counterText = (text) => `${String(text ?? "").length} / ${FEEDBACK_TEXT_MAX}`;

// What the text box keeps: at most 1000 characters (a long paste is cut).
export const clampText = (text) => String(text ?? "").slice(0, FEEDBACK_TEXT_MAX);

// --- State -------------------------------------------------------------------

export const emptyFeedback = () => ({ rating: null, text: "", audio: null, switched: null, status: "idle", error: null, limit: false, heard: null });

// Exactly one of a typed message and a voice message is ever held. Adding one
// drops the other and `switched` says which one will be sent ("voice" or
// "typed"), so the form can tell the person in one plain line. Every change
// after an error keeps what was typed.
export function feedbackReducer(state, action) {
  switch (action.type) {
    case "rating":
      // Tapping the same star again clears it (the rating is optional).
      return { ...state, rating: state.rating === action.value ? null : action.value, error: null };
    case "text": {
      const text = clampText(action.value);
      if (text.trim() && state.audio) return { ...state, text, audio: null, switched: "typed", error: null };
      return { ...state, text, switched: text.trim() ? state.switched : null, error: null };
    }
    case "audio":
      return { ...state, audio: { blob: action.blob, seconds: action.seconds }, text: "", switched: state.text.trim() ? "voice" : null, error: null };
    case "removeAudio":
      return { ...state, audio: null, switched: null, error: null };
    case "sending":
      return { ...state, status: "sending", switched: null, error: null };
    case "sent":
      return { ...emptyFeedback(), status: "sent", heard: action.heard ?? null };
    case "failed":
      return { ...state, status: "idle", error: action.message, limit: !!action.limit };
    case "dismiss":
      return { ...state, error: null, limit: false };
    case "error":
      return { ...state, error: action.message };
    case "reset":
      return emptyFeedback();
    default:
      return state;
  }
}

// What the form shows under the message: nothing, or one plain line. `canSend`
// is false only when there is nothing to send.
export function messageState(s) {
  const hasText = !!String(s.text ?? "").trim();
  const hasAudio = !!s.audio;
  if (!hasText && !hasAudio) return { canSend: false, line: EMPTY_HINT };
  if (s.switched === "voice" && hasAudio) return { canSend: true, line: SENDING_VOICE };
  if (s.switched === "typed" && hasText) return { canSend: true, line: SENDING_TEXT };
  return { canSend: true, line: null };
}

// --- Checks ------------------------------------------------------------------

// -> { ok: true, mode: "text" | "audio" } or { error, field } in plain words.
export function validateFeedback(s) {
  if (s.rating !== null && s.rating !== undefined && !(Number.isInteger(s.rating) && s.rating >= 1 && s.rating <= 5)) {
    return { error: "The rating must be from 1 to 5 stars.", field: "rating" };
  }
  const text = String(s.text ?? "").trim();
  if (s.audio) {
    if (s.audio.seconds > FEEDBACK_AUDIO_MAX_SECONDS + 1) return { error: `A voice message can be at most ${FEEDBACK_AUDIO_MAX_SECONDS} seconds.`, field: "audio" };
    return { ok: true, mode: "audio" }; // the form never holds both; if it ever did, the voice message is the newer one
  }
  if (!text) return { error: EMPTY_HINT, field: "text" };
  if (text.length > FEEDBACK_TEXT_MAX) return { error: `Your message can be at most ${FEEDBACK_TEXT_MAX} characters.`, field: "text" };
  return { ok: true, mode: "text" };
}

// A server message that is plain words is shown as it is. Code-style text
// (names like audioBase64 or invalid_field, "exactly one of", null, JSON) is
// not, and neither is the app's own "server error 500" filler.
const TECHNICAL_WORDS = /\b(undefined|null|payload|json|exception|stack|exactly\s+one\s+of)\b|^server error \d+$/i;
const CODE_NAMES = /[a-z][A-Z]|_/;
export const isPlainMessage = (m) => !!m && !TECHNICAL_WORDS.test(m) && !CODE_NAMES.test(m.replace(/PocketOga/g, "Pocket"));

// The plain sentence for a failed send. A 429 is the fixed sentence. Any other
// answer of the 4xx kind with a plain message in { error } shows that message;
// an unknown or code-style one gets the generic sentence. A lost connection and
// a server fault say so in plain words.
export function feedbackError(err) {
  const status = err?.status;
  if (status === 429) return limitText(err, TOO_MANY_MESSAGE);
  if (status === 0) return NETWORK_MESSAGE;
  if (status >= 400 && status < 500) {
    const m = typeof err.message === "string" ? err.message.trim() : "";
    return isPlainMessage(m) ? m.charAt(0).toUpperCase() + m.slice(1) : REFUSED_MESSAGE;
  }
  return FAILED_MESSAGE;
}

// One send, as the action to apply to the form. Nothing here throws.
//   online()        -> false when the device cannot reach PocketOga
//   toWav(blob)     -> base64 WAV of a recording
//   send(request)   -> the server's reply (rejects with an ApiError)
export async function runSubmit(state, { online, toWav, send }) {
  const checked = validateFeedback(state);
  if (!checked.ok) return { type: "error", message: checked.error, field: checked.field };
  if (!online()) return { type: "failed", message: OFFLINE_MESSAGE };
  try {
    const input = { rating: state.rating ?? undefined };
    if (checked.mode === "audio") {
      try {
        input.audioBase64 = await toWav(state.audio.blob);
      } catch {
        return { type: "failed", message: UNREADABLE_MESSAGE };
      }
    } else {
      input.text = state.text;
    }
    const reply = await send(buildFeedbackRequest(input));
    return { type: "sent", heard: parseFeedbackReply(reply).heard };
  } catch (err) {
    return { type: "failed", message: feedbackError(err), ...(err?.status === 429 ? { limit: true } : {}) };
  }
}
