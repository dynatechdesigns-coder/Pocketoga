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
    return send(res, 200, { entries: deps.ledger.list(shopId), verify: deps.ledger.verify(shopId) });
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

  return send(res, 404, { error: "not found" });
}

export function createVoiceServer({ ledger, proposals, promises, model }) {
  return createServer((req, res) => {
    handleVoiceRequest(req, res, { ledger, proposals, promises, model }).catch((err) => {
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

export function createWebhookServer({ ledger, proposals, promises, model }) {
  return createServer((req, res) => {
    handleWebhookOnlyRequest(req, res, { ledger, proposals, promises, model }).catch((err) => {
      if (!res.headersSent) send(res, err.status ?? 500, { error: err.message ?? "internal error" });
    });
  });
}

const invokedAsMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  const db = new DatabaseSync(process.env.LEDGER_DB ?? "pocketoga.db");
  const deps = {
    ledger: new Ledger(db),
    proposals: new ProposalStore(db),
    promises: new PromiseStore(db),
    model: createModelClient({}),
  };
  const port = Number(process.env.PORT ?? 3000);
  const webhookPort = Number(process.env.WEBHOOK_PORT ?? 3001);
  createVoiceServer(deps).listen(port, () =>
    console.log(`main server on :${port} (local only, never tunnel)`)
  );
  createWebhookServer(deps).listen(webhookPort, () =>
    console.log(`webhook server on :${webhookPort} (tunnel this one)`)
  );
}
