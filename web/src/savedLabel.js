// The label above a screen that is showing saved data, and how long to wait
// before asking the server again. Plain JavaScript so the tests can use it.
import { lagosDay, timeLabel } from "./format.js";

// "Saved data from 05:10. You are offline."; with the date when it was not
// saved today: "Saved data from 28 Oct, 05:10. You are offline."
export function savedLabel(savedAt, now = Date.now()) {
  const time = timeLabel(savedAt);
  if (lagosDay(savedAt) === lagosDay(new Date(now).toISOString())) return `Saved data from ${time}. You are offline.`;
  const date = new Date(savedAt).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short" });
  return `Saved data from ${date}, ${time}. You are offline.`;
}

// The oldest of several saved times (a screen made of two loads is as old as
// its older half), or null when none of it is saved data.
export function oldestSaved(...saved) {
  const times = saved.filter(Boolean).map((s) => s.savedAt).sort();
  return times[0] ?? null;
}

// Automatic retry while a screen shows saved data: 20 s, then 40, 80, 160, and
// every 160 s after that.
export const retryDelayMs = (attempt) => Math.min(20_000 * 2 ** Math.max(0, attempt), 160_000);
