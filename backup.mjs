// SQLite backup and restore for the single-file database. Copies use
// VACUUM INTO (an online backup through the engine, never a raw file copy
// of a database that may be mid-write); the restore path runs only at boot
// before anything opens the database, when a plain file copy is safe.
// Log lines carry counts and names only, never row data.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const BACKUP_KEEP = 7;

export function backupDir(dataDir) {
  return join(dataDir, "backups");
}

function stamp(nowMs) {
  return new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

// VACUUM INTO a fresh timestamped file, then prune to the newest 7.
// Skips :memory: databases (nothing to back up).
export function backupNow(db, dataDir, { now = Date.now() } = {}) {
  const name = dbName(db);
  if (!name || name === ":memory:") return null;
  const dir = backupDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `pocketoga-${stamp(now)}.db`);
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  pruneBackups(dir);
  return dest;
}

function dbName(db) {
  try {
    const row = db.prepare("PRAGMA database_list").get();
    return row?.file ?? null;
  } catch {
    return null;
  }
}

export function listBackups(dir) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^pocketoga-.*\.db$/.test(f));
  } catch {
    return [];
  }
  return files
    .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

export function pruneBackups(dir, keep = BACKUP_KEEP) {
  for (const { file } of listBackups(dir).slice(keep)) rmSync(file, { force: true });
}

// Newest backup first, or null when there is none.
export function newestBackup(dir) {
  return listBackups(dir)[0]?.file ?? null;
}

// Copies the newest backup over dbPath when the main file is missing (fresh
// container). Runs before the database is opened, so nothing writes yet.
// Returns the restored path, or null when there was nothing to restore from.
export function restoreIfMissing(dbPath, dataDir) {
  if (existsSync(dbPath)) return null;
  const backup = newestBackup(backupDir(dataDir));
  if (!backup) return null;
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(backup, dbPath);
  return dbPath;
}
