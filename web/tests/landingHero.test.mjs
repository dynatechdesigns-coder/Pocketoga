// Web tests for the landing hero: the two buttons, the honest early-access
// wording, and the contact link. Fake data only; the hero is checked from its
// source, the same way the other screen tests do.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const C = await import("../src/landing/heroCopy.js");
const config = await import("../src/config.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const hero = read("src/landing/Hero.jsx");

describe("buttons", () => {
  test("primary 'Try the demo shop' opens the demo", () => {
    assert.equal(C.DEMO_BUTTON, "Try the demo shop");
    assert.match(hero, /data-part="hero-demo"[^]*?onClick=\{onDemo\}/);
  });

  test("'Log in to my shop' sits right under it, as a visible button that opens the login screen", () => {
    assert.equal(C.LOGIN_BUTTON, "Log in to my shop");
    assert.match(hero, /data-part="hero-login" variant="outline"[^]*?onClick=\{onLogin\}/);
    assert.ok(hero.indexOf('data-part="hero-demo"') < hero.indexOf('data-part="hero-login"'));
    assert.ok(hero.indexOf('data-part="hero-login"') < hero.indexOf('data-part="hero-contact"'));
    // stacked, one column at every width
    assert.match(hero, /rise\(3, "grid w-full max-w-sm gap-3"\)/);
    // the landing passes the same login handler the nav uses
    assert.match(read("src/screens/Landing.jsx"), /<Hero onDemo=\{demo\} onLogin=\{onLogin\} \/>/);
    assert.match(read("src/landing/Nav.jsx"), /data-part="nav-login"/); // still in the nav too
  });

  test("'Start on WhatsApp' is gone from the hero, and so is the wa.me link (the number cannot reply)", () => {
    assert.doesNotMatch(hero, /Start on WhatsApp|WHATSAPP_LINK|hero-whatsapp|wa\.me/);
    assert.equal(config.WHATSAPP_NUMBER, "2340000000000"); // still the placeholder: no direct chat link from the landing page
  });
});

describe("early-access wording", () => {
  test("the line under the buttons, word for word", () => {
    assert.equal(`${C.CONTACT_LINE} ${C.CONTACT_LINK_TEXT}`, "Using WhatsApp? Early access is invite-only while we test. Ask to be added on WhatsApp");
    assert.match(hero, /data-part="hero-contact" className="[^"]*text-sm[^"]*text-muted/); // smaller, quiet
  });

  test("an 'Early access' pill near the top, above the headline", () => {
    assert.equal(C.EARLY_ACCESS_PILL, "Early access");
    assert.match(hero, /data-part="early-access"/);
    assert.ok(hero.indexOf('data-part="early-access"') < hero.indexOf('id="hero-h"'));
  });

  test("no claim that anyone can sign up today, and no customers, numbers or reviews", () => {
    const words = [C.EARLY_ACCESS_PILL, C.CONTACT_LINE, C.CONTACT_LINK_TEXT, C.LOGIN_BUTTON, C.DEMO_BUTTON].join(" ");
    assert.doesNotMatch(words, /sign up|join now|get started|free|\d{2,}|customers|reviews|rated|trusted by|stars/i);
  });

  test("the three checkmark lines and the demo phone picture are unchanged", () => {
    assert.match(hero, /const TICKS = \["Works with voice notes", "Pidgin and English", "Nothing saved without your OK"\];/);
    assert.match(hero, /data-part="hero-phone"/);
    assert.match(hero, /<WebMoney updated reduced \/>/);
  });
});

describe("contact link", () => {
  test("CONTACT_URL lives in config.js, and is the only place to set it", () => {
    assert.equal(typeof config.CONTACT_URL, "string");
    assert.match(read("src/config.js"), /export const CONTACT_URL = /);
    assert.doesNotMatch(hero, /https?:\/\//);
    assert.match(read("src/landing/heroCopy.js"), /from "\.\.\/config\.js"/);
  });

  test("CONTACT_URL is the WhatsApp early-access link, and the hero link uses it", () => {
    assert.equal(config.CONTACT_URL, "https://wa.me/2348053801610?text=Hi%2C%20I%27d%20like%20early%20access%20to%20PocketOga");
    assert.equal(C.contactHref(), config.CONTACT_URL);
    assert.equal(C.CONTACT_LINK_TEXT, "Ask to be added on WhatsApp");
    assert.equal((read("src/config.js").match(/2348053801610/g) ?? []).length, 1); // one constant, one place
  });

  test("not set: the sentence shows with no link", () => {
    assert.equal(C.contactHref(""), null);
    assert.equal(C.contactHref("   "), null);
  });

  test("set to a web, WhatsApp or mail link: it becomes the 'Ask to be added.' link", () => {
    assert.equal(C.contactHref("https://wa.me/message/ABC"), "https://wa.me/message/ABC");
    assert.equal(C.contactHref(" mailto:hello@example.com "), "mailto:hello@example.com");
    assert.match(hero, /contact \? \(\s*<a href=\{contact\}[^]*?\{CONTACT_LINK_TEXT\}/);
  });

  test("anything else is refused (no javascript: links)", () => {
    assert.equal(C.contactHref("javascript:alert(1)"), null);
    assert.equal(C.contactHref("wa.me/123"), null);
  });
});

describe("narrow screens and themes", () => {
  test("nothing in the hero text column is wider than the screen; long text wraps", () => {
    assert.match(hero, /max-w-sm/);
    assert.match(hero, /\[overflow-wrap:anywhere\]/);
    assert.match(hero, /flex flex-wrap gap-2/); // the two pills wrap instead of overflowing at 320px
    assert.match(hero, /overflow-x-clip/);
  });

  test("only theme tokens in the new markup, so light and dark both work", () => {
    const block = hero.slice(hero.indexOf('data-part="early-access"') - 200, hero.indexOf('data-part="ticks"'));
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,6}\b|bg-white|text-black|bg-black|text-white/);
  });
});
