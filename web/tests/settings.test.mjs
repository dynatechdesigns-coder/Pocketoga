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
  test("Theme, Your shop, Install, the leave row, then Send feedback last", () => {
    assert.deepEqual(SETTINGS_ORDER, ["theme", "shop", "install", "leave", "feedback"]);
    const at = (needle) => {
      const i = screen.indexOf(needle);
      assert.ok(i >= 0, needle);
      return i;
    };
    const order = [at('data-part="settings-theme"'), at('data-part="settings-shop"'), at('data-part="settings-install"'), at('data-part="leave"'), at("<FeedbackSection")];
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });

  test("the leave row sits directly above the Send feedback card, and nothing comes after the card", () => {
    const between = screen.slice(screen.indexOf('data-part="leave"'), screen.indexOf("<FeedbackSection"));
    assert.doesNotMatch(between, /<Card|<InstallRow|<textarea|<FeedbackSection[^]*<FeedbackSection/);
    const tail = screen.slice(screen.indexOf("<FeedbackSection"));
    assert.doesNotMatch(tail, /data-part="leave"|login-to-shop|<Button|<Card|<InstallRow/);
  });

  test("the Your shop card has no button in it and its title is on one line", () => {
    const card = screen.slice(screen.indexOf('id="your-shop-title"') - 120, screen.indexOf("{info.openReal &&"));
    assert.doesNotMatch(card, /<Button|onExit|onLogin|LogOut/);
    assert.match(card, /<SectionTitle as="h2" id="your-shop-title" className="[^"]*whitespace-nowrap"/);
    // the title has its own row: not a flex row shared with anything else
    assert.doesNotMatch(card, /justify-between/);
    assert.match(card, /Your shop/);
    assert.match(card, /info\.name/);
    assert.match(card, /info\.badge/);
    assert.match(card, /info\.line/);
  });

  test("Leave the demo / Sign out is its own full-width secondary row, a 48px tap target", () => {
    const leave = screen.match(/<Button data-part="leave" variant=\{info\.leave\.variant\} className="([^"]*)" onClick=\{onExit\}>/);
    assert.ok(leave, "the leave button");
    assert.match(leave[1], /\bw-full\b/);
    assert.doesNotMatch(leave[1], /\bw-auto\b|\bw-\[|min-w-|shrink-0|whitespace-nowrap/);
    assert.equal(shopInfo(demo).leave.variant, "quiet"); // secondary, not the primary button
    assert.equal(shopInfo(real).leave.variant, "quiet");
    assert.doesNotMatch(screen.match(/<Button data-part="leave"[^>]*>/)[0], /size="sm"/); // the default size has min-h-12
    // the shared Button is 48px high and full width unless told otherwise
    const ui = read("src/ui.jsx");
    assert.match(ui, /inline-flex min-h-12 w-full items-center justify-center/);
    assert.match(ui, /md: "px-5 py-3 text-base"/);
  });

  test("the Install list hides itself when empty", () => {
    assert.match(screen, /data-part="settings-install" className="[^"]*empty:hidden/);
  });
});

describe("no overflow, no squeezed titles", () => {
  test("the page is one column that can shrink below its content (minmax(0, 1fr)), so nothing is wider than the margins", () => {
    assert.match(screen, /<section data-part="settings" className="grid grid-cols-\[minmax\(0,1fr\)\] gap-4">/);
    assert.match(screen, /data-part="settings-shop"[^>]*className="grid grid-cols-\[minmax\(0,1fr\)\] gap-4"/);
  });

  test("every Settings card can shrink (min-w-0) and wraps long text", () => {
    for (const marker of ['data-part="settings-theme"', 'data-part="open-real-shop"']) {
      const tag = screen.slice(screen.lastIndexOf("<Card", screen.indexOf(marker)), screen.indexOf(">", screen.indexOf(marker)));
      assert.match(tag, /min-w-0/, marker);
    }
    assert.match(screen, /<Card as="article" className="grid min-w-0 gap-3">/); // Your shop
    assert.match(screen, /\[overflow-wrap:anywhere\]/);
    const feedback = read("src/FeedbackSection.jsx");
    assert.match(feedback, /min-w-0 flex-1/); // the Send feedback title column can shrink beside its chevron
  });

  test("titles that sit next to something can shrink; titles that must stay on one line say so", () => {
    assert.match(screen, /id="your-shop-title" className="mt-0 whitespace-nowrap"/);
    assert.match(screen, /<div className="flex min-w-0 items-center gap-3">\s*<IconCircle/); // Open your real shop: icon + title
    assert.match(screen, /<div className="flex min-w-0 items-center gap-4">\s*<Avatar/); // avatar + name
    assert.match(screen, /<div className="grid min-w-0 gap-1">/);
  });

  test("no fixed widths, no absolute or fixed positions, no horizontal scrolling inside Settings", () => {
    assert.doesNotMatch(screen, /\bw-\[\d|\bmin-w-\[|\bfixed\b|\babsolute\b|overflow-x-(auto|scroll)|whitespace-nowrap[^"]*"[^>]*>\s*<LogOut/);
  });

  test("the cards use the page's own gutter and nothing adds margins that could push past it", () => {
    assert.doesNotMatch(screen, /\b-?m[xlr]-\d|\bpx-\d|\bw-screen\b|\bw-\[100vw\]/);
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

  test("Leave the demo is the quiet button, its own row", () => {
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
  const section = read("src/FeedbackSection.jsx");

  test("Settings contains the compact Feedback card, folded until tapped", () => {
    assert.match(screen, /<FeedbackSection sectionRef=\{feedbackRef\} open=\{feedbackOpen\}/);
    assert.match(section, /<article id="feedback"/);
    assert.match(section, /<span>Send feedback<\/span>/);
  });

  test("it is a card, not a screen: no screen header, no Done button", () => {
    assert.doesNotMatch(section, /ScreenHeader|onGo/);
  });

  test("it uses the shared logic and format files", () => {
    assert.match(section, /from "\.\/feedback\.js"/);
    assert.match(section, /sendFeedback/);
    assert.match(read("src/feedback.js"), /from "\.\/feedbackFormat\.js"/);
  });
});

describe("layout", () => {
  test("every card is one full-width column of the page grid, so nothing is wider than the screen", () => {
    assert.match(screen, /<section data-part="settings" className="grid grid-cols-\[minmax\(0,1fr\)\] gap-4">/);
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
