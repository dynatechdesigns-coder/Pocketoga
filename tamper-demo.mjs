// Tamper demo: proves verify() catches edits made behind the triggers' back.
// Local script only — NOT an HTTP route. Fake data only; never point it at a
// database you cannot restore.
//
//   node tamper-demo.mjs <shop-id> [seq] [--db <path> capture.py
//     Backs up the db, drops the no-update trigger, bumps one old entry's
//     amount_kobo by 100 (₦1), restores the triggers, prints verify(shopId).
//   node tamper-demo.mjs --restore [--db <path>]
//     Restores the backup taken by the last tamper run.
//   node tamper-demo.mjs --help
//
// The db defaults to $LEDGER_DB, else pocketoga.db. The backup refuses to
// overwrite an unrestored backup: restore (or delete it) before re-running.
import { copyFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Ledger, SCHEMA } from "./ledger.mjs";

const TAMPER_DELTA_KOBO = 100;

function usage(exitCode) {
  console.log(`usage:
  node tamper-demo.mjs <shop-id> [seq] [--db <path>]
  node tamper-demo.mjs --restore [--db <path>]
  node tamper-demo.mjs --help`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { shopId: null, seq: 1, dbPath: null, restore: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") usage(0);
    else if (a === "--restore") args.restore = true;
    else if (a === "--db") {
      args.dbPath = argv[++i];
      if (!args.dbPath) {
        console.error("--db needs a path");
        usage(1);
      }
    } else if (a.startsWith("--")) {
      console.error(`unknown flag ${a}`);
      usage(1);
    } else positional.push(a);
  }
  if (!args.restore) {
    args.shopId = positional[0] ?? null;
    if (!args.shopId) {
      console.error("shop-id is required (or use --restore)");
      usage(1);
    }
    if (positional[1] !== undefined) {
      args.seq = Number(positional[1]);
      if (!Number.isInteger(args.seq) || args.seq <= 0) {
        console.error(`bad seq: ${positional[1]} (want a positive integer)`);
        process.exit(1);
      }
    }
    if (positional.length > 2) {
      console.error("too many arguments");
      usage(1);
    }
  }
  args.dbPath = args.dbPath ?? process.env.LEDGER_DB ?? "pocketoga.db";
  return args;
}

function doRestore(dbPath) {
  const backup = `${dbPath}.tamper-demo-backup`;
  if (!existsSync(backup)) {
    console.error(`no backup found at ${backup}; nothing to restore`);
    process.exit(1);
  }
  copyFileSync(backup, dbPath);
  console.log(`restored ${dbPath} from ${backup}`);
  const db = new DatabaseSync(dbPath);
  try {
    const ledger = new Ledger(db);
    console.log("verify after restore:", JSON.stringify(ledger.verify()));
  } finally {
    db.close();
  }
}

function doTamper(dbPath, shopId, seq) {
  if (!existsSync(dbPath)) {
    console.error(`database not found: ${dbPath}`);
    process.exit(1);
  }
  const backup = `${dbPath}.tamper-demo-backup`;
  if (existsSync(backup)) {
    console.error(`backup already exists at ${backup}; run --restore (or delete it) first`);
    process.exit(1);
  }
  copyFileSync(dbPath, backup);
  console.log(`backed up ${dbPath} -> ${backup}`);

  const db = new DatabaseSync(dbPath);
  try {
    const ledger = new Ledger(db); // also ensures the triggers exist
    const entry = db
      .prepare("SELECT * FROM ledger_entries WHERE shop_id = ? AND seq = ?")
      .get(shopId, seq);
    if (!entry) {
      console.error(`no entry at shop ${shopId} seq ${seq}; shops present: ${ledger.shops().join(", ") || "(none)"}`);
      process.exit(1);
    }
    const newAmount = entry.amount_kobo + TAMPER_DELTA_KOBO;
    console.log(
      `tampering id=${entry.id} shop=${shopId} seq=${seq}: amount_kobo ${entry.amount_kobo} -> ${newAmount}`
    );

    db.exec("DROP TRIGGER ledger_entries_no_update"); // bypass: attacker with db access
    db.prepare("UPDATE ledger_entries SET amount_kobo = ? WHERE id = ?").run(newAmount, entry.id);
    db.exec(SCHEMA); // triggers back on; the edit stays and must be detected

    console.log("verify reports:", JSON.stringify(ledger.verify(shopId), null, 2));
    console.log(`to undo: node tamper-demo.mjs --restore --db ${dbPath}`);
  } finally {
    db.close();
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.restore) doRestore(args.dbPath);
else doTamper(args.dbPath, args.shopId, args.seq);
