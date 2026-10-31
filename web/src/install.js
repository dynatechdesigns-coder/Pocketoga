// "Install PocketOga": which kind of row to show, if any, and the one place
// that keeps the browser's install prompt. Plain JavaScript so the web tests
// can run it under node. Nothing here may throw into the app: every browser
// call is wrapped.
//
// Row kinds: "prompt" (Chrome on Android or desktop: the browser's own
// dialog), "ios" (Safari on iPhone or iPad: steps only, there is no prompt
// API), or null (already installed, or a browser that offers neither).

// iPhone, iPad (new iPads say "Macintosh" but have a touch screen) and iPod,
// in Safari itself. Chrome, Firefox, Edge and in-app browsers on iOS do not
// get the row.
export function isIosSafari({ ua = "", platform = "", maxTouchPoints = 0 } = {}) {
  const ios = /iPhone|iPad|iPod/.test(ua) || (platform === "MacIntel" && maxTouchPoints > 1);
  if (!ios) return false;
  if (/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|Line\/|MicroMessenger/.test(ua)) return false;
  return /Safari/.test(ua);
}

export function rowKind({ standalone = false, hasPrompt = false, installed = false, iosSafari = false } = {}) {
  if (standalone || installed) return null;
  if (hasPrompt) return "prompt";
  if (iosSafari) return "ios";
  return null;
}

// Reads the current environment; each lookup is guarded.
export function readEnvironment(win = globalThis.window) {
  const safe = (fn, fallback) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  return {
    standalone: safe(() => !!win.matchMedia?.("(display-mode: standalone)").matches || win.navigator?.standalone === true, false),
    iosSafari: safe(() => isIosSafari({ ua: win.navigator.userAgent, platform: win.navigator.platform, maxTouchPoints: win.navigator.maxTouchPoints }), false),
  };
}

export function createInstallStore({ env = readEnvironment } = {}) {
  let state = { promptEvent: null, installed: false };
  const listeners = new Set();
  const set = (next) => {
    state = next;
    listeners.forEach((l) => l());
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // beforeinstallprompt: keep the event, stop the browser's own mini-bar.
    capture(event) {
      try {
        event.preventDefault?.();
        set({ ...state, promptEvent: event });
      } catch {
        // never break the app
      }
    },
    markInstalled: () => set({ promptEvent: null, installed: true }),
    // What the row should be right now.
    kind: () => rowKind({ ...env(), hasPrompt: !!state.promptEvent, installed: state.installed }),
    // Shows the browser's dialog. The event works once, so it is dropped
    // afterwards; "appinstalled" hides the row for good. Returns the outcome
    // ("accepted", "dismissed") or "failed".
    async prompt() {
      const event = state.promptEvent;
      if (!event) return "failed";
      try {
        await event.prompt();
        const choice = await event.userChoice;
        set({ ...state, promptEvent: null, installed: choice?.outcome === "accepted" || state.installed });
        return choice?.outcome ?? "dismissed";
      } catch {
        set({ ...state, promptEvent: null });
        return "failed";
      }
    },
  };
}

export const install = createInstallStore();

// Call once, early (main.jsx), before the app renders: the browser fires
// beforeinstallprompt soon after load, usually before any menu is open.
let started = false;
export function startInstallCapture(win = globalThis.window) {
  if (started || !win) return;
  started = true;
  try {
    win.addEventListener("beforeinstallprompt", (e) => install.capture(e));
    win.addEventListener("appinstalled", () => install.markInstalled());
  } catch {
    // no install row, nothing else changes
  }
}

export const IOS_STEPS = [
  "Tap the Share button (the square with an arrow) at the bottom of Safari.",
  "Scroll down and tap Add to Home Screen.",
  "Tap Add. PocketOga now opens from your home screen.",
];
