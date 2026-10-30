// Deploy wiring: DATA_DIR paths, /health, demo reseed, SQLite backup and
// the same-origin static app. Fake env and temp folders only; the temp
// folder is removed afterwards. No network, no real database touched.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import {
  buildDeps,
  createStaticHandler,
  createVoiceServer,
  findStaticRoot,
  handleVoiceRequest,
  resolveDataDir,
  resolveDbPath,
} from "./server.mjs";
import { seedDemoShop } from "./demo-seed.mjs";
import { backupNow, newestBackup, pruneBackups, restoreIfMissing, BACKUP_KEEP } from "./backup.mjs";
import { Ledger } from "./ledger.mjs";
import { DEMO_SHOP_ID } from "./auth.mjs";

const FAKE_ENV = { LEDGER_DB: ":memory:", META_API_KEY: "fake-test-key" };

let scratch;
before(() => {
  try {
    scratch = mkdtempSync(join(tmpdir(), "pocketoga-deploy-test-"));
  } catch {
    scratch = mkdtempSync("./.deploy-test-tmp-");
  }
});
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fakeReq({ method = "GET", url = "/", headers = {} } = {}) {
  return { method, url, headers };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    writeHead(status, headers) {
      res.statusCode = status;
      Object.assign(res.headers, headers);
    },
    end(chunk) {
      if (chunk) res.chunks.push(Buffer.from(chunk));
    },
    get text() {
      return Buffer.concat(res.chunks).toString("utf8");
    },
  };
  return res;
}

async function get(deps, url, headers = {}) {
  const res = fakeRes();
  await handleVoiceRequest(fakeReq({ url, headers }), res, deps);
  return res;
}

describe("deploy paths (fake env)", () => {
  it("DATA_DIR defaults to ./data and LEDGER_DB still wins", () => {
    assert.ok(resolveDataDir({}).endsWith("data"));
    assert.equal(resolveDataDir({ DATA_DIR: "/x/y" }), resolve("/x/y"));
    assert.equal(resolveDbPath({ LEDGER_DB: ":memory:" }), ":memory:");
    assert.equal(resolveDbPath({}), join(resolveDataDir({}), "pocketoga.db"));
    assert.equal(resolveDbPath({ DATA_DIR: "/x/y" }), resolve("/x/y", "pocketoga.db"));
  });

  it("buildDeps creates the DATA_DIR folder for a file database", () => {
    const dir = join(scratch, "fresh-data");
    const deps = buildDeps({ ...FAKE_ENV, DATA_DIR: dir, LEDGER_DB: join(dir, "t.db") });
    try {
      assert.ok(existsSync(dir));
      assert.ok(existsSync(join(dir, "t.db")));
    } finally {
      deps.db.close();
    }
  });
});

describe("deploy /health (fake env)", () => {
  it("answers 200 { ok: true } with no shop header and no secrets", async () => {
    const deps = buildDeps(FAKE_ENV);
    try {
      const res = await get(deps, "/health");
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.text), { ok: true });
    } finally {
      deps.db.close();
    }
  });
});

describe("deploy demo reseed (fake data)", () => {
  it("seeds 15entries and 3 promises once, then leaves the shop alone", () => {
    const deps = buildDeps(FAKE_ENV);
    try {
      const first = seedDemoShop(deps);
      assert.equal(first.seeded, true);
      assert.equal(first.entries, 15);
      assert.equal(deps.ledger.verify(DEMO_SHOP_ID).ok, true);
      assert.equal(deps.ledger.verify(DEMO_SHOP_ID).count, 15);
      assert.equal(deps.promises.listByShop(DEMO_SHOP_ID).length, 3);
      const second = seedDemoShop(deps);
      assert.equal(second.seeded, false);
      assert.equal(deps.ledger.verify(DEMO_SHOP_ID).count, 15);
    } finally {
      deps.db.close();
    }
  });
});

describe("deploy backup and restore (fake data)", () => {
  it("backs up with VACUUM INTO, keeps 7, restores when the main file is gone", () => {
    const dir = join(scratch, "backup-data");
    mkdirSync(dir, { recursive: true });
    const main = join(dir, "pocketoga.db");
    const db = new DatabaseSync(main);
    const ledger = new Ledger(db);
    ledger.append({ shopId: "s", type: "sale", amountKobo: 500, customer: "Ada", item: "rice" });
    const dest = backupNow(db, dir);
    assert.ok(dest && existsSync(dest));
    db.close();
    // Nine more backups: only the newest 7 files survive.
    const db2 = new DatabaseSync(main);
    for (let i = 0; i < 9; i++) backupNow(db2, dir, { now: Date.now() + (i + 1) * 1000 });
    db2.close();
    pruneBackups(join(dir, "backups"));
    assert.ok(readdirSync(join(dir, "backups")).length <= BACKUP_KEEP);
    assert.equal(newestBackup(join(dir, "backups")) !== null, true);
    // Main file gone (fresh container): the newest backup restores it.
    rmSync(main);
    assert.equal(restoreIfMissing(main, dir), main);
    const db3 = new DatabaseSync(main);
    try {
      assert.equal(new Ledger(db3).verify("s").ok, true);
      assert.equal(new Ledger(db3).verify("s").count, 1);
    } finally {
      db3.close();
    }
    // Main file present: restore leaves it alone.
    assert.equal(restoreIfMissing(main, dir), null);
  });
});

describe("deploy static app (temp folder)", () => {
  it("serves files, falls back to index.html, 404s missing assets, caches sanely", async () => {
    const root = join(scratch, "dist");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<html>app</html>");
    writeFileSync(join(root, "assets", "app-abc123.js"), "console.log(1)");
    const serve = createStaticHandler(root);
    assert.equal(typeof serve, "function");
    const deps = buildDeps(FAKE_ENV);
    try {
      deps.static = serve;
      let res = await get(deps, "/");
      assert.equal(res.statusCode, 200);
      assert.ok(res.text.includes("app"));
      assert.equal(res.headers["Cache-Control"], "no-store");
      res = await get(deps, "/assets/app-abc123.js");
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["Cache-Control"], "public, max-age=31536000, immutable");
      res = await get(deps, "/login");
      assert.equal(res.statusCode, 200);
      assert.ok(res.text.includes("app"));
      res = await get(deps, "/missing.png");
      assert.equal(res.statusCode, 404);
      // API routes still win over static, with auth intact.
      res = await get(deps, "/ledger");
      assert.equal(res.statusCode, 400);
      res = await get(deps, "/api/ledger");
      assert.equal(res.statusCode, 400);
      // Gzip when the client accepts it.
      res = await get(deps, "/assets/app-abc123.js", { "accept-encoding": "gzip" });
      assert.equal(res.headers["Content-Encoding"], "gzip");
    } finally {
      deps.db.close();
    }
  });

  it("returns null without a build folder (backend-only mode)", () => {
    assert.equal(createStaticHandler(null), null);
    assert.equal(createStaticHandler(join(scratch, "no-such-dir")), null);
  });

  it("serves / with no header, keeps the shop check on API paths, leaves /health alone", async () => {
    const root = join(scratch, "dist-root");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<html>app</html>");
    writeFileSync(join(root, "assets", "app-1.js"), "console.log(1)");
    const deps = buildDeps(FAKE_ENV);
    try {
      deps.static = createStaticHandler(root);
      const none = {};
      let res = await get(deps, "/", none);
      assert.equal(res.statusCode, 200);
      assert.ok(res.text.includes("<html>app</html>"));
      res = await get(deps, "/assets/app-1.js", none);
      assert.equal(res.statusCode, 200);
      assert.ok(res.text.includes("console.log(1)"));
      res = await get(deps, "/ledger", none);
      assert.equal(res.statusCode, 400);
      assert.deepEqual(JSON.parse(res.text), { error: "x-shop-id header is required" });
      res = await get(deps, "/health", none);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.text), { ok: true });
    } finally {
      deps.db.close();
    }
  });

  it("finds the dist folder by presence, never by NODE_ENV", () => {
    const present = join(scratch, "dist-found");
    mkdirSync(present, { recursive: true });
    assert.equal(findStaticRoot([join(scratch, "nope"), present]), present);
    assert.equal(findStaticRoot([join(scratch, "nope")]), null);
  });

  it("the production server wiring serves / (same factory the main block uses)", async () => {
    // Goes through createVoiceServer — the layer that wires the handler to
    // real sockets — instead of calling the handler directly, so a dropped
    // dep in that factory fails here. No listening socket: the request is
    // emitted straight into the server's listener.
    const root = join(scratch, "dist-prod");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<html>prod app</html>");
    writeFileSync(join(root, "assets", "app-2.js"), "console.log(2)");
    const deps = buildDeps(FAKE_ENV);
    try {
      deps.static = createStaticHandler(root);
      const server = createVoiceServer(deps);
      const run = (method, url, headers = {}) =>
        new Promise((done) => {
          const req = new EventEmitter();
          req.method = method;
          req.url = url;
          req.headers = headers;
          req.destroy = () => {};
          let text = "";
          const res = new EventEmitter();
          res.headersSent = false;
          res.writeHead = (status) => {
            res.statusCode = status;
            res.headersSent = true;
          };
          res.end = (chunk) => {
            if (chunk) text += chunk;
            done({ status: res.statusCode, text });
          };
          server.emit("request", req, res);
        });
      const none = {};
      let res = await run("GET", "/", none);
      assert.equal(res.status, 200);
      assert.ok(res.text.includes("<html>prod app</html>"));
      res = await run("GET", "/assets/app-2.js", none);
      assert.equal(res.status, 200);
      assert.ok(res.text.includes("console.log(2)"));
      res = await run("GET", "/settings", none);
      assert.equal(res.status, 200);
      assert.ok(res.text.includes("<html>prod app</html>"));
      res = await run("GET", "/health", none);
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.text), { ok: true });
      res = await run("GET", "/ledger", none);
      assert.equal(res.status, 400);
      assert.deepEqual(JSON.parse(res.text), { error: "x-shop-id header is required" });
    } finally {
      deps.db.close();
    }
  });
});
