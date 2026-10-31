// The request for feedback, in one place. If the backend reports a different
// format, this is the only file to change (format as reported by Muse).
//
//   POST /feedback   (JSON; same login and x-shop-id headers as the other shop
//                     routes, which the api layer already adds; no x-request-id)
//   body    { type: "suggestion" | "problem" | "review",   required
//             rating?: 1..5 (integer),
//             text: string (trimmed, 1 to 1000 characters)   EITHER text
//             audioBase64 + audioFormat: "wav" }             OR audio, never both
//   audio uses the voice note route's own fields (audioBase64, audioFormat), at
//   most 45 seconds.
//   201 { ok: true }                          typed message
//   201 { ok: true, text: "<what was heard>" } audio: the transcript comes back
//   400 { error }  validation (bad type or rating, empty or too long text, both)
//   429 { error }  too many (5 per hour per person)
export const FEEDBACK_ROUTE = "/feedback";
export const FEEDBACK_TYPES = ["suggestion", "problem", "review"];
export const FEEDBACK_TEXT_MAX = 1000;
export const FEEDBACK_AUDIO_MAX_SECONDS = 45;

// input: { type, rating?, text? , audioBase64? } -> { path, body }
export function buildFeedbackRequest(input) {
  const body = { type: input.type };
  if (Number.isInteger(input.rating)) body.rating = input.rating;
  if (input.audioBase64) {
    body.audioBase64 = input.audioBase64;
    body.audioFormat = "wav";
  } else {
    body.text = String(input.text ?? "").trim();
  }
  return { path: FEEDBACK_ROUTE, body };
}

// The reply -> { heard }: what was heard for a voice message, else null.
export function parseFeedbackReply(reply) {
  const heard = typeof reply?.text === "string" && reply.text.trim() ? reply.text.trim() : null;
  return { heard };
}
