// Web tests for the link preview card (WhatsApp, X, LinkedIn): the static tags in
// index.html, the 1200x630 image, and that the server hands the image out and
// keeps index.html uncached. Crawlers do not run JavaScript, so everything is
// checked in the files themselves.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const { createStaticHandler } = await import("../../server.mjs");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const imagePath = new URL("../public/og-image.png", import.meta.url);
const SITE = "https://pocket-oga.onrender.com";
const TITLE = "PocketOga: know where your shop money dey go";
const DESCRIPTION = "Talk to it on WhatsApp like you talk to your customers. It writes your sales, debts and stock, and you confirm every entry.";

const meta = (attr, name) => html.match(new RegExp(String.raw`<meta\s+${attr}="${name}"\s+content="([^"]*)"`))?.[1];

describe("the tags in index.html", () => {
  test("title and description, with the landing page wording", () => {
    assert.equal(html.match(/<title>([^<]*)<\/title>/)[1], TITLE);
    assert.equal(meta("name", "description"), DESCRIPTION);
    const hero = readFileSync(new URL("../src/landing/Hero.jsx", import.meta.url), "utf8").replace(/\s+/g, " ");
    assert.ok(hero.includes(DESCRIPTION), "the description is the hero's own sentence");
  });

  test("Open Graph tags", () => {
    assert.equal(meta("property", "og:type"), "website");
    assert.equal(meta("property", "og:site_name"), "PocketOga");
    assert.equal(meta("property", "og:title"), TITLE);
    assert.equal(meta("property", "og:description"), DESCRIPTION);
    assert.equal(meta("property", "og:url"), `${SITE}/`);
    assert.equal(meta("property", "og:image"), `${SITE}/og-image.png`);
    assert.equal(meta("property", "og:image:width"), "1200");
    assert.equal(meta("property", "og:image:height"), "630");
    assert.match(meta("property", "og:image:alt"), /\S{3,}/);
  });

  test("Twitter (X) card", () => {
    assert.equal(meta("name", "twitter:card"), "summary_large_image");
    assert.equal(meta("name", "twitter:title"), TITLE);
    assert.equal(meta("name", "twitter:description"), DESCRIPTION);
    assert.equal(meta("name", "twitter:image"), `${SITE}/og-image.png`);
  });

  test("every URL in the preview tags is an absolute https URL", () => {
    const urls = [...html.matchAll(/<meta\s+(?:property|name)="(?:og:url|og:image|twitter:image)"\s+content="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(urls.length, 3);
    for (const u of urls) assert.match(u, /^https:\/\/[^/]+\//, u);
  });

  test("the tags are static in the file, not added by React", () => {
    assert.ok(html.indexOf('property="og:image"') < html.indexOf("</head>"));
    assert.doesNotMatch(readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8"), /og:image|twitter:/);
  });
});

describe("public/og-image.png", () => {
  const png = readFileSync(imagePath);

  test("is a real PNG (not SVG or webp), exactly 1200x630", () => {
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
  });

  test("is under 300 KB", () => {
    assert.ok(statSync(imagePath).size < 300 * 1024, `${statSync(imagePath).size} bytes`);
  });
});

describe("what the server does", () => {
  const dir = mkdtempSync(join(tmpdir(), "og-serve-"));
  copyFileSync(imagePath, join(dir, "og-image.png"));
  copyFileSync(new URL("../index.html", import.meta.url), join(dir, "index.html"));
  const serve = createStaticHandler(dir);

  const get = (url, method = "GET") => {
    const out = { status: null, headers: null };
    const res = { writeHead: (s, h) => Object.assign(out, { status: s, headers: h }), end: () => {} };
    const handled = serve({ url, method, headers: {} }, res);
    return { handled, ...out };
  };

  test("GET /og-image.png is 200 with an image content-type", () => {
    const r = get("/og-image.png");
    assert.equal(r.handled, true);
    assert.equal(r.status, 200);
    assert.equal(r.headers["Content-Type"], "image/png");
    assert.equal(Number(r.headers["Content-Length"]), statSync(imagePath).size);
  });

  test("index.html (and the page at /) stay no-cache", () => {
    for (const url of ["/", "/index.html", "/accuracy"]) {
      const r = get(url);
      assert.equal(r.status, 200, url);
      assert.equal(r.headers["Cache-Control"], "no-cache, max-age=0, must-revalidate", url);
    }
  });

  test("the image itself may be cached for a day (not immutable: a new card must show up)", () => {
    assert.equal(get("/og-image.png").headers["Cache-Control"], "public, max-age=86400");
  });

  test("cleanup", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
