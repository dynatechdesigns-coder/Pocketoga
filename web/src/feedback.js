// "Send feedback": the form's rules, its state and what happens on a send.
// Plain JavaScript so the web tests can run it under node. Feedback never goes
// through the offline queue: offline, or on any error, the trader keeps what
// they typed and sends it again by hand.
import { FEEDBACK_AUDIO_MAX_SECONDS, FEEDBACK_TEXT_MAX, FEEDBACK_TYPES, buildFeedbackRequest, parseFeedbackReply } from "./feedbackFormat.js";

export { FEEDBACK_AUDIO_MAX_SECONDS, FEEDBACK_TEXT_MAX };

export const TYPE_OPTIONS = [
  { key: "suggestion", label: "Suggestion", hint: "An idea to make PocketOga better" },
  { key: "problem", label: "Problem", hint: "Something is wrong or confusing" },
  { key: "review", label: "Review", hint: "What you think of PocketOga" },
];

export const PRIVACY_NOTE = "Please don't include phone numbers or real customer names. Voice is turned into text and the recording is deleted.";
export const OFFLINE_MESSAGE = "You are offline. Your feedback is still here. Send it when you are back online.";
export const TOO_MANY_MESSAGE = "Too many sent. Try again later.";
export const NETWORK_MESSAGE = "Could not reach PocketOga. Your feedback is still here. Try again in a moment.";
export const FAILED_MESSAGE = "Something went wrong and your feedback was not sent. It is still here. Try again in a moment.";
export const THANKS = "Thank you";

export const counterText = (text) => `${String(text ?? "").length} / ${FEEDBACK_TEXT_MAX}`;

// What the text box keeps: at most 1000 characters (a long paste is cut).
export const clampText = (text) => String(text ?? "").slice(0, FEEDBACK_TEXT_MAX);

// --- State -------------------------------------------------------------------

export const emptyFeedback = () => ({ type: null, rating: null, text: "", audio: null, status: "idle", error: null, heard: null });

// Every change after an error keeps what was typed. A voice message and typed
// text are never held together: adding one drops the other.
export function feedbackReducer(state, action) {
  switch (action.type) {
    case "type":
      return { ...state, type: action.value, error: null };
    case "rating":
      // Tapping the same star again clears it (the rating is optional).
      return { ...state, rating: state.rating === action.value ? null : action.value, error: null };
    case "text":
      return { ...state, text: clampText(action.value), error: null };
    case "audio":
      return { ...state, audio: { blob: action.blob, seconds: action.seconds }, text: "", error: null };
    case "removeAudio":
      return { ...state, audio: null, error: null };
    case "sending":
      return { ...state, status: "sending", error: null };
    case "sent":
      return { ...emptyFeedback(), status: "sent", heard: action.heard ?? null };
    case "failed":
      return { ...state, status: "idle", error: action.message };
    case "error":
      return { ...state, error: action.message };
    case "reset":
      return emptyFeedback();
    default:
      return state;
  }
}

// --- Checks ------------------------------------------------------------------

// -> { ok: true, mode: "text" | "audio" } or { error, field } in plain words.
export function validateFeedback(s) {
  if (!FEEDBACK_TYPES.includes(s.type)) return { error: "Pick what kind of feedback this is.", field: "type" };
  if (s.rating !== null && s.rating !== undefined && !(Number.isInteger(s.rating) && s.rating >= 1 && s.rating <= 5)) {
    return { error: "The rating must be from 1 to 5 stars.", field: "rating" };
  }
  const text = String(s.text ?? "").trim();
  if (text && s.audio) return { error: "Send either a typed message or a voice message, not both.", field: "text" };
  if (s.audio) {
    if (s.audio.seconds > FEEDBACK_AUDIO_MAX_SECONDS + 1) return { error: `A voice message can be at most ${FEEDBACK_AUDIO_MAX_SECONDS} seconds.`, field: "audio" };
    return { ok: true, mode: "audio" };
  }
  if (!text) return { error: "Type your feedback, or record a voice message.", field: "text" };
  if (text.length > FEEDBACK_TEXT_MAX) return { error: `Your message can be at most ${FEEDBACK_TEXT_MAX} characters.`, field: "text" };
  return { ok: true, mode: "text" };
}

// The plain sentence for a failed send. A 400 shows the server's own message.
export function feedbackError(err) {
  const status = err?.status;
  if (status === 429) return TOO_MANY_MESSAGE;
  if (status === 400 && typeof err.message === "string" && err.message.trim()) return err.message.charAt(0).toUpperCase() + err.message.slice(1);
  if (status === 0) return NETWORK_MESSAGE;
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
    const input = { type: state.type, rating: state.rating ?? undefined };
    if (checked.mode === "audio") {
      try {
        input.audioBase64 = await toWav(state.audio.blob);
      } catch {
        return { type: "failed", message: "We could not read that recording. Record it again, or type your feedback." };
      }
    } else {
      input.text = state.text;
    }
    const reply = await send(buildFeedbackRequest(input));
    return { type: "sent", heard: parseFeedbackReply(reply).heard };
  } catch (err) {
    return { type: "failed", message: feedbackError(err) };
  }
}
