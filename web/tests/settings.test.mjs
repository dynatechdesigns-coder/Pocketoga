// Web tests for the reworked Settings screen: the order of its sections, the
// demo versus real-shop wording, the removed "only suggests" card, Feedback
// inside Settings, and the way from the demo to the login. Fake data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const { SETTINGS_ORDER, shopInfo } = await import("../src/settings.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const screen = read("src/screens/SettingsScreen.jsx");

const demo = { id: "demo", name: "Demo Provisions", demo: true };
const real = { id: "wa-abc123", name: "Mama Bisi Store", token: "t", expiresAt: "2999-01-01T00:00:00Z" };

describe("order", () => {
  test("Theme, Your shop, Install, Feedback, then Leave the demo / Sign out", () => {
    assert.deepEqual(SETTINGS_ORDER, ["theme", "shop", "install", "feedback", "leave"]);
    const at = (needle) => {
      const i = screen.indexOf(needle);
      assert.ok(i >= 0, needle);
      return i;
    };
    const order = [at('data-part="settings-theme"'), at('data-part="settings-shop"'), at('data-part="settings-install"'), at("<FeedbackSection"), at('data-part="leave"')];
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });

  test("the leave / sign-out button is the very last thing, and the Install list hides itself when empty", () => {
    const tail = screen.slice(screen.indexOf('data-part="leave"'));
    assert.doesNotMatch(tail, /<Card|<FeedbackSection|<InstallRow/);
    assert.match(screen, /data-part="settings-install" className="[^"]*empty:hidden/);
  });
});

describe("the demo shop", () => {
  const info = shopInfo(demo);

  test("is plainly a demo, with the card that opens a real shop", () => {
    assert.equal(info.kind, "demo");
    assert.equal(info.badge, "Demo shop");
    assert.match(info.line, /demo shop/i);
    assert.equal(info.openReal.title, "Open your real shop");
    assert.equal(info.openReal.line, "Real shops open with a code from WhatsApp. Send dashboard to PocketOga on WhatsApp, then enter the code here.");
    assert.equal(info.openReal.button, "Log in to my shop");
  });

  test("Leave the demo is the quiet button at the bottom", () => {
    assert.deepEqual(info.leave, { label: "Leave the demo", variant: "quiet" });
  });

  test("the button opens the existing login screen", () => {
    assert.match(screen, /data-part="login-to-shop" onClick=\{onLogin\}/);
    const root = read("src/Root.jsx");
    assert.match(root, /onLogin=\{exitToLogin\}/);
    const fn = root.slice(root.indexOf("function exitToLogin"), root.indexOf("useEffect(() => {\n    const onPop"));
    assert.match(fn, /history\.pushState\(null, "", "\/login"\)/);
    assert.match(fn, /setOnLogin\(true\)/);
    assert.match(fn, /savedData\.clearShop/); // the demo leaves nothing behind either
    assert.doesNotMatch(fn, /logout\(/); // the demo has no session to revoke
    assert.match(read("src/App.jsx"), /<SettingsScreen[^>]*onLogin=\{onLogin\}/);
  });
});

describe("a real shop", () => {
  const info = shopInfo(real);

  test("shows its name, 'Real shop' and Sign out, and no open-a-real-shop card", () => {
    assert.equal(info.kind, "real");
    assert.equal(info.name, "Mama Bisi Store");
    assert.equal(info.badge, "Real shop");
    assert.equal(info.openReal, null);
    assert.deepEqual(info.leave, { label: "Sign out", variant: "quiet" });
  });

  test("never says Demo or fake data", () => {
    assert.doesNotMatch(JSON.stringify(info), /demo|fake/i);
    // even if a real shop happened to be named that way, the words come from the code, not the data
    assert.doesNotMatch(JSON.stringify({ ...info, name: undefined }), /demo|fake|made-up/i);
  });

  test("the demo-only wording is only reachable through shopInfo's demo branch", () => {
    assert.doesNotMatch(screen, /Demo|fake data|made-up|Leave the demo|Open your real shop/);
  });

  test("Sign out is the existing exit: it logs out and clears this shop's saved data", () => {
    assert.match(screen, /data-part="leave"[^]*?onClick=\{onExit\}/);
    const root = read("src/Root.jsx");
    const exit = root.slice(root.indexOf("function exit()"), root.indexOf("// From the demo"));
    assert.match(exit, /savedData\.clearShop\(shop\.id\)/);
    assert.match(exit, /logout\(shop\.token\)/);
  });
});

describe("the removed card", () => {
  test("'PocketOga only suggests…' is gone from Settings (and its shield icon)", () => {
    assert.doesNotMatch(screen, /only suggests|Nothing is saved until you tap Save|ShieldCheck/);
  });

  test("the idea stays on the landing page", () => {
    const landing = ["Hero", "Trust", "FinalCta", "Footer", "HowItWorks", "Features"].flatMap((n) => {
      try {
        return [read(`src/landing/${n}.jsx`)];
      } catch {
        return [];
      }
    }).join("\n");
    assert.match(landing, /never saves|nothing is saved|you confirm|tap Save|Save/i);
  });
});

describe("Feedback inside Settings", () => {
  test("Settings contains the Feedback section component, titled Feedback", () => {
    assert.match(screen, /<FeedbackSection sectionRef=\{feedbackRef\} \/>/);
    const section = read("src/FeedbackSection.jsx");
    assert.match(section, /id="feedback-title"[^>]*>\s*Feedback\s*<\/h2>/);
    assert.match(section, /<article id="feedback"/);
  });

  test("it is a section, not a screen: no screen header, no Done button", () => {
    const section = read("src/FeedbackSection.jsx");
    assert.doesNotMatch(section, /ScreenHeader|onGo/);
  });

  test("it keeps the types, counter, mic, stars, privacy line, Send and Thank you", () => {
    const section = read("src/FeedbackSection.jsx");
    for (const needle of ["TYPE_OPTIONS.map", "counterText(form.text)", "createRecordTimer", "limitSeconds: FEEDBACK_AUDIO_MAX_SECONDS", "[1, 2, 3, 4, 5].map", "{PRIVACY_NOTE}", 'data-part="feedback-send"', "{THANKS}"]) {
      assert.ok(section.includes(needle), needle);
    }
  });

  test("it uses the shared logic and format files", () => {
    const section = read("src/FeedbackSection.jsx");
    assert.match(section, /from "\.\/feedback\.js"/);
    assert.match(section, /sendFeedback/);
    assert.match(read("src/feedback.js"), /from "\.\/feedbackFormat\.js"/);
  });
});

describe("layout", () => {
  test("every card is one full-width column of the page grid, so nothing is wider than the screen", () => {
    assert.match(screen, /<section data-part="settings" className="grid gap-4">/);
    assert.doesNotMatch(screen, /fixed|absolute|w-\[\d+px\]|min-w-\[/);
  });

  test("the page's bottom padding (dock, mic, safe area) is the app's, unchanged", () => {
    assert.match(read("src/App.jsx"), /pb-\[calc\(152px\+max\(env\(safe-area-inset-bottom\),16px\)\)\]/);
  });

  test("only theme tokens, so light and dark both work", () => {
    for (const file of ["src/screens/SettingsScreen.jsx", "src/FeedbackSection.jsx"]) {
      assert.doesNotMatch(read(file), /#[0-9a-fA-F]{3,6}\b|bg-white|text-black|bg-black|text-white/, file);
    }
  });
});
