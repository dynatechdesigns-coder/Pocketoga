// The Record screen's recording limit: stop by itself at 45 seconds, say so,
// and keep the audio. Plain JavaScript so the web tests can use fake timers.
export const MAX_RECORD_SECONDS = 45;
export const TIME_UP_MESSAGE = "Time's up. Send it or record again.";
export const VOICE_HINT = "Short notes work best (under 30 seconds)";

// Ticks `onTick(seconds)` four times a second; calls `onLimit()` once when the
// limit is reached. Returns a stop function.
export function createRecordTimer({ onTick, onLimit, limitSeconds = MAX_RECORD_SECONDS, now = Date.now }) {
  const started = now();
  let fired = false;
  const timer = setInterval(() => {
    const s = Math.floor((now() - started) / 1000);
    onTick?.(s);
    if (s >= limitSeconds && !fired) {
      fired = true;
      onLimit?.();
    }
  }, 250);
  return () => clearInterval(timer);
}
