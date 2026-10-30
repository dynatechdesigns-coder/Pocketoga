// What the Record screen shows while it waits for a proposal: honest stages
// (never a percentage), a 40-second limit, and one plain message per way it
// can go wrong. Plain JavaScript so the web tests can run it under node.
import { ApiError, friendlyError } from "./api.js";

export const TIMEOUT_MS = 40_000;

// Shown in order. "Listening…" is on screen the moment recording stops, while
// the note uploads; the next two follow if the answer is slow. The last stage
// stays until the answer (or an error) arrives.
export const STAGES = ["Listening…", "Reading your note…", "Checking the numbers…"];
export const STAGE_DELAYS_MS = [2500, 6000]; // when stages 2 and 3 start

// Voice notes wait longer: a slow-wait line at 30 s, a failure at 60 s.
export const VOICE_STAGES = [...STAGES, "Still working… this is taking longer than usual."];
export const VOICE_STAGE_DELAYS_MS = [2500, 6000, 30_000];
export const VOICE_TIMEOUT_MS = 60_000;

export const MESSAGES = {
  mic: "PocketOga needs your microphone. Allow it in your browser settings, or type the note below.",
  empty: "We did not catch anything. Tap the mic, talk, then tap again to stop.",
  network: "Cannot reach PocketOga. Check your connection and try again.",
  timeout: "This is taking too long, so we stopped waiting. Nothing was saved. Please try again.",
  unreadable: "Could not read that recording. Try again, or type it.",
};

// An error the screen shows as text, with `kind` saying whether a retry makes
// sense (network and timeout do; the rest need the trader to do something).
export class WaitError extends Error {
  constructor(kind, message = MESSAGES[kind]) {
    super(message);
    this.kind = kind;
  }
}

export const canRetry = (err) => err instanceof WaitError && (err.kind === "timeout" || err.kind === "network");

// Turns anything thrown while waiting into a WaitError.
export function toWaitError(err) {
  if (err instanceof WaitError) return err;
  if (err instanceof ApiError) return new WaitError(err.status === 0 ? "network" : "api", friendlyError(err));
  return new WaitError("unreadable");
}

// Runs `call(signal)` (which returns the proposal), reporting each stage to
// `onStage(text)` as it starts. Rejects with a WaitError; after the limit the
// request is aborted and a late answer is never used.
export async function waitForProposal(call, { onStage, startAt = 0, delays = STAGE_DELAYS_MS, timeoutMs = TIMEOUT_MS, stages = STAGES, outer } = {}) {
  const controller = new AbortController();
  // `outer`: the screen's own Cancel; it stops the request the same way.
  outer?.addEventListener("abort", () => controller.abort(), { once: true });
  let timedOut = false;
  const timers = [];
  onStage?.(stages[startAt]);
  delays.forEach((ms, i) => {
    const stage = i + 1;
    if (stage > startAt) timers.push(setTimeout(() => onStage?.(stages[stage]), ms));
  });
  timers.push(
    setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs)
  );
  try {
    return await call(controller.signal);
  } catch (err) {
    throw timedOut ? new WaitError("timeout") : toWaitError(err);
  } finally {
    timers.forEach(clearTimeout);
  }
}

// A recording with nothing in it (or only a blip) is not worth uploading.
export const isEmptyRecording = (blob) => !blob || blob.size === 0;
