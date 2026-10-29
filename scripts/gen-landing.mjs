#!/usr/bin/env node
// Generate PocketOga landing-page photos with Muse Image (Meta Model API).
//
// API shape verified against the official docs (https://dev.meta.ai/docs/image-generation):
// - Model: "muse-image-1.0"
// - Endpoint: POST https://api.meta.ai/v1/images/generations (OpenAI-compatible)
// - Auth: "Authorization: Bearer <key>"; the key here comes ONLY from
//   process.env.META_API_KEY (same secret the docs call MODEL_API_KEY).
// - Request: { model, prompt, n, size, response_format, output_format }.
//   size is a "WxH" string setting the aspect ratio only, not exact pixels.
//   output_format "webp" converts server-side, so no local codec is needed.
//   `moderation` must be omitted: muse-image-1.0 rejects it with 400.
// - Failures: 503 is retryable (retry with backoff); 500 is not; a refused
//   prompt is 400 (code content_policy_violation). Any failure skips that
//   image and the script continues with the rest.
//
// Usage (never runs automatically; run it yourself):
//   node --env-file=.env.local scripts/gen-landing.mjs [name ...]
//   node --env-file=.env.local scripts/gen-landing.mjs --only <name>
// With no names, all twelve images are generated. Example:
//   node --env-file=.env.local scripts/gen-landing.mjs hero-trader goods-rice
// --only <name> regenerates that one slot and touches no other file.
//
// Each generated image is also saved untouched to photos/_originals/, the
// folder optimize-landing.mjs compresses from, so a re-run of the optimizer
// uses the new photo instead of restoring the old one.

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = "https://api.meta.ai/v1/images/generations";
const MODEL = "muse-image-1.0";
const MAX_BYTES = 200 * 1024; // 200 KB budget per file
const TIMEOUT_MS = 180000;
const RETRIES_503 = 2; // extra attempts after the first, with backoff

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, "web", "public", "landing", "photos");
const ORIGINALS_DIR = path.join(OUT_DIR, "_originals");

const STYLE =
  "Realistic documentary photograph, natural daylight, shallow depth of field, " +
  "true-to-life colours, shot on a modern phone or mirrorless camera, in a busy " +
  "open-air market in Abuja, Nigeria. Not an illustration, not a cartoon, not 3D, not stylised.";

const RULES =
  "No brand names, logos or readable text on any goods, signs or screens. " +
  "No recognisable real people: people shown from behind, in profile, or with faces " +
  "small and out of focus. Natural hands with five fingers.";

// size sets the aspect ratio only (docs); null omits it for the API default.
const SHOTS = {
  "hero-trader":
    "A woman trader seen from the side at her market stall, a phone in her hand, " +
    "sacks of rice and crates of eggs on the counter, an orange and white striped awning above.",
  "goods-rice": "Two sacks of rice, open at the top, close up, at a market stall.",
  "goods-eggs": "Stacked crates of brown eggs at a market stall.",
  "goods-cartons": "Plain unbranded cartons stacked at a market stall, no markings or labels.",
  "goods-measure": "A paint-bucket grain measure full of beans on a market table.",
  "hands-notebook":
    "Hands holding a phone over an open handwritten ledger notebook on a market counter.",
  "market-lane":
    "A busy market lane of stalls on both sides, traders and shoppers, warm late-afternoon light.",
  "voice-note":
    "Realistic documentary photograph, close-up of a hand holding a modern smartphone in the foreground, in a busy Nigerian open-air market, " +
    "tomatoes, peppers, onions and vegetable stalls softly blurred behind, traders in colourful Ankara clothing far in the background, " +
    "the phone is held upright and its screen is turned off, dark glass with a subtle reflection of the sky, sharp focus on the phone and fingers, " +
    "warm natural daylight, shallow depth of field, natural skin, authentic, no text, no logos, no watermarks",
  "shop-provision":
    "The inside of a small provision store, shelves of plain unbranded tins, sachets, " +
    "noodles and bottled drinks, a counter in front.",
  "shop-kiosk":
    "A roadside kiosk with an umbrella and a few shelves of everyday goods, " +
    "a trader sitting behind the counter seen from the side.",
  "shop-counter":
    "A shopkeeper's counter close up: a handwritten notebook, a phone, a calculator " +
    "and a stack of naira notes, hands only, no faces.",
  "shop-wholesale":
    "A wholesale store with bags of rice, beans and cartons stacked high, a worker in the distance.",
};

const SIZES = {
  "hero-trader": "1536x1152", // landscape 4:3
  "goods-rice": "1024x1024", // square
  "goods-eggs": "1024x1024", // square
  "goods-cartons": "1024x1024", // square
  "goods-measure": "1024x1024", // square
  "hands-notebook": null, // API default ratio (brief sets none)
  "market-lane": "1792x1024", // wide
  "voice-note": "1024x1024", // square
  "shop-provision": "1536x1152", // landscape 4:3
  "shop-kiosk": "1536x1152", // landscape 4:3
  "shop-counter": "1536x1152", // landscape 4:3
  "shop-wholesale": "1536x1152", // landscape 4:3
};

// Slots whose prompt is complete as written. STYLE and RULES are not added:
// they ask for faces small and out of focus, which would fight a sharp face.
const FULL_PROMPT = new Set(["voice-note"]);

function promptFor(name) {
  if (FULL_PROMPT.has(name)) return SHOTS[name];
  return `${SHOTS[name]} ${STYLE} ${RULES}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generate(name, apiKey) {
  const body = {
    model: MODEL,
    prompt: promptFor(name),
    n: 1,
    response_format: "b64_json",
    output_format: "webp",
  };
  if (SIZES[name]) body.size = SIZES[name];
  let lastError = "";
  for (let attempt = 0; attempt <= RETRIES_503; attempt++) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      lastError = `request failed: ${err.message}${err?.cause ? ` (cause ${err.cause.code ?? "n/a"}: ${err.cause.message ?? err.cause})` : ""}`.slice(0, 400);
      break; // network/timeout: report and move on
    }
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const b64 = data?.data?.[0]?.b64_json;
      if (typeof b64 !== "string" || !b64) throw new Error("response had no image data");
      return Buffer.from(b64, "base64");
    }
    const text = await res.text().catch(() => "");
    lastError = `HTTP ${res.status}: ${text}`.slice(0, 300);
    if (res.status === 503 && attempt < RETRIES_503) {
      await sleep(2000 * (attempt + 1)); // retry with backoff, per docs
      continue;
    }
    break; // 400/500/etc: skip this image, continue with the rest
  }
  throw new Error(lastError || "generation failed");
}

// Squeeze an over-budget buffer under 200 KB, keeping the original ratio.
// Uses sharp only if the user has it installed; otherwise returns null and
// the caller keeps the original file with a warning. Never throws.
async function fitUnderBudget(buf) {
  let sharp;
  try {
    ({ default: sharp } = await import("sharp"));
  } catch {
    return null; // optional dependency absent: nothing we can do locally
  }
  try {
    for (const quality of [82, 70, 58, 45, 32]) {
      const out = await sharp(buf).webp({ quality }).toBuffer();
      if (out.length <= MAX_BYTES) return out;
    }
    const width = (await sharp(buf).metadata()).width || 1024;
    for (const w of [1024, 800, 640].filter((x) => x < width)) {
      const out = await sharp(buf).resize({ width: w }).webp({ quality: 70 }).toBuffer();
      if (out.length <= MAX_BYTES) return out;
    }
  } catch {
    return null;
  }
  return null;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  const apiKey = process.env.META_API_KEY;
  if (!apiKey) {
    console.error("META_API_KEY is not set. Run with it in the environment, e.g.:");
    console.error("  node --env-file=.env.local scripts/gen-landing.mjs [--only <name> | name ...]");
    process.exit(2);
  }
  const args = process.argv.slice(2);
  let wanted = args;
  const onlyAt = args.findIndex((a) => a === "--only" || a.startsWith("--only="));
  if (onlyAt !== -1) {
    const inline = args[onlyAt].startsWith("--only=") ? args[onlyAt].slice("--only=".length) : null;
    const slot = inline ?? args[onlyAt + 1];
    const rest = args.filter((_, i) => i !== onlyAt && !(inline === null && i === onlyAt + 1));
    if (!slot || slot.startsWith("--") || rest.length > 0) {
      console.error("Usage: gen-landing.mjs --only <name>   (one slot, no other names)");
      process.exit(2);
    }
    wanted = [slot];
  }
  const unknown = wanted.filter((n) => !(n in SHOTS));
  if (unknown.length > 0) {
    console.error(`Unknown image name(s): ${unknown.join(", ")}`);
    console.error(`Valid names: ${Object.keys(SHOTS).join(", ")}`);
    process.exit(2);
  }
  const names = wanted.length > 0 ? wanted : Object.keys(SHOTS);
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(ORIGINALS_DIR, { recursive: true });

  const made = [];
  const failed = [];
  for (const name of names) {
    const rel = `web/public/landing/photos/${name}.webp`;
    const file = path.join(OUT_DIR, `${name}.webp`);
    try {
      let buf = await generate(name, apiKey);
      await writeFile(path.join(ORIGINALS_DIR, `${name}.webp`), buf); // untouched copy for the optimizer
      let over = false;
      if (buf.length > MAX_BYTES) {
        const fit = await fitUnderBudget(buf);
        if (fit) buf = fit;
        else over = true;
      }
      await writeFile(file, buf);
      const size = (await stat(file)).size;
      over = over || size > MAX_BYTES;
      made.push({ rel, size, over });
      console.log(`[made] ${rel} — ${kb(size)}${over ? " (OVER 200 KB: API output, no local re-encode available)" : ""}`);
    } catch (err) {
      failed.push({ name, reason: err.message });
      console.log(`[failed] ${name} — ${err.message}`);
    }
  }

  console.log(`\n${names.length} requested, ${made.length} made, ${failed.length} failed.`);
  if (failed.length > 0) {
    console.log("Failed:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.reason}`);
    process.exit(1);
  }
}

await main();
