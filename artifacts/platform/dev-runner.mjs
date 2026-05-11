/**
 * dev-runner.mjs — Minimal Replit-compatible Vite launcher.
 *
 * WHY THIS EXISTS:
 * In Replit's non-TTY workflow environment, shell pipelines and child processes
 * started via `sh -c` can exit early when stdin closes or when the shell
 * receives SIGHUP. This causes `openPorts: null` in the workflow health check
 * even though Vite briefly bound the port.
 *
 * This Node.js wrapper:
 *   1. Keeps its own event loop alive with setInterval (immune to stdin/SIGHUP).
 *   2. Spawns Vite with stdin="pipe" (never hits EOF) and stdout/stderr inherited
 *      (so output flows directly to the workflow log).
 *   3. Exits only when Vite exits, forwarding the exit code.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

const vite = spawn(
  process.execPath,
  [
    join(__dir, "node_modules", "vite", "bin", "vite.js"),
    "--config",
    "vite.config.ts",
  ],
  {
    // stdin = pipe (open, we never write/close it — prevents Vite readline EOF exit)
    // stdout/stderr = inherit (output goes directly to workflow console)
    stdio: ["pipe", "inherit", "inherit"],
  },
);

// Keep this Node process alive so Replit can see Vite's open port.
const keepAlive = setInterval(() => {}, 1 << 30);

vite.on("exit", (code, signal) => {
  clearInterval(keepAlive);
  process.exit(signal ? 1 : (code ?? 0));
});

const shutdown = () => {
  vite.kill("SIGTERM");
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
