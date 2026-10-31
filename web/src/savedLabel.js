// The label above a screen that is showing saved data, and how long to wait
// before asking the server again. Plain JavaScript so the tests can use it.
import { lagosDay, timeLabel } from "./format.js";

// The quiet note under the header while saved data is showing:
// "Last updated 05:32"; "Last updated yesterday 18:10"; "Last updated 28 Oct 18:10".
// It does not repeat that the app is offline (the pill says so).
export function lastUpdated(savedAt, now = Date.now()) {
  const time = timeLabel(savedAt);
  const day = lagosDay(savedAt);
  if (day === lagosDay(new Date(now).toISOString())) return `Last updated ${time}`;
  if (day === lagosDay(new Date(now - 86_400_000).toISOString())) return `Last updated yesterday ${time}`;
  const date = new Date(savedAt).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short" });
  return `Last updated ${date} ${time}`;
}

// What a screen reader hears for the same note: that this is saved data and
// that the app is offline, which the quiet text leaves out.
export const lastUpdatedSpoken = (savedAt, now) => `Saved data. You are offline. ${lastUpdated(savedAt, now)}.`;

// The oldest of several saved times (a screen made of two loads is as old as
// its older half), or null when none of it is saved data.
export function oldestSaved(...saved) {
  const times = saved.filter(Boolean).map((s) => s.savedAt).sort();
  return times[0] ?? null;
}

// Automatic retry while a screen shows saved data: 20 s, then 40, 80, 160, and
// every 160 s after that.
export const retryDelayMs = (attempt) => Math.min(20_000 * 2 ** Math.max(0, attempt), 160_000);
