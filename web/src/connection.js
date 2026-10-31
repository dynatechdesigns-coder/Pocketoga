// Is PocketOga reachable? One small store the top bar reads: the device's own
// online flag, plus whether the last request failed on the network (a lost
// connection or a timeout). Either one means "Offline"; a request that
// succeeds or the browser's "online" event puts it right again. Plain
// JavaScript so the web tests can run it under node.
export function createConnection({ isOnline = () => globalThis.navigator?.onLine !== false } = {}) {
  let state = { deviceOnline: isOnline(), lastFailed: false };
  const listeners = new Set();
  const set = (next) => {
    if (next.deviceOnline === state.deviceOnline && next.lastFailed === state.lastFailed) return;
    state = next;
    listeners.forEach((l) => l());
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // A request got an answer from the server (any status): we are reachable.
    reportReached: () => set({ ...state, lastFailed: false }),
    // A request failed on the network or timed out.
    reportFailed: () => set({ ...state, lastFailed: true }),
    // The browser's own events.
    setDeviceOnline: (online) => set({ deviceOnline: online, lastFailed: online ? false : state.lastFailed }),
  };
}

export const isOffline = (s) => !s.deviceOnline || s.lastFailed;

// What the pill says, or null when it should not show.
export function pillText(s, waiting = 0) {
  if (!isOffline(s)) return null;
  return waiting > 0 ? `Offline · ${waiting} waiting` : "Offline";
}

// Grey while the app is simply offline; amber only when a queued item needs
// the trader ("needs-you").
export const pillTone = (items = []) => (items.some((i) => i.status === "needs-you") ? "warn" : "neutral");

export const connection = createConnection();

// Wires the browser events to the shared store (once).
let watching = false;
export function watchBrowserConnection() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener("online", () => connection.setDeviceOnline(true));
  window.addEventListener("offline", () => connection.setDeviceOnline(false));
}
