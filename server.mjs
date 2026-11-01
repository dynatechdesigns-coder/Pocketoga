// Minimal HTTP API for the voice-to-confirm loop. Node built-ins only.
// Identity: real shops need a session token (POST /session swaps a
// WhatsApp code for one) matching the x-shop-id header; cross-shop access
// is 403. The demo shop ("demo") stays public. The webhook is Meta's,
// verified by signature. Run directly: `node server.mjs`
// (PORT/DATA_DIR/LEDGER_DB env). Also serves the built web app (web/dist)
// on the same origin with an SPA fallback, so one URL serves everything.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { PromiseStore, refreshPromises } from "./promises.mjs";
import { customerDebts, chaseForShop, allocatedSales } from "./debts.mjs";
import { moneyLeakReport } from "./leak.mjs";
import { buildMonthlyCsv, parseReportMonth } from "./reports.mjs";
import { ProductStore, withStock, toProductJson } from "./products.mjs";
import { CustomerStore, describeCustomers, normalizePhone, nextAutoCustomerLabel, normCustomerName } from "./customers.mjs";
import { PROFIT_PERIODS, profitForPeriod, expensesForPeriod } from "./profit.mjs";
import { SecondOpinionStore } from "./secondopinion.mjs";
import { AuthStore, DEMO_SHOP_ID } from "./auth.mjs";
import { PhotoCheckStore } from "./photos.mjs";
import { IdempotencyStore, MAX_REQUEST_ID_LENGTH } from "./idempotency.mjs";
import { FeedbackStore, validateFeedbackBody, feedbackError, notifyFeedbackWebhook, classifyFeedbackType } from "./feedback.mjs";
import { ModelCapStore, resolveDailyCaps, withModelCap, withFetchCap } from "./modelcaps.mjs";
import { createModelClient } from "./model.mjs";
import { propose, confirmProposal, fixProposal, rejectProposal, getProposal, proposeCorrection, proposeFromForm, proposeManual, toProposal } from "./voice.mjs";
import { proposePhotoCheck } from "./photos.mjs";
import {
  verifyWhatsAppSignature,
  verifyWebhookSubscription,
  processWhatsAppPayload,
  trackWhatsAppJob,
  buildWhatsAppContext,
  previewSummaryText,
  runSummaryTick,
} from "./whatsapp.mjs";
import { seedDemoShop } from "./demo-seed.mjs";
import { backupNow, restoreIfMissing } from "./backup.mjs";
import { formatRequestLog, startupEnvLines, ffmpegAvailable, logLine } from "./log.mjs";

const MAX_BODY_BYTES = 12 * 1024 * 1024;

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectBody(Object.assign(new Error("request body must be JSON"), { status: 400 }));
      }
    });
    req.on("error", rejectBody);
  });
}

function readRawBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

// State lives under DATA_DIR (default ./data, created when missing): the
// SQLite file is DATA_DIR/pocketoga.db unless LEDGER_DB names another path.
// Nothing is hard-coded to the project folder, so a container can point
// DATA_DIR anywhere writable.
export function resolveDataDir(env = process.env) {
  const dir = env.DATA_DIR && String(env.DATA_DIR).trim() ? String(env.DATA_DIR).trim() : "./data";
  return resolve(dir);
}

export function resolveDbPath(env = process.env) {
  if (env.LEDGER_DB && String(env.LEDGER_DB).trim()) return env.LEDGER_DB;
  return join(resolveDataDir(env), "pocketoga.db");
}

// First path segment of every API route (the webhook branch runs before
// this). Anything else on GET/HEAD is the web app: a real file when one
// matches, index.html otherwise (SPA fallback). /api/... is stripped first
// so a bundle built against the dev proxy keeps working on one origin.
const API_FIRST = new Set([
  "webhook", "session", "propose", "propose-form", "photo-checks", "confirm",
  "fix", "reject", "proposals", "ledger", "entries", "correct-last", "debts", "promises",
  "report", "reports", "sales", "products", "customers", "profit", "expenses", "summary",
  "health", "feedback",
]);

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

// Serves a built web app (web/dist) from memory: files load once on first
// request, text types carry a precompressed gzip copy. Returns null when
// the folder is missing (backend-only mode). Returns a handler that answers
// true when it served (file or SPA fallback) and false for a missing asset,
// so the router can 404 those.
export function createStaticHandler(rootDir) {
  if (!rootDir) return null;
  try {
    if (!statSync(rootDir).isDirectory()) return null;
  } catch {
    return null;
  }
  const root = resolve(rootDir);
  const cache = new Map();
  // Entry points must revalidate every time so updates — and the service
  // worker, which the browser only refreshes from its own cached copy —
  // are never stuck behind a stale cache. The exact "no-cache, max-age=0,
  // must-revalidate" value (not bare "no-cache") keeps browsers and CDNs
  // from serving a stale copy of the files that decide which app version
  // runs. The manifest rides along with no-cache so icon/name updates
  // apply; hashed /assets/* files are immutable for a year; icons and
  // other static files keep a daily cache.
  const cacheControlFor = (rel, isFallback) =>
    isFallback || rel === "index.html" || rel === "sw.js"
      ? "no-cache, max-age=0, must-revalidate"
      : rel === "manifest.webmanifest"
        ? "no-cache"
        : rel.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=86400";
  const load = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    let file;
    let mtimeMs = 0;
    try {
      const abs = resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + sep)) return null;
      const st = statSync(abs);
      if (!st.isFile()) return null;
      mtimeMs = st.mtimeMs;
      file = readFileSync(abs);
    } catch {
      return null;
    }
    const type = STATIC_TYPES[extname(rel).toLowerCase()] ?? "application/octet-stream";
    const gzipable = /^(text\/|application\/(json|javascript|manifest\+json))/.test(type) && file.length < 2 * 1024 * 1024;
    const entry = { file, type, gz: gzipable ? gzipSync(file) : null, etag: `"${file.length.toString(36)}-${Math.floor(mtimeMs).toString(36)}"` };
    cache.set(rel, entry);
    return entry;
  };
  return function serveStatic(req, res) {
    const url = new URL(req.url ?? "/", "http://x");
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (!rel || rel.endsWith("/")) rel += "index.html";
    let entry = existsSync(join(root, rel)) ? load(rel) : null;
    let isFallback = false;
    if (!entry && !extname(rel)) {
      entry = load("index.html");
      isFallback = true;
    }
    if (!entry) return false;
    const body = entry.file;
    const headers = {
      "Content-Type": entry.type,
      "Content-Length": body.length,
      ETag: entry.etag,
      "Cache-Control": cacheControlFor(rel, isFallback),
    };
    // Pin the worker's scope to the whole origin. sw.js is served from the
    // root so the default scope is already "/", but the explicit header
    // keeps CDNs and browsers from narrowing it. Only on sw.js, never
    // elsewhere. The .js content type above is unchanged.
    if (rel === "sw.js") headers["Service-Worker-Allowed"] = "/";
    let out = body;
    const acceptsGzip = (req.headers["accept-encoding"] ?? "").includes("gzip");
    if (acceptsGzip && entry.gz) {
      out = entry.gz;
      headers["Content-Encoding"] = "gzip";
      headers["Content-Length"] = out.length;
      headers.Vary = "Accept-Encoding";
    }
    // Cheap revalidation: the ETag above lets the browser revalidate with
    // If-None-Match instead of downloading again.
    if (req.headers["if-none-match"] === entry.etag) {
      const notModified = { ETag: entry.etag, "Cache-Control": headers["Cache-Control"] };
      if (rel === "sw.js") notModified["Service-Worker-Allowed"] = "/";
      res.writeHead(304, notModified);
      res.end();
      return true;
    }
    res.writeHead(200, headers);
    if (req.method !== "HEAD") res.end(out);
    else res.end();
    return true;
  };
}

// Where the built web app can live. The Docker image builds it into
// web/dist next to server.mjs; a checkout run from its root resolves to the
// same folder through the working directory. Presence of the folder — never
// NODE_ENV — decides whether the app is served.
export const STATIC_CANDIDATES = [
  join(dirname(fileURLToPath(import.meta.url)), "web", "dist"),
  join(process.cwd(), "web", "dist"),
];

export function findStaticRoot(candidates = STATIC_CANDIDATES) {
  for (const dir of candidates) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // Missing or unreadable: try the next candidate.
    }
  }
  return null;
}

// WhatsApp webhook. No x-shop-id header: Meta calls it, and the sender's
// shop comes from the message itself via the allow-list.
async function handleWebhookRoute(req, res, url, deps) {
  const env = deps.env ?? process.env;
  if (req.method === "GET") {
    const challenge = verifyWebhookSubscription(url.searchParams, env.WHATSAPP_VERIFY_TOKEN);
    if (!challenge) return send(res, 403, { error: "webhook verification failed" });
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(challenge) });
    res.end(challenge);
    return;
  }
  if (req.method === "POST") {
    const raw = await readRawBody(req);
    if (!verifyWhatsAppSignature(raw, req.headers["x-hub-signature-256"], env.WHATSAPP_APP_SECRET)) {
      return send(res, 403, { error: "bad webhook signature" });
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return send(res, 400, { error: "webhook body must be JSON" });
    }
    // Answer 200 fast; the slow work (model, media) runs after responding.
    send(res, 200, { ok: true });
    const ctx = buildWhatsAppContext(deps, env);
    trackWhatsAppJob(
      processWhatsAppPayload(payload, ctx).catch((err) => {
        ctx.log(`webhook job failed: ${err?.message ?? err}`);
      })
    );
    return;
  }
  return send(res, 404, { error: "not found" });
}

// Best-effort client IP for per-IP rate limits: the first forwarded address,
// else the tunnel header, else the socket address. Opaque string, never a
// secret; proxies are the only callers that set the headers.
function clientIp(req) {
  const headers = req.headers ?? {};
  const forwarded = typeof headers["x-forwarded-for"] === "string" ? headers["x-forwarded-for"].split(",")[0].trim() : "";
  if (forwarded) return forwarded;
  const connecting = typeof headers["cf-connecting-ip"] === "string" ? headers["cf-connecting-ip"].trim() : "";
  if (connecting) return connecting;
  const socketAddr = req.socket?.remoteAddress;
  if (typeof socketAddr === "string" && socketAddr) return socketAddr;
  return "unknown";
}

// "Bearer <token>" (scheme case-insensitive) to the token, else null.
function bearerToken(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  const token = match ? match[1].trim() : "";
  return token || null;
}

// Each entry gains correctedById (the latest correcting entry's id in
// chain order, or null) and correctionReason (the logged reason, or null
// when uncorrected or corrected before reasons existed), plus the fields
// the web app needs for a per-row Edit button: canCorrect (this row is the
// current version, so a new correction chains from it), wasCorrected (a
// correction points at this row) and currentVersionId (the row id the
// reports, debts and CSV treat as live — the chain end, or a winning
// sibling when two corrections named the same original).
function withCorrectionInfo(ledger, shopId) {
  const entries = ledger.list(shopId);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const latest = new Map();
  const hasCorrection = new Set();
  for (const e of entries) {
    if (e.corrects_id === null || e.corrects_id === undefined) continue;
    hasCorrection.add(e.corrects_id);
    const prev = latest.get(e.corrects_id);
    if (!prev || e.seq > prev.seq || (e.seq === prev.seq && e.id > prev.id)) {
      latest.set(e.corrects_id, e);
    }
  }
  const currentOf = (id) => {
    let cur = id;
    const seen = new Set([id]);
    for (;;) {
      let next = latest.get(cur) ?? null;
      if (!next) {
        const row = byId.get(cur);
        if (row && row.corrects_id !== null && row.corrects_id !== undefined) {
          const sib = latest.get(row.corrects_id);
          if (sib && sib.id !== cur) next = sib;
        }
      }
      if (!next || seen.has(next.id)) return cur;
      seen.add(next.id);
      cur = next.id;
    }
  };
  return entries.map((e) => {
    const fix = latest.get(e.id);
    const currentVersionId = currentOf(e.id);
    return {
      ...e,
      correctedById: fix ? fix.id : null,
      correctionReason: fix ? ledger.correctionReason(fix.id) : null,
      canCorrect: currentVersionId === e.id,
      wasCorrected: hasCorrection.has(e.id),
      currentVersionId,
    };
  });
}

// Offline queue: the optional client request id. Missing means a normal call;
// present-but-blank or overlong is a 400 (never silently ignored, so a
// retrying client learns its header is broken instead of double-proposing).
function readRequestId(headers) {
  const raw = headers ? headers["x-request-id"] : null;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !raw.trim()) {
    throw Object.assign(new Error("x-request-id must be a non-empty string"), { status: 400 });
  }
  const id = raw.trim();
  if (id.length > MAX_REQUEST_ID_LENGTH) {
    throw Object.assign(new Error(`x-request-id must be under ${MAX_REQUEST_ID_LENGTH} characters`), { status: 400 });
  }
  return id;
}

// The offline queue's "when it happened": passed through to the propose
// functions (which validate it in plain code and fall back to now), never a
// 400 — a bad value is ignored, not a reason to drop the note.
function readOccurredAt(body) {
  if (!body || typeof body !== "object") return null;
  return body.occurred_at ?? null;
}

// Runs produce() once per (shop, request id): a repeat of the same id
// replays the stored proposal instead of proposing (or recording) twice.
// Keys live 24 hours; older repeats propose fresh. The proposal object is
// identical either way; only the status differs (201 first, 200 replay).
// Request ids are scoped per shop, so a replay never crosses shops.
async function idempotentPropose(req, res, deps, shopId, produce) {
  const requestId = readRequestId(req.headers);
  if (!requestId) return send(res, 201, { proposal: await produce() });
  if (!deps.idempotency) throw Object.assign(new Error("idempotency store is required"), { status: 500 });
  const store = deps.idempotency;
  store.prune();
  // send() returns nothing, so the replay helper reports with a boolean.
  const replay = (proposalId) => {
    const row = deps.proposals.get(proposalId);
    if (!row || row.shop_id !== shopId) return false;
    send(res, 200, { proposal: toProposal(row) });
    return true;
  };
  const existing = store.find(shopId, requestId);
  if (existing && store.fresh(existing)) {
    if (existing.proposal_id) {
      if (replay(existing.proposal_id)) return;
      store.remove(shopId, requestId); // mapping survived its proposal: propose fresh
    } else {
      // The same id is being processed right now: no second proposal.
      return send(res, 409, { error: "that x-request-id is already being processed" });
    }
  } else if (existing) {
    store.remove(shopId, requestId); // older than 24 hours: propose fresh
  }
  if (!store.reserve(shopId, requestId, new Date().toISOString())) {
    const retry = store.find(shopId, requestId);
    if (retry && retry.proposal_id && replay(retry.proposal_id)) return;
    return send(res, 409, { error: "that x-request-id is already being processed" });
  }
  let proposal;
  try {
    proposal = await produce();
  } catch (err) {
    store.remove(shopId, requestId);
    throw err;
  }
  store.attach(shopId, requestId, proposal.id);
  return send(res, 201, { proposal });
}

// Exported for in-process tests; createVoiceServer wires it to real sockets.
export async function handleVoiceRequest(req, res, deps) {
  const url = new URL(req.url ?? "/", "http://x");
  let parts = url.pathname.split("/").filter(Boolean);
  // Same-origin bundles built against the dev proxy call /api/...: strip it
  // so they hit the same routes as a relative-base build.
  if (parts.length >= 1 && parts[0] === "api") parts = parts.slice(1);
  // Tunnel guard: with WEBHOOK_PUBLIC_ONLY=1, requests that arrived via the
  // public tunnel (Cloudflare / proxy headers present) may only use /webhook.
  // Local traffic without those headers behaves as before. Leave the flag
  // unset on Render: one public URL serves the app and the webhook together,
  // and every request there carries a proxy header.
  if ((deps.env ?? process.env).WEBHOOK_PUBLIC_ONLY === "1") {
    const viaTunnel = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"];
    if (viaTunnel && !(parts.length >= 1 && parts[0] === "webhook")) {
      return send(res, 404, { error: "not found" });
    }
  }
  if (parts.length >= 1 && parts[0] === "webhook") {
    return handleWebhookRoute(req, res, url, deps);
  }

  // Liveness probe for the host (Render healthCheckPath). No auth, no
  // secrets, no shop header — just proof the process answers. HEAD answers
  // with the same status and headers as GET and no body.
  if ((req.method === "GET" || req.method === "HEAD") && parts.length === 1 && parts[0] === "health") {
    const body = JSON.stringify({ ok: true });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(req.method === "GET" ? body : undefined);
    return;
  }

  // Passwordless login: exchange a WhatsApp code for a session token, or
  // revoke the caller's token. No shop header: the code names the shop and
  // the token carries it.
  if (parts.length === 1 && parts[0] === "session") {
    if (!deps.auths) throw Object.assign(new Error("auth store is required"), { status: 500 });
    if (req.method === "POST") {
      const body = await readBody(req);
      const fields = body && typeof body === "object" ? body : {};
      if (typeof fields.shop !== "string" || !fields.shop.trim() || typeof fields.code !== "string" || !fields.code.trim()) {
        return send(res, 400, { error: "shop and code are required" });
      }
      const out = deps.auths.exchangeCode(fields.shop.trim(), fields.code, {});
      if (!out.ok) {
        if (out.reason === "rate_limited") return send(res, 429, { error: "too many attempts — try again in an hour" });
        if (out.reason === "used") return send(res, 401, { error: "that code was already used" });
        if (out.reason === "expired") return send(res, 401, { error: "that code expired — send dashboard for a new one" });
        return send(res, 401, { error: "wrong code — check and try again" });
      }
      return send(res, 201, { token: out.token, shop_id: out.shopId, expires_at: out.expiresAt });
    }
    if (req.method === "DELETE") {
      const session = deps.auths.verifyToken(bearerToken(req.headers.authorization), {});
      if (!session) return send(res, 401, { error: "login required" });
      deps.auths.revokeToken(bearerToken(req.headers.authorization), {});
      return send(res, 200, { revoked: true });
    }
    return send(res, 404, { error: "not found" });
  }

  // Built web app on the same origin: real files straight, client routes
  // fall back to index.html. API paths always win; missing assets 404.
  if ((req.method === "GET" || req.method === "HEAD") && deps.static && !API_FIRST.has(parts[0] ?? "")) {
    if (deps.static(req, res)) return;
    return send(res, 404, { error: "not found" });
  }

  const shopHeader = req.headers["x-shop-id"];
  if (typeof shopHeader !== "string" || !shopHeader.trim()) {
    return send(res, 400, { error: "x-shop-id header is required" });
  }
  const shopId = shopHeader.trim();

  // Auth: the demo shop is public; every other shop needs a session token
  // for exactly this shop. A missing auth store fails closed, never open.
  if (shopId !== DEMO_SHOP_ID) {
    if (!deps.auths) throw Object.assign(new Error("auth store is required"), { status: 500 });
    const session = deps.auths.verifyToken(bearerToken(req.headers.authorization), {});
    if (!session) return send(res, 401, { error: "login required" });
    if (session.shopId !== shopId) return send(res, 403, { error: "this login is for another shop" });
  }

  // Daily model-credit caps: every Meta/Baseten call below charges one call
  // against this shop's budget and the service budget (Lagos day, stored in
  // sqlite so restarts keep them). A spent budget throws 429 with the plain
  // sentence before any network happens; without the store the route runs
  // uncapped (hand-built test deps). Code-only paths never charge.
  const chargeModelCall = () => {
    if (deps.modelCaps && deps.dailyCaps) {
      deps.modelCaps.charge(shopId, { caps: deps.dailyCaps, isDemo: shopId === DEMO_SHOP_ID });
    }
  };
  const cappedModel = withModelCap(deps.model, chargeModelCall);
  const cappedSecondOpinionFetch = withFetchCap(undefined, chargeModelCall);

  // Trader feedback about the app itself (never ledger data): a typed note or
  // a voice note up to 45 seconds, exactly one of the two, with an optional
  // type that is kept as-is when supplied. Typed answers 201 { ok: true };
  // audio is transcribed with the same model call as a voice note and
  // answers 201 { ok: true, text }. Validation is 400 with a plain message;
  // past 5 per hour per IP or per shop is 429, claimed atomically before the
  // reply. Everything after the reply — type detection, storing, owner
  // inbox — never blocks the trader: the reply is already on its way.
  if (req.method === "POST" && parts.length === 1 && parts[0] === "feedback") {
    if (!deps.feedback) throw Object.assign(new Error("feedback store is required"), { status: 500 });
    const body = await readBody(req);
    const fields = validateFeedbackBody(body);
    const ip = clientIp(req);
    if (!deps.feedback.claim(ip, shopId, Date.now())) {
      throw feedbackError(429, "too many feedback messages — try again in an hour");
    }
    let text = fields.text;
    if (fields.audio) {
      let raw;
      try {
        raw = await cappedModel.complete({ audio: fields.audio });
      } catch (err) {
        if (err?.code === "MODEL_BAD_JSON" || err?.code === "MODEL_TRUNCATED") {
          throw feedbackError(400, "could not hear that voice note — please try again");
        }
        throw err;
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw feedbackError(400, "could not hear that voice note — please try again");
      }
      text = typeof raw.heard === "string" ? raw.heard.trim() : "";
      if (!text || text === "(no transcript)") {
        throw feedbackError(400, "could not hear anything in that voice note — please try again");
      }
    }
    // The reply goes out before detection, storing and forwarding: a slow
    // model or inbox never delays it. Quota was already claimed above, so
    // detection runs at most once per accepted message and 429s run none.
    if (fields.audio) send(res, 201, { ok: true, text });
    else send(res, 201, { ok: true });
    let finalType = fields.type;
    let typeSource = "given";
    if (!finalType) {
      finalType = await classifyFeedbackType(text, cappedModel);
      typeSource = "auto";
    }
    try {
      deps.feedback.recordRow({ shopId, ip, type: finalType, typeSource, rating: fields.rating, text });
    } catch {
      try {
        logLine("feedback store failed");
      } catch {
        // Logging must never break a reply that already went out.
      }
    }
    // Owner inbox, best-effort, only after classification finishes: a
    // missing config or failed delivery keeps the 201 above, and the
    // notifier logs only its fixed failure line (never the message).
    try {
      const env = deps.env ?? process.env;
      await notifyFeedbackWebhook({
        url: env.FEEDBACK_WEBHOOK_URL,
        secret: env.FEEDBACK_WEBHOOK_SECRET,
        type: finalType,
        typeSource,
        rating: fields.rating,
        message: text,
        source: fields.audio ? "voice" : "text",
        fetchFn: deps.feedbackFetch ?? fetch,
      });
    } catch {
      // notifyFeedbackWebhook never throws; this guards the wiring itself.
    }
    return;
  }

  if (req.method === "POST" && parts.length === 1 && parts[0] === "propose") {
    const body = await readBody(req);
    const input =
      body.text !== undefined
        ? body.text
        : body.audioBase64 !== undefined
          ? { audioBase64: body.audioBase64, audioFormat: body.audioFormat }
          : undefined;
    const hint = body && typeof body === "object" ? body.hint : undefined;
    const occurredAt = readOccurredAt(body);
    return idempotentPropose(req, res, deps, shopId, () =>
      propose(shopId, input, { ...deps, model: cappedModel, secondOpinionFetch: cappedSecondOpinionFetch, hint: hint ?? null, occurredAt }));
  }

  // Structured form fields into a proposal, with no model call. Same checks,
  // effects, card and confirm flow as /propose, and the same proposal
  // object, so the web reuses one confirm card. Nothing reaches the ledger
  // until the trader confirms.
  if (req.method === "POST" && parts.length === 1 && parts[0] === "propose-form") {
    const body = await readBody(req);
    const fields = body && typeof body === "object" ? body : {};
    const occurredAt = readOccurredAt(body);
    return idempotentPropose(req, res, deps, shopId, () =>
      proposeFromForm(shopId, fields, { ...deps, occurredAt }));
  }

  // Typed-by-hand entries (offline queue): same checks, card and confirm
  // flow as the other propose routes, with no model call. The x-request-id
  // contract matches every other propose route: same shop + id replays the
  // stored proposal, never proposes twice.
  if (req.method === "POST" && parts.length === 2 && parts[0] === "proposals" && parts[1] === "manual") {
    const body = await readBody(req);
    const fields = body && typeof body === "object" ? body : {};
    const occurredAt = readOccurredAt(body);
    return idempotentPropose(req, res, deps, shopId, () =>
      proposeManual(shopId, fields, { ...deps, occurredAt }));
  }

  // Photo pipeline (Alert Guard first): classifies the photo, extracts its
  // fields and runs the code checks, storing a proposal the trader confirms
  // as usual. The raw photo is never stored.
  if (req.method === "POST" && parts.length === 1 && parts[0] === "photo-checks") {
    const body = await readBody(req);
    const fields = body && typeof body === "object" ? body : {};
    const occurredAt = readOccurredAt(body);
    return idempotentPropose(req, res, deps, shopId, () =>
      proposePhotoCheck(
        shopId,
        { photoBase64: fields.photoBase64, photoFormat: fields.photoFormat },
        { proposals: deps.proposals, model: cappedModel, ledger: deps.ledger, photoChecks: deps.photoChecks, occurredAt }
      ));
  }

  // Saved payment checks for the web "Check alert" screen: extracted fields
  // only, oldest first. Same-shop only, like every other shop route.
  if (req.method === "GET" && parts.length === 2 && parts[0] === "photo-checks" && parts[1] === "unconfirmed") {
    const checks = deps.photoChecks.listUnconfirmedByShop(shopId).map((row) => deps.photoChecks.toPublicCheck(row));
    return send(res, 200, { checks });
  }

  // Web equivalent of the WhatsApp "I saw it in my bank" tap: the same
  // checks — refuse when the check isn't saved, refuse another shop's
  // check, idempotent when already confirmed. Returns the updated check.
  if (req.method === "POST" && parts.length === 3 && parts[0] === "photo-checks" && parts[2] === "bank-confirm") {
    const id = Number(decodeURIComponent(parts[1]));
    const check = Number.isInteger(id) ? deps.photoChecks.get(id) : null;
    if (!check) return send(res, 404, { error: "check not found" });
    if (check.shop_id !== shopId) return send(res, 403, { error: "that check belongs to another shop" });
    const updated = deps.photoChecks.markSeen(check.id);
    return send(res, 200, { check: { ...deps.photoChecks.toPublicCheck(updated), check_status: updated.check_status, seen_at: updated.seen_at ?? null } });
  }

  if (req.method === "POST" && parts.length === 2 && ["confirm", "fix", "reject"].includes(parts[0])) {
    const id = decodeURIComponent(parts[1]);
    if (parts[0] === "confirm") {
      return send(res, 200, confirmProposal(id, shopId, deps));
    }
    if (parts[0] === "reject") {
      return send(res, 200, { proposal: rejectProposal(id, shopId, deps) });
    }
    const body = await readBody(req);
    const proposal = await fixProposal(id, shopId, body.correctionText ?? body.text, { ...deps, model: cappedModel });
    return send(res, 200, { proposal });
  }

  if (req.method === "GET" && parts.length === 2 && parts[0] === "proposals") {
    return send(res, 200, { proposal: getProposal(decodeURIComponent(parts[1]), shopId, deps) });
  }

  // Read-only: the caller's own shop chain plus its verification. SELECTs only.
  if (req.method === "GET" && parts.length === 1 && parts[0] === "ledger") {
    return send(res, 200, { entries: withCorrectionInfo(deps.ledger, shopId), verify: deps.ledger.verify(shopId) });
  }

  // Appends a correction through the existing correction path (corrects_id);
  // the original row is never touched. Validated like any entry, same shop
  // only. The reason is required and lives in corrections_log, never in
  // the ledger. Omitted fields inherit the original; explicit null clears
  // item, quantity and unit.
  if (req.method === "POST" && parts.length === 3 && parts[0] === "ledger" && parts[2] === "correct") {
    const id = Number(decodeURIComponent(parts[1]));
    const original = Number.isInteger(id) ? deps.ledger.get(id) : null;
    if (!original) return send(res, 404, { error: "entry not found" });
    if (original.shop_id !== shopId) return send(res, 403, { error: "that entry belongs to another shop" });
    const body = await readBody(req);
    const fields = body && typeof body === "object" ? body : {};
    const reason = typeof fields.reason === "string" ? fields.reason.trim() : "";
    if (!reason) return send(res, 400, { error: "correction reason is required" });
    const { amountKobo, customer, item, quantity, unit } = fields;
    if (amountKobo !== undefined && (!Number.isInteger(amountKobo) || amountKobo < 0)) {
      return send(res, 400, { error: "amountKobo must be a non-negative integer (kobo)" });
    }
    if (customer !== undefined && customer !== null && (typeof customer !== "string" || customer.length === 0)) {
      return send(res, 400, { error: "customer must be text" });
    }
    if (item !== undefined && item !== null && (typeof item !== "string" || item.length === 0)) {
      return send(res, 400, { error: "item must be text" });
    }
    if (quantity !== undefined && quantity !== null && (!Number.isInteger(quantity) || quantity <= 0)) {
      return send(res, 400, { error: "quantity must be a positive integer" });
    }
    if (unit !== undefined && unit !== null && (typeof unit !== "string" || unit.trim().length === 0)) {
      return send(res, 400, { error: "unit must be text" });
    }
    // One transaction so a mid-correct failure writes neither entry nor reason.
    deps.ledger.db.exec("BEGIN IMMEDIATE");
    let entry;
    try {
      entry = deps.ledger.appendCorrection(id, {
        amountKobo: amountKobo ?? original.amount_kobo,
        customer: customer ?? null,
        item,
        quantity,
        unit,
      });
      deps.ledger.recordCorrectionReason(entry.id, reason);
      deps.ledger.db.exec("COMMIT");
    } catch (err) {
      try {
        deps.ledger.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw err;
    }
    return send(res, 200, { entry, verify: deps.ledger.verify(shopId) });
  }

  // Proposes a correction of the shop's latest entry. Nothing is recorded:
  // the trader confirms the proposal as usual (POST /confirm/:id). entryId
  // is optional and must name the latest entry when given; the target is
  // revalidated at confirm time. Omitted values inherit the original;
  // explicit null clears item, quantity and unit.
  if (req.method === "POST" && parts.length === 1 && parts[0] === "correct-last") {
    const body = await readBody(req);
    const fields = body && typeof body === "object" ? body : {};
    if (fields.entryId !== undefined && fields.entryId !== null && (!Number.isInteger(fields.entryId) || fields.entryId <= 0)) {
      return send(res, 400, { error: "entryId must be a positive integer" });
    }
    const { amountKobo, customer, item, quantity, unit, reason } = fields;
    const proposal = proposeCorrection(shopId, fields.entryId ?? null, { amountKobo, customer, item, quantity, unit }, {
      proposals: deps.proposals,
      ledger: deps.ledger,
      reason,
    });
    return send(res, 201, { proposal });
  }

  // Read-only alias of /ledger: same entries (with per-row correction info)
  // and the same verification, under the entry namespace the web app uses
  // for its per-row Edit buttons.
  if (req.method === "GET" && parts.length === 1 && parts[0] === "entries") {
    return send(res, 200, { entries: withCorrectionInfo(deps.ledger, shopId), verify: deps.ledger.verify(shopId) });
  }

  // Proposes a correction of ANY past entry of the caller's own shop — not
  // only the latest. Plain-code checks only (no model call); nothing is
  // recorded until the trader confirms the proposal as usual
  // (POST /confirm/:id). Missing ids and other shops' ids both read 404.
  // Like every other propose route it honours x-request-id, so offline
  // retries replay the stored proposal instead of proposing twice.
  if (req.method === "POST" && parts.length === 3 && parts[0] === "entries" && parts[2] === "correct") {
    const id = Number(decodeURIComponent(parts[1]));
    if (!Number.isInteger(id) || id <= 0) return send(res, 400, { error: "bad entry id" });
    const probe = deps.ledger.get(id);
    if (!probe || probe.shop_id !== shopId) return send(res, 404, { error: "entry not found" });
    const body = await readBody(req);
    const fields = body && typeof body === "object" ? body : {};
    const occurredAt = readOccurredAt(body);
    return idempotentPropose(req, res, deps, shopId, () =>
      proposeCorrection(shopId, id, fields, {
        proposals: deps.proposals,
        ledger: deps.ledger,
        reason: fields.reason,
        heard: typeof fields.heard === "string" ? fields.heard : null,
        scope: "any",
        occurredAt,
      }));
  }

  // Read-only debt views for the caller's own shop: what the WhatsApp debt
  // commands use. Promise statuses refresh first (derived-state maintenance
  // like proposal expiry; the ledger is never written here).
  if (req.method === "GET" && parts.length === 1 && parts[0] === "debts") {
    refreshPromises(deps.promises, deps.ledger, shopId, {});
    const rows = deps.ledger.list(shopId);
    const promises = deps.promises ? deps.promises.listByShop(shopId) : [];
    return send(res, 200, { debts: customerDebts(rows, {}), chase: chaseForShop(rows, promises, {}) });
  }

  if (req.method === "GET" && parts.length === 1 && parts[0] === "promises") {
    refreshPromises(deps.promises, deps.ledger, shopId, {});
    return send(res, 200, { promises: deps.promises ? deps.promises.listByShop(shopId) : [] });
  }

  if (req.method === "GET" && parts.length === 1 && parts[0] === "report") {
    refreshPromises(deps.promises, deps.ledger, shopId, {});
    const rows = deps.ledger.list(shopId);
    const promises = deps.promises ? deps.promises.listByShop(shopId) : [];
    const paymentChecks = deps.photoChecks ? deps.photoChecks.listUnconfirmedByShop(shopId) : [];
    return send(res, 200, { report: moneyLeakReport(rows, promises, { paymentChecks }) });
  }

  // Monthly CSV export for the caller's own shop: confirmed ledger rows
  // only (proposals never land here), plain code, no model, no cap charge.
  // Month boundaries use Africa/Lagos days; a missing month reads as the
  // current Lagos month, a bad one is a plain-words 400. The file opens
  // with a UTF-8 BOM so Excel reads it correctly.
  if (req.method === "GET" && parts.length === 2 && parts[0] === "reports" && parts[1] === "monthly.csv") {
    let parsed;
    try {
      parsed = parseReportMonth(url.searchParams.get("month"), Date.now());
    } catch (err) {
      return send(res, err.status ?? 400, { error: err.message ?? "month must look like 2026-10" });
    }
    const { csv } = buildMonthlyCsv(deps.ledger.list(shopId), parsed.month);
    const body = Buffer.from(csv, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pocketoga-${parsed.month}.csv"`,
      "Content-Length": body.length,
    });
    res.end(body);
    return;
  }

  // Every effective sale with oldest-first payment allocation: what was
  // sold, for how much, what is paid and what is still owed. Read-only.
  if (req.method === "GET" && parts.length === 1 && parts[0] === "sales") {
    const sales = allocatedSales(deps.ledger.list(shopId), {}).map((s) => ({
      id: s.id,
      customer: s.customer,
      item: s.item,
      quantity: s.quantity,
      unit: s.unit,
      amountKobo: s.amountKobo,
      paidKobo: s.paidKobo,
      owedKobo: s.remainingKobo,
      ageDays: s.ageDays,
      createdAt: s.createdAt,
    }));
    return send(res, 200, { sales });
  }

  // Products catalog for the caller's own shop, with stock computed from
  // the ledger. Read-only; the catalog grows when notes confirm.
  if (req.method === "GET" && parts.length === 1 && parts[0] === "products") {
    const catalog = deps.products ? deps.products.listByShop(shopId) : [];
    const stocked = withStock(catalog, deps.ledger.list(shopId)).map(toProductJson);
    return send(res, 200, { products: stocked });
  }

  // Trader-set prices only; the model never touches them. Whole
  // non-negative kobo; another shop's product is refused.
  if (req.method === "POST" && parts.length === 2 && parts[0] === "products") {
    const id = Number(decodeURIComponent(parts[1]));
    const row = Number.isInteger(id) && deps.products ? deps.products.get(id) : null;
    if (!row) return send(res, 404, { error: "product not found" });
    if (row.shop_id !== shopId) return send(res, 403, { error: "that product belongs to another shop" });
    const body = await readBody(req);
    const fields = body && typeof body === "object" ? body : {};
    const { sellPriceKobo, costPriceKobo } = fields;
    if (sellPriceKobo === undefined && costPriceKobo === undefined) {
      return send(res, 400, { error: "pass sellPriceKobo and/or costPriceKobo" });
    }
    for (const [field, value] of [
      ["sellPriceKobo", sellPriceKobo],
      ["costPriceKobo", costPriceKobo],
    ]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        return send(res, 400, { error: `${field} must be a non-negative integer (kobo)` });
      }
    }
    const updated = deps.products.setPrices(id, { sellPriceKobo, costPriceKobo });
    const [stocked] = withStock([updated], deps.ledger.list(shopId));
    return send(res, 200, { product: toProductJson(stocked) });
  }

  // Customers directory for the caller's own shop, plus names that exist
  // only in the ledger. Balances come from debts.mjs. Read-only.
  if (req.method === "GET" && parts.length === 1 && parts[0] === "customers") {
    const directory = deps.customers ? deps.customers.listByShop(shopId) : [];
    return send(res, 200, { customers: describeCustomers(directory, deps.ledger.list(shopId), shopId) });
  }

  // Create or update by normalized name. A phone needs consent: true and
  // is normalized to digits with a country code; without a phone no
  // consent is needed. Phones never touch the ledger. A missing name gets
  // the shop's next automatic label ("Customer 1", "Customer 2", ...).
  if (req.method === "POST" && parts.length === 1 && parts[0] === "customers") {
    const body = await readBody(req);
    const fields = body && typeof body === "object" ? body : {};
    // A missing name gets the shop's next automatic label ("Customer 1",
    // "Customer 2", ...); a present-but-blank name is still a 400.
    if (fields.name !== undefined && fields.name !== null && (typeof fields.name !== "string" || !fields.name.trim())) {
      return send(res, 400, { error: "customer name is required" });
    }
    let name = typeof fields.name === "string" ? fields.name.trim().replace(/\s+/g, " ") : "";
    if (!name) {
      const taken = deps.ledger.list(shopId).map((r) => r.customer);
      const labelDb = deps.db ?? deps.ledger?.db ?? deps.proposals?.db ?? null;
      if (!labelDb) return send(res, 500, { error: "customer labels are unavailable" });
      name = nextAutoCustomerLabel(labelDb, shopId, taken);
    }
    const hasPhone = fields.phone !== undefined && fields.phone !== null;
    if (hasPhone && fields.consent !== true) {
      return send(res, 400, { error: "consent: true is required to store a phone number" });
    }
    let phone = null;
    if (hasPhone) {
      try {
        phone = normalizePhone(fields.phone);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    const row = deps.customers.upsert({ shopId, name, phone, consent: fields.consent ?? null });
    const customer = describeCustomers([row], deps.ledger.list(shopId), shopId).find((c) => c.id === row.id);
    return send(res, 200, { customer });
  }

  // Forget-me: removes the phone and consent, keeps the customer row.
  if (req.method === "POST" && parts.length === 3 && parts[0] === "customers" && parts[2] === "clear-phone") {
    const id = Number(decodeURIComponent(parts[1]));
    const row = Number.isInteger(id) && deps.customers ? deps.customers.get(id) : null;
    if (!row) return send(res, 404, { error: "customer not found" });
    if (row.shop_id !== shopId) return send(res, 403, { error: "that customer belongs to another shop" });
    const cleared = deps.customers.clearPhone(id);
    const customer = describeCustomers([cleared], deps.ledger.list(shopId), shopId).find((c) => c.id === cleared.id);
    return send(res, 200, { customer });
  }

  // Rename a customer label within the caller's own shop: a correction, not
  // a rewrite of history. Every ledger row carrying the old name gets a
  // correction row with the new name (balances follow the new name); the
  // directory entry is renamed in place. 404 when this shop has no such
  // customer, so another shop's labels are unreachable.
  if (req.method === "POST" && parts.length === 2 && parts[0] === "customers" && parts[1] === "rename") {
    const body = await readBody(req);
    const fields = body && typeof body === "object" ? body : {};
    const from = typeof fields.from === "string" ? fields.from.trim().replace(/\s+/g, " ") : "";
    const to = typeof fields.to === "string" ? fields.to.trim().replace(/\s+/g, " ") : "";
    if (!from) return send(res, 400, { error: "from is required" });
    if (!to) return send(res, 400, { error: "to is required" });
    if (to.length > 100) return send(res, 400, { error: "customer must be under 100 characters" });
    if (normCustomerName(from) === normCustomerName(to)) {
      return send(res, 400, { error: "the new name is the same as the current name" });
    }
    const shopRows = deps.ledger.list(shopId);
    const rows = shopRows.filter((r) => r.customer === from);
    const directory = deps.customers ? deps.customers.listByShop(shopId) : [];
    const dirRow = directory.find((c) => normCustomerName(c.name) === normCustomerName(from)) ?? null;
    if (rows.length === 0 && !dirRow) return send(res, 404, { error: "customer not found" });
    const clashDir = directory.find((c) => normCustomerName(c.name) === normCustomerName(to) && (!dirRow || c.id !== dirRow.id));
    const clashLedger = shopRows.some((r) => normCustomerName(r.customer) === normCustomerName(to));
    if (clashDir || clashLedger) return send(res, 409, { error: "the new name is already used in this shop" });
    const reason = typeof fields.reason === "string" && fields.reason.trim() ? fields.reason.trim() : `rename ${from} to ${to}`;
    let renamed = null;
    if (dirRow) {
      try {
        renamed = deps.customers.rename({ shopId, from: dirRow.name, to });
      } catch (err) {
        return send(res, err.status ?? 400, { error: err.message });
      }
    }
    deps.ledger.db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of rows) {
        const entry = deps.ledger.appendCorrection(r.id, { amountKobo: r.amount_kobo, customer: to });
        deps.ledger.recordCorrectionReason(entry.id, reason);
      }
      deps.ledger.db.exec("COMMIT");
    } catch (err) {
      try {
        deps.ledger.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw err;
    }
    const customer = renamed
      ? describeCustomers([renamed], deps.ledger.list(shopId), shopId).find((c) => c.id === renamed.id)
      : null;
    return send(res, 200, { renamed: rows.length, customer });
  }

  // Profit for a period, this shop only. Read-only; all maths in profit.mjs.
  // A missing period reads as today; anything else must name a real period.
  if (req.method === "GET" && parts.length === 1 && parts[0] === "profit") {
    const period = url.searchParams.get("period") ?? "today";
    if (!PROFIT_PERIODS.includes(period)) {
      return send(res, 400, { error: `unknown period "${period}" (want today, week, month or year)` });
    }
    return send(res, 200, profitForPeriod(deps.ledger.list(shopId), period, {}));
  }

  // Expenses recorded in a period, this shop only. Read-only.
  if (req.method === "GET" && parts.length === 1 && parts[0] === "expenses") {
    const period = url.searchParams.get("period") ?? "today";
    if (!PROFIT_PERIODS.includes(period)) {
      return send(res, 400, { error: `unknown period "${period}" (want today, week, month or year)` });
    }
    return send(res, 200, expensesForPeriod(deps.ledger.list(shopId), period, {}));
  }

  // Today's summary text for the logged-in shop. Authenticated like every
  // other shop route; the webhook-only listener never serves it (404).
  if (req.method === "GET" && parts.length === 2 && parts[0] === "summary" && parts[1] === "preview") {
    return send(res, 200, { text: previewSummaryText(deps, shopId, Date.now()) });
  }

  return send(res, 404, { error: "not found" });
}

// One log line per finished request: method, path without query string,
// status, duration, masked shop, and a short scrubbed fragment on failure.
// Unexpected handler errors are logged once here; the response stays the
// same plain JSON error as before.
function withRequestLog(handler) {
  return (req, res) => {
    const t0 = Date.now();
    const path = String(req.url ?? "/").split("?")[0] || "/";
    const shop = req.headers ? req.headers["x-shop-id"] ?? null : null;
    const rawRid = req.headers ? req.headers["x-request-id"] : null;
    const rid = typeof rawRid === "string" && rawRid.trim() ? rawRid.trim() : null;
    let status = null;
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = (code, ...rest) => {
      status = code;
      return origWriteHead(code, ...rest);
    };
    handler(req, res).then(
      () => logLine(formatRequestLog({ method: req.method, path, status: status ?? 200, ms: Date.now() - t0, shop })),
      (err) => {
        if (!res.headersSent) send(res, err.status ?? 500, { error: err.message ?? "internal error" });
        logLine(
          formatRequestLog({ method: req.method, path, status: status ?? err.status ?? 500, ms: Date.now() - t0, shop, rid, error: err })
        );
      }
    );
  };
}

export function createVoiceServer(deps) {
  return createServer(withRequestLog((req, res) => handleVoiceRequest(req, res, deps)));
}

// Webhook-only listener. Serves GET/POST /webhook through the shared
// handlers (same signature check, dedupe, allow-list) and 404s every other
// path and method. This is the listener to tunnel; the main server is not.
export async function handleWebhookOnlyRequest(req, res, deps) {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/webhook") {
    return send(res, 404, { error: "not found" });
  }
  return handleWebhookRoute(req, res, url, deps);
}

export function createWebhookServer(deps) {
  return createServer(withRequestLog((req, res) => handleWebhookOnlyRequest(req, res, deps)));
}

// Builds every dependency the HTTP handlers need — real model client,
// ledger, proposals, promises, products, customers, second opinions —
// without opening any listening socket. The entry point calls this and
// then listens; tests call it with a fake env so a missing import or
// undefined dependency fails the suite.
export function buildDeps(env = process.env) {
  const dbPath = resolveDbPath(env);
  if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  return {
    db,
    ledger: new Ledger(db),
    proposals: new ProposalStore(db),
    promises: new PromiseStore(db),
    products: new ProductStore(db),
    customers: new CustomerStore(db),
    secondOpinions: new SecondOpinionStore(db),
    photoChecks: new PhotoCheckStore(db),
    idempotency: new IdempotencyStore(db),
    feedback: new FeedbackStore(db),
    auths: new AuthStore(db),
    model: createModelClient({ apiKey: env.META_API_KEY ?? null }),
    modelCaps: new ModelCapStore(db),
    dailyCaps: resolveDailyCaps(env),
    env,
  };
}

const invokedAsMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  const env = process.env;
  // Start-up checks first, so a missing key or binary is visible even when
  // boot later fails. Names only, never values.
  for (const line of startupEnvLines(env)) logLine(line);
  logLine(ffmpegAvailable() ? "ffmpeg: ok" : "warning: ffmpeg is missing; voice notes will fail");
  const dataDir = resolveDataDir(env);
  const dbPath = resolveDbPath(env);
  mkdirSync(dataDir, { recursive: true });
  // Ephemeral disk (Render free plan) starts empty: bring back the newest
  // backup when the main file is gone, before anything opens the database.
  if (dbPath !== ":memory:" && restoreIfMissing(dbPath, dataDir)) {
    console.log("database restored from backup");
  }
  const deps = buildDeps(env);
  // One boot line names the outcome, so a missing frontend is visible in
  // the host logs instead of surfacing as a shop-header error on "/".
  const staticRoot = findStaticRoot();
  deps.static = createStaticHandler(staticRoot);
  if (staticRoot) console.log(`static web: serving ${staticRoot}`);
  else console.log(`static web: no dist folder found (checked ${STATIC_CANDIDATES.join(", ")}); API only`);
  // The free plan resets storage on restart, so the public demo reseeds on
  // every boot that finds it empty — before the server accepts requests.
  // Milliseconds, no model calls, no keys needed.
  const seed = seedDemoShop(deps);
  if (seed.seeded) console.log(`demo shop seeded: ${seed.entries} entries`);
  // SQLite backup every 10 minutes (VACUUM INTO, never a raw copy) and once
  // more at shutdown. Log lines carry no data.
  const backupTimer = setInterval(() => {
    try {
      backupNow(deps.db, dataDir);
    } catch {
      console.log("scheduled backup failed");
    }
  }, 10 * 60 * 1000);
  const server = createVoiceServer(deps);
  const port = Number(env.PORT ?? 3000);
  server.listen(port, "0.0.0.0", () => console.log(`pocketoga on :${port} (one origin: app + webhook)`));
  // Local tunnel setup only: a second listener serving just /webhook, kept
  // when WEBHOOK_PORT is explicitly set to something other than PORT.
  // Render sets only PORT, so one public URL serves everything there.
  const webhookPort = Number(env.WEBHOOK_PORT ?? port);
  let webhookServer = null;
  if (env.WEBHOOK_PORT && webhookPort !== port) {
    webhookServer = createWebhookServer(deps);
    webhookServer.listen(webhookPort, () => console.log(`webhook-only on :${webhookPort} (tunnel this one)`));
  }
  // Daily summary scheduler: once a minute, main process only. Per-shop
  // errors are logged (masked) inside the tick; this catch is one static
  // line so a failure can never leak secrets or numbers.
  const summaryTimer = setInterval(() => {
    runSummaryTick(deps, {}).catch(() => console.log("summary tick failed"));
  }, 60_000);
  // Graceful shutdown: stop timers, finish in-flight requests, back up once
  // more, then close the database. Idle keep-alive sockets are dropped first
  // so close() never hangs on them; a backstop exits after 10 seconds.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    clearInterval(backupTimer);
    clearInterval(summaryTimer);
    server.closeIdleConnections();
    server.close(() => {
      if (webhookServer) webhookServer.close();
      try {
        if (dbPath !== ":memory:") backupNow(deps.db, dataDir);
      } catch {
        console.log("shutdown backup failed");
      }
      deps.db.close();
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
