// Development only: starts the contract mock and the Vite dev server together,
// with the mock switched on (MOCK_CONTRACT=1), so one terminal is enough.
//
//   npm run dev:mock
//
// The real backend (node --env-file=.env.local server.mjs) must be running
// too: the mock forwards every route it does not own to it. Ctrl+C stops both.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
const env = { ...process.env, MOCK_CONTRACT: "1" };
const run = (args) => spawn(process.execPath, args, { cwd: web, env, stdio: "inherit" });

const mock = run([join(web, "scripts", "mock-contract.mjs")]);
const vite = run([join(web, "node_modules", "vite", "bin", "vite.js")]);

const stop = () => {
  mock.kill();
  vite.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
mock.on("exit", () => vite.kill());
vite.on("exit", () => mock.kill());
