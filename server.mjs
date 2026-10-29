// Minimal HTTP API for the voice-to-confirm loop. Node built-ins only.
// Identity is deliberately small: the caller names its shop with the
// x-shop-id header, and every proposal-scoped route refuses cross-shop
// access with 403. Run directly: `node server.mjs` (PORT/LEDGER_DB env).
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { PromiseStore, refreshPromises } from "./promises.mjs";
import { customerDebts, chaseForShop } from "./debts.mjs";
import { moneyLeakReport } from "./leak.mjs";
import { ProductStore, withStock, toProductJson } from "./products.mjs";
import { CustomerStore, describeCustomers, normalizePhone } from "./customers.mjs";
import { createModelClient } from "./model.mjs";
import { propose, confirmProposal, fixProposal, rejectProposal, getProposal } from "./voice.mjs";
import {
  verifyWhatsAppSignature,
  verifyWebhookSubscription,
  processWhatsAppPayload,
  trackWhatsAppJob,
  buildWhatsAppContext,
} from "./whatsapp.mjs";

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

// Each entry gains correctedById (the latest correcting entry's id in
// chain order, or null) and correctionReason (the logged reason, or null
// when uncorrected or corrected before reasons existed).
function withCorrectionInfo(ledger, shopId) {
  const entries = ledger.list(shopId);
  const latest = new Map();
  for (const e of entries) {
    if (e.corrects_id === null || e.corrects_id === undefined) continue;
    const prev = latest.get(e.corrects_id);
    if (!prev || e.seq > prev.seq || (e.seq === prev.seq && e.id > prev.id)) {
      latest.set(e.corrects_id, e);
    }
  }
  return entries.map((e) => {
    const fix = latest.get(e.id);
    return { ...e, correctedById: fix ? fix.id : null, correctionReason: fix ? ledger.correctionReason(fix.id) : null };
  });
}

// Exported for in-process tests; createVoiceServer wires it to real sockets.
export async function handleVoiceRequest(req, res, deps) {
  const url = new URL(req.url ?? "/", "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  // Tunnel guard: with WEBHOOK_PUBLIC_ONLY=1, requests that arrived via the
  // public tunnel (Cloudflare / proxy headers present) may only use /webhook.
  // Local traffic without those headers behaves as before.
  if ((deps.env ?? process.env).WEBHOOK_PUBLIC_ONLY === "1") {
    const viaTunnel = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"];
    if (viaTunnel && !(parts.length >= 1 && parts[0] === "webhook")) {
      return send(res, 404, { error: "not found" });
    }
  }
  if (parts.length >= 1 && parts[0] === "webhook") {
    return handleWebhookRoute(req, res, url, deps);
  }
  const shopHeader = req.headers["x-shop-id"];
  if (typeof shopHeader !== "string" || !shopHeader.trim()) {
    return send(res, 400, { error: "x-shop-id header is required" });
  }
  const shopId = shopHeader.trim();

  if (req.method === "POST" && parts.length === 1 && parts[0] === "propose") {
    const body = await readBody(req);
    const input =
      body.text !== undefined
        ? body.text
        : body.audioBase64 !== undefined
          ? { audioBase64: body.audioBase64, audioFormat: body.audioFormat }
          : undefined;
    const proposal = await propose(shopId, input, deps);
    return send(res, 201, { proposal });
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
    const proposal = await fixProposal(id, shopId, body.correctionText ?? body.text, deps);
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
    return send(res, 200, { report: moneyLeakReport(rows, promises, {}) });
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
  // consent is needed. Phones never touch the ledger.
  if (req.method === "POST" && parts.length === 1 && parts[0] === "customers") {
    const body = await readBody(req);
    const fields = body && typeof body === "object" ? body : {};
    const name = typeof fields.name === "string" ? fields.name.trim().replace(/\s+/g, " ") : "";
    if (!name) return send(res, 400, { error: "customer name is required" });
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

  return send(res, 404, { error: "not found" });
}

export function createVoiceServer({ ledger, proposals, promises, products, customers, model }) {
  return createServer((req, res) => {
    handleVoiceRequest(req, res, { ledger, proposals, promises, products, customers, model }).catch((err) => {
      if (!res.headersSent) send(res, err.status ?? 500, { error: err.message ?? "internal error" });
    });
  });
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

export function createWebhookServer({ ledger, proposals, promises, products, customers, model }) {
  return createServer((req, res) => {
    handleWebhookOnlyRequest(req, res, { ledger, proposals, promises, products, customers, model }).catch((err) => {
      if (!res.headersSent) send(res, err.status ?? 500, { error: err.message ?? "internal error" });
    });
  });
}

// Builds every dependency the HTTP handlers need — real model client,
// ledger, proposals, promises, products, customers — without opening any
// listening socket. The entry point calls this and then listens; tests
// call it with a fake env so a missing import or undefined dependency
// fails the suite.
export function buildDeps(env = process.env) {
  const db = new DatabaseSync(env.LEDGER_DB ?? "pocketoga.db");
  return {
    db,
    ledger: new Ledger(db),
    proposals: new ProposalStore(db),
    promises: new PromiseStore(db),
    products: new ProductStore(db),
    customers: new CustomerStore(db),
    model: createModelClient({ apiKey: env.META_API_KEY ?? null }),
    env,
  };
}

const invokedAsMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  const deps = buildDeps(process.env);
  const port = Number(process.env.PORT ?? 3000);
  const webhookPort = Number(process.env.WEBHOOK_PORT ?? 3001);
  createVoiceServer(deps).listen(port, () =>
    console.log(`main server on :${port} (local only, never tunnel)`)
  );
  createWebhookServer(deps).listen(webhookPort, () =>
    console.log(`webhook server on :${webhookPort} (tunnel this one)`)
  );
}
