// The landing image slots resolve as promised.
//
//   npm run check:images
//
// 1. With a throwaway folder: a photo wins over an illustration, an
//    illustration is used when there is no photo, shop-* slots never fall back
//    to an illustration, and a slot with neither is left out.
// 2. The real public/ folder: prints which slots use photos, illustrations or
//    nothing, and checks every resolved image has a size.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SLOTS, resolveLandingImages } from "./landing-images.mjs";

const problems = [];
const expect = (label, ok) => ok || problems.push(label);

// 1. Throwaway folder: a 2x1 lossless WebP and a small SVG are enough.
const tmp = mkdtempSync(join(tmpdir(), "pocketoga-slots-"));
try {
  const photos = join(tmp, "landing", "photos");
  const art = join(tmp, "landing", "illustrations");
  mkdirSync(photos, { recursive: true });
  mkdirSync(art, { recursive: true });
  // A lossless WebP header for a 2x1 image (enough for the size reader).
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.writeUInt32LE(22, 4);
  webp.write("WEBPVP8L", 8, "ascii");
  webp.writeUInt32LE(10, 16);
  webp[20] = 0x2f;
  webp.writeUInt32LE((2 - 1) | ((1 - 1) << 14), 21);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300"/></svg>';
  writeFileSync(join(photos, "goods-rice.webp"), webp);
  writeFileSync(join(art, "goods-rice.svg"), svg); // a photo exists too: the photo wins
  writeFileSync(join(art, "goods-eggs.svg"), svg); // illustration only
  writeFileSync(join(art, "shop-kiosk.svg"), svg); // shop-* never uses illustrations

  const r = resolveLandingImages(tmp);
  expect("photo wins over illustration", r["goods-rice"]?.kind === "photo" && r["goods-rice"].width === 2 && r["goods-rice"].height === 1);
  expect("illustration used when there is no photo", r["goods-eggs"]?.kind === "illustration" && r["goods-eggs"].width === 400 && r["goods-eggs"].height === 300);
  expect("shop-* slots do not fall back to illustrations", !("shop-kiosk" in r));
  expect("a slot with nothing is left out", !("hero-trader" in r) && Object.keys(r).length === 2);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// 2. The real folder.
const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const real = resolveLandingImages(publicDir);
const used = (kind) => SLOTS.filter((s) => real[s]?.kind === kind);
const missing = SLOTS.filter((s) => !real[s]);
for (const [slot, img] of Object.entries(real)) expect(`${slot} has a size`, img.width > 0 && img.height > 0);
console.log(`photos (${used("photo").length}): ${used("photo").join(", ") || "none"}`);
console.log(`illustrations (${used("illustration").length}): ${used("illustration").join(", ") || "none"}`);
console.log(`left out (${missing.length}): ${missing.join(", ") || "none"}`);
for (const [slot, img] of Object.entries(real)) {
  const kb = Math.round(readFileSync(join(publicDir, img.src)).length / 1024);
  console.log(`  ${slot.padEnd(15)} ${img.kind.padEnd(12)} ${String(img.width).padStart(4)}x${String(img.height).padEnd(5)} ${kb} KB`);
}

if (problems.length) {
  console.error("FAIL: " + problems.join("; "));
  process.exitCode = 1;
} else {
  console.log("PASS: photo > illustration > left out, shop-* without illustrations, every image has a size.");
}
