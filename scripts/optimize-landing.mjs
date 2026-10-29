#!/usr/bin/env node
// Optimize PocketOga landing-page photos: back each .webp up into _originals/
// once, then resize and re-encode it to fit the 200 KB budget.
//
// Safe to run twice: output is always compressed from the _originals/ copy,
// never from an already-compressed file.
//
// Usage (never runs automatically; run it yourself):
//   node scripts/optimize-landing.mjs

import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const MAX_BYTES = 200 * 1024; // 200 KB budget per file
const START_QUALITY = 78;
const MIN_QUALITY = 55;
const QUALITY_STEP = 6;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PHOTOS_DIR = path.join(ROOT, "web", "public", "landing", "photos");
const ORIGINALS_DIR = path.join(PHOTOS_DIR, "_originals");

function maxWidthFor(name) {
  if (name === "hero-trader" || name === "market-lane") return 1200;
  if (name.startsWith("shop-") || name === "hands-notebook" || name === "voice-note") return 900;
  if (name.startsWith("goods-")) return 600;
  return 900; // any other file: middle default, never enlarged anyway
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(ORIGINALS_DIR, { recursive: true });
  const entries = await readdir(PHOTOS_DIR, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".webp"))
    .map((e) => e.name)
    .sort();
  if (files.length === 0) {
    console.log(`No .webp files in web/public/landing/photos/.`);
    return;
  }

  let over = 0;
  for (const file of files) {
    const name = path.basename(file, path.extname(file));
    const dest = path.join(PHOTOS_DIR, file);
    const orig = path.join(ORIGINALS_DIR, file);
    if (!(await exists(orig))) await copyFile(dest, orig); // back up once
    const before = (await stat(dest)).size;
    const input = await readFile(orig); // always compress from the original
    const maxWidth = maxWidthFor(name);

    let out = null;
    let quality = START_QUALITY;
    for (;;) {
      out = await sharp(input)
        .resize({ width: maxWidth, withoutEnlargement: true })
        .webp({ quality })
        .toBuffer();
      if (out.length <= MAX_BYTES || quality <= MIN_QUALITY) break;
      quality = Math.max(MIN_QUALITY, quality - QUALITY_STEP);
    }
    await writeFile(dest, out);
    const after = out.length;
    const flag = after > MAX_BYTES ? " OVER 200 KB" : "";
    if (flag) over++;
    console.log(`[${after > MAX_BYTES ? "OVER" : "ok"}] ${file} — ${kb(before)} -> ${kb(after)} (max ${maxWidth}px, q${quality})${flag}`);
  }

  console.log(`\n${files.length} optimized, ${over} still over 200 KB.`);
  if (over > 0) process.exit(1);
}

await main();
