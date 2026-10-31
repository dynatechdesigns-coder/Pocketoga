// Web tests for the Install row: which environments show it, what the browser
// prompt does, and that a failure never throws into the app.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const I = await import("../src/install.js");

const UA = {
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1",
  iphoneFirefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
  iphoneFacebook: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]",
  ipadSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  desktopFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
};

describe("iOS Safari detection", () => {
  test("iPhone and iPad Safari yes; other iOS browsers and in-app views no", () => {
    assert.equal(I.isIosSafari({ ua: UA.iphoneSafari, platform: "iPhone" }), true);
    assert.equal(I.isIosSafari({ ua: UA.ipadSafari, platform: "MacIntel", maxTouchPoints: 5 }), true); // iPadOS says Macintosh
    for (const ua of [UA.iphoneChrome, UA.iphoneFirefox, UA.iphoneFacebook]) assert.equal(I.isIosSafari({ ua, platform: "iPhone" }), false, ua);
  });

  test("Mac Safari (no touch), Android and desktop are not iOS", () => {
    assert.equal(I.isIosSafari({ ua: UA.macSafari, platform: "MacIntel", maxTouchPoints: 0 }), false);
    assert.equal(I.isIosSafari({ ua: UA.androidChrome, platform: "Linux armv8l", maxTouchPoints: 5 }), false);
    assert.equal(I.isIosSafari({ ua: UA.desktopFirefox, platform: "Win32" }), false);
    assert.equal(I.isIosSafari({}), false);
  });
});

describe("which environments show the row", () => {
  test("Chrome with a captured prompt: the install dialog row", () => {
    assert.equal(I.rowKind({ hasPrompt: true }), "prompt");
  });

  test("iPhone or iPad Safari: the steps row", () => {
    assert.equal(I.rowKind({ iosSafari: true }), "ios");
  });

  test("a browser with neither: no row", () => {
    assert.equal(I.rowKind({}), null);
    assert.equal(I.rowKind({ hasPrompt: false, iosSafari: false }), null);
  });

  test("already installed and running standalone: no row, whichever kind", () => {
    assert.equal(I.rowKind({ standalone: true, hasPrompt: true }), null);
    assert.equal(I.rowKind({ standalone: true, iosSafari: true }), null);
  });

  test("after the appinstalled event: no row", () => {
    assert.equal(I.rowKind({ installed: true, hasPrompt: true }), null);
  });

  test("readEnvironment: standalone by display-mode or by iOS navigator.standalone", () => {
    const win = (matches, standalone) => ({ matchMedia: () => ({ matches }), navigator: { userAgent: UA.iphoneSafari, platform: "iPhone", standalone } });
    assert.equal(I.readEnvironment(win(true, undefined)).standalone, true);
    assert.equal(I.readEnvironment(win(false, true)).standalone, true);
    assert.equal(I.readEnvironment(win(false, undefined)).standalone, false);
    assert.equal(I.readEnvironment(win(false, undefined)).iosSafari, true);
  });

  test("readEnvironment never throws, even with broken browser objects", () => {
    const broken = { matchMedia: () => { throw new Error("no"); }, get navigator() { throw new Error("no"); } };
    assert.deepEqual(I.readEnvironment(broken), { standalone: false, iosSafari: false });
    assert.deepEqual(I.readEnvironment(undefined), { standalone: false, iosSafari: false });
  });
});

describe("the store and the prompt", () => {
  const env = (extra = {}) => () => ({ standalone: false, iosSafari: false, ...extra });
  const fakeEvent = (outcome = "accepted") => {
    const e = { prevented: false, prompts: 0, preventDefault() { this.prevented = true; }, prompt() { this.prompts++; return Promise.resolve(); }, userChoice: Promise.resolve({ outcome }) };
    return e;
  };

  test("captures beforeinstallprompt early, and the row appears", () => {
    const s = I.createInstallStore({ env: env() });
    assert.equal(s.kind(), null);
    const e = fakeEvent();
    s.capture(e);
    assert.equal(e.prevented, true);
    assert.equal(s.kind(), "prompt");
  });

  test("tapping the row calls prompt() once; an accepted install hides the row", async () => {
    const s = I.createInstallStore({ env: env() });
    const e = fakeEvent("accepted");
    s.capture(e);
    assert.equal(await s.prompt(), "accepted");
    assert.equal(e.prompts, 1);
    assert.equal(s.kind(), null);
  });

  test("a dismissed prompt drops the used event, so the row goes until the browser offers it again", async () => {
    const s = I.createInstallStore({ env: env() });
    s.capture(fakeEvent("dismissed"));
    assert.equal(await s.prompt(), "dismissed");
    assert.equal(s.kind(), null);
    s.capture(fakeEvent());
    assert.equal(s.kind(), "prompt");
  });

  test("appinstalled hides the row", () => {
    const s = I.createInstallStore({ env: env() });
    s.capture(fakeEvent());
    s.markInstalled();
    assert.equal(s.kind(), null);
  });

  test("a prompt that throws gives 'failed' and does not throw", async () => {
    const s = I.createInstallStore({ env: env() });
    s.capture({ preventDefault() {}, prompt: () => Promise.reject(new Error("boom")), userChoice: Promise.resolve({}) });
    assert.equal(await s.prompt(), "failed");
    assert.equal(await s.prompt(), "failed"); // nothing left to prompt
  });

  test("a broken event never throws from capture", () => {
    const s = I.createInstallStore({ env: env() });
    assert.doesNotThrow(() => s.capture({ preventDefault() { throw new Error("x"); } }));
  });

  test("listeners hear the prompt arrive and the install finish", async () => {
    const s = I.createInstallStore({ env: env() });
    let n = 0;
    s.subscribe(() => n++);
    s.capture(fakeEvent());
    await s.prompt();
    assert.equal(n, 2);
  });

  test("startInstallCapture wires both events and survives a window that throws", () => {
    const added = [];
    I.startInstallCapture({ addEventListener: (t) => added.push(t) });
    assert.deepEqual(added, ["beforeinstallprompt", "appinstalled"]);
  });

  test("iOS steps are plain words", () => {
    assert.match(I.IOS_STEPS[0], /Share button/);
    assert.match(I.IOS_STEPS[1], /Add to Home Screen/);
  });
});
