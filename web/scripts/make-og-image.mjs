// Dev-only: makes public/og-image.png, the 1200x630 preview card WhatsApp, X and
// LinkedIn show when the link is shared. Not part of the build.
//
//   node scripts/make-og-image.mjs
//
// It draws a small HTML page to a canvas in a headless Chrome or Edge (found on
// this machine) and writes the PNG the page hands back. The picture is the
// landing hero photo (AI-generated, no real person), a dark overlay, the mic
// logo, the headline and one line. No real data. Text stays in the central area
// because WhatsApp crops the edges.
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const OUT = join(root, "public/og-image.png");
export const WIDTH = 1200;
export const HEIGHT = 630;
export const MAX_BYTES = 300 * 1024;

const BROWSERS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const dataUrl = (file, mime) => `data:${mime};base64,${readFileSync(join(root, file)).toString("base64")}`;

// The page: it draws the card on a canvas and prints the PNG as a data URL.
function template(blur, keep) {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0"><pre id="out"></pre><script>
const W = ${WIDTH}, H = ${HEIGHT};
const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
(async () => {
  const [photo, logo] = await Promise.all([load(${JSON.stringify(dataUrl("public/landing/photos/hero-trader.webp", "image/webp"))}), load(${JSON.stringify(dataUrl("public/icon.svg", "image/svg+xml"))})]);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d");
  // Photo, covering the card; a soft blur keeps the PNG small and the text clear.
  const s = Math.max(W / photo.width, H / photo.height);
  x.filter = "blur(${blur}px)";
  x.drawImage(photo, (W - photo.width * s) / 2, (H - photo.height * s) / 2, photo.width * s, photo.height * s);
  x.filter = "none";
  // Dark overlay, darker on the left where the words are.
  const g = x.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, "rgba(13,13,30,0.9)");
  g.addColorStop(1, "rgba(13,13,30,0.4)");
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // Keep only the top bits of each colour in the background: smooth, flat areas
  // make a much smaller PNG, and the text and logo are drawn on top, sharp.
  const px = x.getImageData(0, 0, W, H);
  const mask = 0xff << (8 - ${keep});
  for (let i = 0; i < px.data.length; i += 4) { px.data[i] &= mask; px.data[i + 1] &= mask; px.data[i + 2] &= mask; }
  x.putImageData(px, 0, 0);
  // Everything below sits inside x 100..1100 and y 90..540.
  x.drawImage(logo, 100, 110, 120, 120);
  x.fillStyle = "#ffffff"; x.textBaseline = "alphabetic";
  x.font = "800 96px 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
  x.fillText("Talk to your books", 100, 370);
  x.fillStyle = "#ffd36b";
  x.font = "700 46px 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
  x.fillText("Voice bookkeeping for Nigerian traders", 100, 450);
  x.fillStyle = "rgba(255,255,255,0.85)";
  x.font = "800 34px 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
  x.fillText("PocketOga", 244, 190);
  // Raw pixels back to the script, which writes a tightly compressed PNG.
  const d = x.getImageData(0, 0, W, H).data;
  let bin = ""; for (let i = 0; i < d.length; i += 4) bin += String.fromCharCode(d[i], d[i + 1], d[i + 2]);
  document.getElementById("out").textContent = "RGB:" + btoa(bin);
})();
</script>`;
}

// 8-bit RGB PNG with the best of the five row filters per row and zlib level 9.
function encodePng(rgb) {
  const stride = WIDTH * 3;
  const raw = Buffer.alloc((stride + 1) * HEIGHT);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < HEIGHT; y++) {
    let best = null;
    for (let f = 0; f < 5; f++) {
      const row = Buffer.alloc(stride);
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const cur = rgb[y * stride + i];
        const left = i >= 3 ? rgb[y * stride + i - 3] : 0;
        const up = y > 0 ? rgb[(y - 1) * stride + i] : 0;
        const ul = y > 0 && i >= 3 ? rgb[(y - 1) * stride + i - 3] : 0;
        const pred = f === 0 ? 0 : f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : paeth(left, up, ul);
        const v = (cur - pred) & 255;
        row[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (!best || sum < best.sum) best = { f, row, sum };
    }
    raw[y * (stride + 1)] = best.f;
    best.row.copy(raw, y * (stride + 1) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function render(browser, html) {
  const dir = mkdtempSync(join(tmpdir(), "og-"));
  try {
    const page = join(dir, "card.html");
    writeFileSync(page, html);
    const out = execFileSync(
      browser,
      ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--virtual-time-budget=8000", `--user-data-dir=${join(dir, "profile")}`, "--dump-dom", pathToFileURL(page).href],
      { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }
    );
    const m = /RGB:([A-Za-z0-9+/=]+)/.exec(out);
    if (!m) throw new Error("the browser did not return a picture");
    return encodePng(Buffer.from(m[1], "base64"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const browser = BROWSERS.find((b) => existsSync(b));
if (!browser) {
  console.error("No Chrome or Edge found. Install one, or add its path to BROWSERS in this file.");
  process.exit(1);
}
let png;
// Lightest settings first (most of the photo kept); stop at the first that fits.
for (const [blur, keep] of [[3, 5], [4, 4], [6, 4], [10, 3]]) {
  png = render(browser, template(blur, keep));
  console.log(`blur ${blur}px, ${keep} bits: ${(png.length / 1024).toFixed(0)} KB`);
  if (png.length <= MAX_BYTES) break;
}
writeFileSync(OUT, png);
const w = png.readUInt32BE(16);
const h = png.readUInt32BE(20);
console.log(`wrote public/og-image.png: ${w}x${h}, ${(png.length / 1024).toFixed(0)} KB`);
if (w !== WIDTH || h !== HEIGHT || png.length > MAX_BYTES) process.exit(1);
