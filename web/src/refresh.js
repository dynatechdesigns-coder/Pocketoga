// "Something was saved": a tiny signal so any screen that is open reloads its
// numbers without a page reload. Plain JavaScript (no window), so the web
// tests can use it under node.
const listeners = new Set();

// Calls `listener` on every change; returns the function that stops it.
export function onDataChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyDataChanged() {
  for (const listener of [...listeners]) listener();
}
