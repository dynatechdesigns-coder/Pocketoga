// SPIKE (timeboxed): count shop-shelf items by text prompt through an
// OpenAI-compatible vision endpoint and print a restock PROPOSAL.
// Nothing is saved, no ledger/routes/web touched — a trader must confirm
// any proposal before anything is recorded.
//
//   node scripts/shelf-spike.mjs <image> [prompt ...]
//
// Defaults to the Meta chat-completions endpoint the photo checks already
// use; point SHELF_API_URL at a SAM 3.1-style endpoint later without
// changing the script. Endpoint and key come from the environment, never
// from the command line, and values are never printed.
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWithRetry, MODEL_PHOTO_MAX_TOKENS, MODEL_SEED, MODEL_TEMPERATURE, TEXT_MODEL } from "../model.mjs";

export const DEFAULT_PROMPTS = ["bottle", "tin", "carton"];
export const MAX_COUNT = 200;
export const MIN_CONFIDENCE = 0.5;
export const TIMEOUT_MS = 20000;
export const DEFAULT_API_URL = "https://api.meta.ai/v1/chat/completions";

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

const SYSTEM_PROMPT = `You count items on a shop-shelf photo. Reply with compact JSON only, exactly this shape, no explanation: {"counts": [{"prompt": "bottle", "count": 12, "confidence": 0.8}]}. One entry per prompt below, in order. count is the number of matching items you can see (0 when none). confidence is 0 to 1 for that count. Never invent items that are not visible.`;

export const OPEN_SYSTEM_PROMPT = `List the distinct product types visible on this shelf. For each give: name (brand and product only if the label is clearly readable, otherwise a plain category like 'tinned tomato' or 'noodle packet'), approximate count, confidence 0 to 1, and legible (true or false). Reply with JSON only.`;
export const MAX_OPEN_TYPES = 40;

export function buildOpenMessages(dataUrl) {
  return [
    { role: "system", content: OPEN_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: "This is a Nigerian market shop shelf. List the distinct product types visible on this shelf." },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
}

export function loadImageData(imagePath) {
  const mime = MIME[extname(imagePath).toLowerCase()] ?? null;
  if (!mime) throw new Error(`unsupported image type "${extname(imagePath)}" (want jpg, png or webp)`);
  return { data: readFileSync(imagePath).toString("base64"), mime };
}

export function buildMessages(dataUrl, prompts) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: `Count these on the shelf, one entry each: ${prompts.join(", ")}.` },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
}

// Pulls the first balanced {...} object or [...] array out of free text:
// strips a ```json fenced block first, then scans bracket depth respecting
// quoted strings, so trailing prose (even with stray braces) cannot glue
// two values together. Returns the raw substring, or null when there is none.
export function extractJsonObject(text) {
  let s = String(text ?? "");
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && (fence[1].includes("{") || fence[1].includes("["))) s = fence[1];
  const start = s.search(/[{\[]/);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// Tries the tolerant parse: balanced object, then normalised entries.
// Returns { ok, entries } — never throws, so the caller can retry.
export function tryParseReply(content) {
  const raw = extractJsonObject(content);
  if (raw === null) return { ok: false };
  try {
    return { ok: true, entries: parseCounts(JSON.parse(raw)) };
  } catch {
    return { ok: false };
  }
}

// Normalises an open-mode answer. Accepts {items: [...]}, {counts: [...]}
// or a bare array, so the model is free to pick the wrapper.
export function parseOpenCounts(parsed) {
  const list =
    parsed && typeof parsed === "object"
      ? Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.items)
          ? parsed.items
          : Array.isArray(parsed.counts)
            ? parsed.counts
            : null
      : null;
  if (!list) throw new Error("shelf response was not usable (want {items: [{name, count, confidence, legible}]})");
  return list.map((row) => ({
    name: String(row?.name ?? row?.prompt ?? ""),
    count: typeof row?.count === "number" ? row.count : Number(row?.count),
    confidence: typeof row?.confidence === "number" ? row.confidence : Number(row?.confidence),
    legible: row?.legible === true,
  }));
}

export function tryParseOpenReply(content) {
  const raw = extractJsonObject(content);
  if (raw === null) return { ok: false };
  try {
    return { ok: true, entries: parseOpenCounts(JSON.parse(raw)) };
  } catch {
    return { ok: false };
  }
}

// Normalises one model answer; shape errors throw, value errors are left
// for checkCounts so one odd entry never kills the whole proposal.
export function parseCounts(parsed) {
  const list = parsed && typeof parsed === "object" && Array.isArray(parsed.counts) ? parsed.counts : null;
  if (!list) throw new Error("shelf response was not usable (want {counts: [{prompt, count, confidence}]})");
  return list.map((row) => ({
    prompt: String(row?.prompt ?? ""),
    count: typeof row?.count === "number" ? row.count : Number(row?.count),
    confidence: typeof row?.confidence === "number" ? row.confidence : Number(row?.confidence),
  }));
}

function flag(items, reasons, text) {
  items.push(text);
  reasons.push(text);
}

// Pure-code checks, no AI: integers only, 0 and >200 are suspicious, low
// confidence is flagged. Never throws on odd values — it flags them.
export function checkCounts(entries) {
  const items = [];
  const flags = [];
  for (const e of entries) {
    const reasons = [];
    const countOk = Number.isInteger(e.count);
    if (!countOk) flag(flags, reasons, `${e.prompt || "item"}: count is not an integer`);
    if (Number.isInteger(e.count) && e.count < 0) flag(flags, reasons, `${e.prompt}: negative count`);
    if (e.count === 0) flag(flags, reasons, `${e.prompt}: none seen`);
    if (Number.isInteger(e.count) && e.count > MAX_COUNT) flag(flags, reasons, `${e.prompt}: ${e.count} above ${MAX_COUNT}, suspicious`);
    if (!Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1) {
      flag(flags, reasons, `${e.prompt}: no confidence`);
    } else if (e.confidence < MIN_CONFIDENCE) {
      flag(flags, reasons, `${e.prompt}: low confidence ${e.confidence}`);
    }
    items.push({ prompt: e.prompt, count: e.count, confidence: e.confidence, ok: reasons.length === 0, reasons });
  }
  return { items, flags };
}

export const normalizeName = (n) => String(n ?? "").trim().toLowerCase();

export function mergeDuplicates(items, flags) {
  const idx = new Map();
  const merged = [];
  const sizes = [];
  for (const item of items) {
    const key = normalizeName(item.name);
    if (!idx.has(key)) {
      idx.set(key, merged.length);
      sizes.push(1);
      merged.push({ ...item, reasons: [...item.reasons] });
      continue;
    }
    const at = idx.get(key);
    const m = merged[at];
    sizes[at]++;
    if (Number.isFinite(item.count)) m.count = (Number.isFinite(m.count) ? m.count : 0) + item.count;
    if (Number.isFinite(item.confidence) && (!Number.isFinite(m.confidence) || item.confidence < m.confidence)) {
      m.confidence = item.confidence;
    }
    m.legible = m.legible && item.legible;
    for (const r of item.reasons) if (!m.reasons.includes(r)) m.reasons.push(r);
  }
  merged.forEach((m, i) => {
    if (sizes[i] > 1) {
      const note = `merged ${sizes[i]} duplicate rows named "${m.name}"`;
      m.reasons.push(note);
      if (flags) flags.push(`${m.name || "item"}: ${note}`);
    }
    m.ok = m.reasons.length === 0;
  });
  return merged;
}

// Ask-twice-and-compare: match two open runs by normalised name; flag an
// item whose counts differ by more than 20% or that appears in one run only.
export function compareRuns(first, second) {
  const flags = [];
  const byName = (items) => {
    const m = new Map();
    for (const it of items) {
      const k = normalizeName(it.name);
      if (!m.has(k)) m.set(k, it);
    }
    return m;
  };
  const A = byName(first);
  const B = byName(second);
  for (const [k, a] of A) {
    const b = B.get(k);
    if (!b) {
      flags.push(`${a.name}: only in run 1`);
      continue;
    }
    if (Number.isFinite(a.count) && Number.isFinite(b.count)) {
      const top = Math.max(a.count, b.count);
      if (top > 0 && Math.abs(a.count - b.count) / top > 0.2) {
        flags.push(`${a.name}: counts differ between runs (${a.count} vs ${b.count})`);
      }
    }
  }
  for (const [k, b] of B) {
    if (!A.has(k)) flags.push(`${b.name}: only in run 2`);
  }
  return flags;
}

// Open-mode checks: the same numeric rules as prompt mode, plus legible,
// duplicate merging and the too-crowded guard. Never throws — it flags.
export function checkOpenCounts(entries) {
  const items = [];
  const flags = [];
  for (const e of entries) {
    const name = e.name || "item";
    const reasons = [];
    if (!Number.isInteger(e.count)) flag(flags, reasons, `${name}: count is not an integer`);
    if (Number.isInteger(e.count) && e.count < 0) flag(flags, reasons, `${name}: negative count`);
    if (e.count === 0) flag(flags, reasons, `${name}: none seen`);
    if (Number.isInteger(e.count) && e.count > MAX_COUNT) flag(flags, reasons, `${name}: ${e.count} above ${MAX_COUNT}, suspicious`);
    if (!Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1) {
      flag(flags, reasons, `${name}: no confidence`);
    } else if (e.confidence < MIN_CONFIDENCE) {
      flag(flags, reasons, `${name}: low confidence ${e.confidence}`);
    }
    if (!e.legible) flag(flags, reasons, `${name}: check the label`);
    items.push({ name: e.name, count: e.count, confidence: e.confidence, legible: !!e.legible, ok: reasons.length === 0, reasons });
  }
  const merged = mergeDuplicates(items, flags);
  if (merged.length > MAX_OPEN_TYPES) flags.push(`${merged.length} distinct types: too crowded, try a closer photo`);
  return { items: merged, flags };
}

export function proposeRestock(photo, items, flags) {
  return {
    proposal: "shelf-restock",
    photo,
    items,
    flags,
    saved: false,
    note: "PROPOSAL only — a trader must confirm it before anything is saved.",
  };
}

// Reads the answer text from a chat message whether content is a plain
// string or an array of parts. Reasoning-style fields are collected only
// for --debug diagnostics and never used as the answer.
export function readContent(message) {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
  return "";
}

export function reasoningDiag(message, usage) {
  const out = {};
  for (const k of ["reasoning_content", "reasoning", "thinking", "thought"]) {
    if (message?.[k] != null) out[k] = String(message[k]).slice(0, 200);
  }
  if (usage && typeof usage === "object" && Object.keys(usage).length > 0) out.usage_details = usage;
  return out;
}

// Full response body with any embedded image data cut out, for --debug.
// The reply never carries the photo, but a data URI must never reach the
// terminal if one ever does.
export function scrubBodyForDebug(data) {
  return JSON.stringify(data, (k, v) =>
    typeof v === "string" && v.includes("base64,") && v.length > 200 ? "[image data omitted]" : v
  );
}

export async function countShelf({ imagePath, prompts = DEFAULT_PROMPTS, open = false, fetchFn = fetch, env = process.env, debug = false }) {
  const apiKey = env.SHELF_API_KEY;
  if (!apiKey) throw new Error("SHELF_API_KEY is not set");
  const url = env.SHELF_API_URL ?? DEFAULT_API_URL;
  const model = env.SHELF_MODEL ?? TEXT_MODEL;
  const { data, mime } = loadImageData(imagePath);
  const dataUrl = `data:${mime};base64,${data}`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  const call = (messages, maxTokens) =>
    fetchWithRetry(
      fetchFn,
      url,
      {
        method: "POST",
        // Identical to the photo-check request except the prompt text:
        // reasoning_effort minimal keeps the budget for content instead of
        // reasoning tokens, temperature 0 and seed 7 keep it deterministic.
        headers,
        body: JSON.stringify({
          model,
          reasoning_effort: "minimal",
          temperature: MODEL_TEMPERATURE,
          seed: MODEL_SEED,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages,
        }),
      },
      { timeoutMs: TIMEOUT_MS, retries: 1 }
    );
  const readReply = async (messages, maxTokens) => {
    const res = await call(messages, maxTokens);
    if (!res.ok) throw new Error(`shelf API error ${res.status}`);
    const data2 = await res.json().catch(() => ({}));
    const message = data2.choices?.[0]?.message ?? {};
    const content = readContent(message);
    const finish = data2.choices?.[0]?.finish_reason ?? "none";
    const usage = data2.usage ?? {};
    // Debug prints the reply, status, finish, message keys and usage only —
    // never the key, the URL or the image data.
    if (debug) {
      console.log(`status: ${res.status}`);
      console.log(`finish: ${finish}`);
      console.log(`messageKeys: ${Object.keys(message).join(",")}`);
      console.log(`usage: ${JSON.stringify(usage)}`);
      console.log(`reasoning: ${JSON.stringify(reasoningDiag(message, usage))}`);
      console.log(`body: ${scrubBodyForDebug(data2).slice(0, 2000)}`);
      console.log(`reply: ${content}`);
    }
    return { content, finish };
  };
  const runWithRetry = async (messages, tryParse) => {
    let maxTokens = MODEL_PHOTO_MAX_TOKENS;
    let reply = await readReply(messages, maxTokens);
    let attempt = tryParse(reply.content);
    if (!attempt.ok) {
      // One retry with a stricter instruction; a chatty first reply often
      // turns into clean JSON when asked again. A length cutoff also doubles
      // the budget, mirroring the photo-check length retry.
      if (reply.finish === "length") maxTokens *= 2;
      messages = [...messages, { role: "user", content: "Reply with JSON only, no other text." }];
      reply = await readReply(messages, maxTokens);
      attempt = tryParse(reply.content);
      if (!attempt.ok) {
        throw new Error(
          reply.content.trim()
            ? `shelf response was not usable (no JSON): ${reply.content.slice(0, 200)}`
            : "shelf response was not usable (empty reply)"
        );
      }
    }
    return attempt.entries;
  };
  if (open) {
    // Open mode: no item words, so the model lists what it sees — twice,
    // then code compares the two runs. The proposal carries run 1's list.
    const first = checkOpenCounts(await runWithRetry(buildOpenMessages(dataUrl), tryParseOpenReply));
    const second = checkOpenCounts(await runWithRetry(buildOpenMessages(dataUrl), tryParseOpenReply));
    const extra = compareRuns(first.items, second.items);
    return proposeRestock(imagePath, first.items, [...first.flags, ...extra]);
  }
  const entries = await runWithRetry(buildMessages(dataUrl, prompts), tryParseReply);
  const { items, flags } = checkCounts(entries);
  return proposeRestock(imagePath, items, flags);
}

function printTable(items) {
  const w = Math.max(4, ...items.map((i) => String(i.name ?? i.prompt).length));
  console.log(`NAME${" ".repeat(Math.max(1, w - 4))}  COUNT  CONF  FLAGS`);
  for (const item of items) {
    const label = String(item.name ?? item.prompt);
    console.log(`${label.padEnd(w)}  ${String(item.count).padEnd(5)}  ${String(item.confidence).padEnd(4)}  ${item.ok ? "" : item.reasons.join("; ")}`);
  }
}

async function main(argv, env) {
  const debug = argv.includes("--debug");
  const [imagePath, ...rest] = argv.filter((a) => a !== "--debug");
  if (!imagePath) {
    console.error("usage: node scripts/shelf-spike.mjs [--debug] <image> [prompt ...]");
    console.error("  (no prompts: open mode — the model lists what it sees, twice)");
    process.exitCode = 1;
    return;
  }
  const open = rest.length === 0;
  try {
    const proposal = await countShelf({ imagePath, prompts: rest, open, env, debug });
    if (open) printTable(proposal.items);
    else {
      for (const item of proposal.items) {
        console.log(`${item.prompt}: ${item.count} (confidence ${item.confidence})${item.ok ? "" : " — " + item.reasons.join("; ")}`);
      }
    }
    for (const flag of proposal.flags) console.log(`flag: ${flag}`);
    console.log(JSON.stringify(proposal));
  } catch (err) {
    console.error(`shelf spike failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

const invokedAsMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) await main(process.argv.slice(2), process.env);
