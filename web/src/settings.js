// What the Settings screen says about the shop, in plain data so the tests can
// check it. The order of the sections is fixed here too. Plain JavaScript.

// The sections, top to bottom. The leave button (Leave the demo, or Sign out in
// a real shop) is its own row just above "feedback", which is last; "install"
// shows only where installing is possible.
export const SETTINGS_ORDER = ["theme", "shop", "install", "leave", "feedback"];

// A real shop never shows the words "Demo" or "fake data".
export function shopInfo(shop) {
  if (shop?.demo) {
    return {
      kind: "demo",
      name: shop.name,
      badge: "Demo shop",
      line: "This is a demo shop. It only has made-up data to look at.",
      openReal: {
        title: "Open your real shop",
        line: "Real shops open with a code. WhatsApp is built and waiting for Meta approval. If you already have a code, enter it here.",
        button: "Log in to my shop",
      },
      leave: { label: "Leave the demo", variant: "quiet" },
    };
  }
  return {
    kind: "real",
    name: shop?.name ?? "",
    badge: "Real shop",
    line: "These are your real records.",
    openReal: null,
    leave: { label: "Sign out", variant: "quiet" },
  };
}
