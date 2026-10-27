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
import { createModelClient } from "./model.mjs";
import { propose, confirmProposal, fixProposal, rejectProposal, getProposal } from "./voice.mjs";

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

// Exported for in-process tests; createVoiceServer wires it to real sockets.
export async function handleVoiceRequest(req, res, deps) {
  const url = new URL(req.url ?? "/", "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
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

  return send(res, 404, { error: "not found" });
}

export function createVoiceServer({ ledger, proposals, model }) {
  return createServer((req, res) => {
    handleVoiceRequest(req, res, { ledger, proposals, model }).catch((err) => {
      if (!res.headersSent) send(res, err.status ?? 500, { error: err.message ?? "internal error" });
    });
  });
}

const invokedAsMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  const db = new DatabaseSync(process.env.LEDGER_DB ?? "pocketoga.db");
  const server = createVoiceServer({
    ledger: new Ledger(db),
    proposals: new ProposalStore(db),
    model: createModelClient({}),
  });
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => console.log(`voice server on :${port}`));
}
