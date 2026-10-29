// Proves a production build contains no mock fallback.
//
//   npm run check:build
//
// 1. Builds the app the way production does, into a temporary folder, with
//    MOCK_CONTRACT=1 set on purpose. The flag is development-only, so the
//    build must ignore it.
// 2. Scans every file of that build for the mock's name, its flag, its address,
//    its banner text and the fake records it serves.
// 3. Scans src/ for imports of anything under scripts/ and for the same fake
//    records, so source cannot quietly carry mock data into a build.
// 4. Confirms the "not available yet" state is in the build (the honest answer
//    when a route is missing).
//
// Exits 1 with the offending file and text on any hit.
import { build } from "vite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Text that only the mock server, its banner or its fake records contain.
const FORBIDDEN = [
  "mock-contract",
  "MOCK_CONTRACT",
  "MOCK_URL",
  "localhost:3999",
  "Mock server on",
  // fake records served by the mock (scripts/mock-contract.mjs)
  "Keke to Mile 12",
  "Lunch for shop boy",
  "Shelf carpenter",
  "Prepaid meter",
  "Market association",
  "08030000011",
  "08030000015",
];

// What the app shows when a route does not exist yet.
const REQUIRED = ["Not available yet", "needs the newer PocketOga server"];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

const problems = [];
const scan = (label, dir, { text = FORBIDDEN, skip = () => false } = {}) => {
  let count = 0;
  for (const file of files(dir)) {
    if (skip(file) || /\.(png|webp|ico|woff2?)$/i.test(file)) continue;
    const body = readFileSync(file, "utf8");
    count++;
    for (const needle of text) if (body.includes(needle)) problems.push(`${label}: ${relative(root, file)} contains "${needle}"`);
  }
  return count;
};

// 1. Production build with the dev flag on.
const out = mkdtempSync(join(tmpdir(), "pocketoga-build-"));
process.env.MOCK_CONTRACT = "1";
process.env.MOCK_URL = "http://localhost:3999";
try {
  await build({ root, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });

  // 2. The build.
  const built = scan("build", out);

  // 4. The honest missing-route state made it in.
  const all = [...files(out)].filter((f) => /\.(js|html)$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
  for (const needle of REQUIRED) if (!all.includes(needle)) problems.push(`build: the "${needle}" state is missing`);

  // 3. The source.
  const src = join(root, "src");
  const sourceFiles = scan("src", src, {
    skip: (f) => f.endsWith("DevBanner.jsx"), // the dev-only strip; removed from builds (checked above)
    text: FORBIDDEN.filter((n) => !["MOCK_CONTRACT"].includes(n)),
  });
  for (const file of files(src)) {
    if (!/\.(jsx?|mjs)$/.test(file)) continue;
    if (/from\s+["'][^"']*scripts\//.test(readFileSync(file, "utf8"))) problems.push(`src: ${relative(root, file)} imports from scripts/`);
  }

  if (problems.length) {
    console.error("FAIL: the production build is not free of mock code:\n  " + problems.join("\n  "));
    process.exitCode = 1;
  } else {
    console.log(`PASS: built with MOCK_CONTRACT=1 set; ${built} build files and ${sourceFiles} source files have no mock code, flag, address or fake records.`);
    console.log("PASS: the build contains the 'not available yet' state for missing routes.");
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
