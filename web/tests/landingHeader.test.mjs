// Web tests for the landing header: one row that never pushes past the right
// edge at 320, 360 and 390px, even with a large system font. The logo text
// shrinks and truncates first; the menu button, theme button and "Try demo"
// stay. There is no browser here, so the markup is checked from its source and
// the row's width budget is worked out from the sizes it declares.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const nav = read("src/landing/Nav.jsx");
const parts = read("src/landing/parts.jsx");
const ui = read("src/ui.jsx");

describe("markup guards", () => {
  test("the logo link and its text can shrink and the text truncates", () => {
    const logo = nav.match(/aria-label="PocketOga home"\s*className="([^"]*)"/)[1];
    assert.match(logo, /\bmin-w-0\b/);
    assert.match(logo, /\bshrink\b/);
    assert.doesNotMatch(logo, /\bshrink-0\b|\bw-\[|\bmin-w-\[/);
    assert.match(nav, /<span className="min-w-0 truncate">PocketOga<\/span>/);
    assert.match(nav, /<img src="\/icon\.svg"[^>]*className="size-9 shrink-0 /); // the icon itself never squashes
  });

  test("the right-hand cluster, the menu button, the theme button and Try demo never shrink or wrap", () => {
    assert.match(nav, /<div className="flex shrink-0 items-center gap-2 max-\[399px\]:gap-1\.5">/);
    assert.match(nav, /<div ref=\{menu\} className="shrink-0 lg:hidden">/);
    assert.match(ui, /data-part="theme-toggle"[^]*?grid size-12 shrink-0/);
    assert.match(nav, /data-part="nav-demo"[^]*?className="w-auto whitespace-nowrap/);
  });

  test("the short 'Try demo' label shows on small phones and the long one from 400px", () => {
    assert.match(nav, /<span className="max-\[399px\]:hidden">Try the demo shop<\/span>/);
    assert.match(nav, /<span className="min-\[400px\]:hidden">Try demo<\/span>/);
  });

  test("the header row is a single flex row that does not wrap, inside the page gutter", () => {
    assert.match(nav, /<Container className="flex h-16 items-center justify-between gap-2 max-\[399px\]:gap-1\.5">/);
    assert.doesNotMatch(nav, /flex-wrap|overflow-x-(auto|scroll)|w-screen|w-\[100vw\]/);
    assert.match(parts, /mx-auto w-full max-w-\[1200px\] px-5 md:px-8/);
  });

  test("the section links and the wide-screen login only appear from lg, so phones never carry them", () => {
    assert.match(nav, /<nav aria-label="Sections" className="hidden items-center gap-1 lg:flex">/);
    assert.match(nav, /data-part="nav-login"[^]*?className="hidden [^"]*lg:inline-flex"/);
  });
});

describe("width budget (CSS px, with the logo text squeezed to nothing)", () => {
  const GUTTER = 20; // px-5 each side below 768px
  const ICON = 36; // the logo icon, always kept
  const MENU = 44; // size-11 below 400px
  const THEME = 44; // size-11 below 400px
  const GAP = 6; // gap-1.5 below 400px
  // "Try demo" at text-sm: about 8 characters of 7.5px, px-2.5 each side, 1.5px borders.
  const demo = (fontScale) => Math.ceil(8 * 7.5 * fontScale) + 20 + 3;

  for (const width of [320, 360, 390]) {
    for (const fontScale of [1, 1.3, 1.5]) {
      test(`${width}px at ${fontScale}x system font: icon + menu + theme + Try demo fit in the row`, () => {
        const inner = width - 2 * GUTTER;
        const cluster = MENU + THEME + demo(fontScale) + 2 * GAP;
        const needed = ICON + GAP + cluster; // logo icon, gap, the right-hand cluster
        assert.ok(needed <= inner, `${needed}px needed, ${inner}px available`);
      });
    }
  }

  test("the sizes used in the budget are the ones in the markup", () => {
    assert.match(nav, /max-\[399px\]:size-11/); // menu button
    assert.match(nav, /<ThemeToggle className="max-\[399px\]:size-11" \/>/);
    assert.match(nav, /max-\[399px\]:px-2\.5 max-\[399px\]:text-sm/);
  });
});
