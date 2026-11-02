// Minimal ".env.local" loader: KEY=VALUE lines (comments, blanks and bad
// lines ignored, optional `export ` prefix, single/double quotes stripped)
// fill process.env only for variables the real environment did not set, so
// a judge's `cp .env.example .env.local` just works and Render/dashboard
// values always win. Never logs or returns values — only counts.
import { readFileSync } from "node:fs";

export function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// Reads path (default ".env.local") into env (default process.env).
// Returns { path, loaded } where loaded counts newly-set variables.
// A missing file is fine (returns loaded 0); an unreadable one throws.
export function loadEnvFile(path = ".env.local", env = process.env) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { path, loaded: 0 };
    throw err;
  }
  const parsed = parseEnvText(text);
  let loaded = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
      loaded++;
    }
  }
  return { path, loaded };
}
