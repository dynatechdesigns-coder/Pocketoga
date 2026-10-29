// Landing-page images, resolved at build time (and when the dev server starts).
//
// For every slot: public/landing/photos/<slot>.webp if it exists, otherwise
// public/landing/illustrations/<slot>.svg (not for shop-* slots), otherwise the
// slot is left out. The result is the virtual module "virtual:landing-images":
//   { "hero-trader": { src, width, height, kind: "photo" | "illustration" }, ... }
// Width and height come from the file itself, so every <img> can reserve its
// space. The browser never asks for a file that is not there.
//
// Read only: nothing in public/landing/ is written, moved or deleted.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SLOTS = [
  "hero-trader",
  "goods-rice",
  "goods-eggs",
  "goods-cartons",
  "goods-measure",
  "hands-notebook",
  "market-lane",
  "voice-note",
  "shop-provision",
  "shop-kiosk",
  "shop-counter",
  "shop-wholesale",
];

const NO_ILLUSTRATION = (slot) => slot.startsWith("shop-");

// WebP: VP8X (extended), VP8 (lossy) or VP8L (lossless) header.
export function webpSize(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

// SVG: width/height attributes, else the viewBox.
export function svgSize(text) {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? "";
  const num = (name) => Number(new RegExp(`\\b${name}="([\\d.]+)(px)?"`).exec(tag)?.[1]);
  const w = num("width");
  const h = num("height");
  if (w > 0 && h > 0) return { width: Math.round(w), height: Math.round(h) };
  const vb = /viewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/.exec(tag);
  return vb ? { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) } : null;
}

export function resolveLandingImages(publicDir) {
  const found = {};
  for (const slot of SLOTS) {
    const photo = join(publicDir, "landing", "photos", `${slot}.webp`);
    const art = join(publicDir, "landing", "illustrations", `${slot}.svg`);
    if (existsSync(photo)) {
      const size = webpSize(readFileSync(photo));
      if (size) found[slot] = { src: `/landing/photos/${slot}.webp`, ...size, kind: "photo" };
    } else if (!NO_ILLUSTRATION(slot) && existsSync(art)) {
      const size = svgSize(readFileSync(art, "utf8"));
      if (size) found[slot] = { src: `/landing/illustrations/${slot}.svg`, ...size, kind: "illustration" };
    }
  }
  return found;
}

// Vite plugin: serves the resolved slots as "virtual:landing-images".
export default function landingImages() {
  const id = "virtual:landing-images";
  let publicDir;
  return {
    name: "pocketoga-landing-images",
    configResolved(config) {
      publicDir = config.publicDir;
    },
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(source) {
      if (source !== `\0${id}`) return null;
      return `export default ${JSON.stringify(resolveLandingImages(publicDir))};`;
    },
  };
}
