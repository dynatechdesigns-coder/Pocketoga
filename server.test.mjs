// Startup wiring: buildDeps must return every dependency the handlers need.
// Fake env only; nothing listens and nothing touches the real database, so a
// missing import or undefined dependency fails the suite instead of prod.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDeps, handleVoiceRequest, handleWebhookOnlyRequest } from "./server.mjs";
import { Ledger } from "./ledger.mjs";
import { ProposalStore } from "./proposals.mjs";
import { PromiseStore } from "./promises.mjs";
import { ProductStore } from "./products.mjs";
import { CustomerStore } from "./customers.mjs";
import { SecondOpinionStore } from "./secondopinion.mjs";

const FAKE_ENV = {
  LEDGER_DB: ":memory:",
  META_API_KEY: "fake-test-key",
  WHATSAPP_VERIFY_TOKEN: "fake-verify-token",
};

function fakeReq({ method = "GET", url = "/", headers = {} } = {}) {
  return { method, url, headers };
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    text: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    end(chunk) {
      if (chunk) this.text += String(chunk);
    },
  };
}

describe("server startup wiring (fake env)", () => {
  it("buildDeps returns every dependency the handlers need", async () => {
    const deps = buildDeps(FAKE_ENV);
    try {
      assert.ok(deps.ledger instanceof Ledger);
      assert.ok(deps.proposals instanceof ProposalStore);
      assert.ok(deps.promises instanceof PromiseStore);
      assert.ok(deps.products instanceof ProductStore);
      assert.ok(deps.customers instanceof CustomerStore);
      assert.ok(deps.secondOpinions instanceof SecondOpinionStore);
      assert.equal(typeof deps.model.complete, "function");

      // A debt route runs against built deps: needs ledger + promises.
      const req = fakeReq({ url: "/report", headers: { "x-shop-id": "wiring-shop" } });
      const res = fakeRes();
      await handleVoiceRequest(req, res, deps);
      assert.equal(res.statusCode, 200);
      assert.ok("report" in JSON.parse(res.text));

      // The webhook handshake runs against built deps + fake env.
      const hookReq = fakeReq({ url: "/webhook?hub.mode=subscribe&hub.verify_token=fake-verify-token&hub.challenge=CH-1" });
      const hookRes = fakeRes();
      await handleWebhookOnlyRequest(hookReq, hookRes, deps);
      assert.equal(hookRes.statusCode, 200);
      assert.equal(hookRes.text, "CH-1");
    } finally {
      deps.db.close();
    }
  });
});
