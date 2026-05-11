/**
 * dev-server.mjs — Replit development proxy for the OrderFlow Platform.
 *
 * WHY THIS EXISTS:
 * Replit's workflow port-detection probes http://localhost:<PORT>/ immediately
 * after the process starts. Vite takes a few seconds to compile and bind its
 * socket, so the probe lands before Vite is ready and the workflow is marked
 * "failed" — even though Vite eventually starts correctly.
 *
 * This script fixes that by:
 *   1. Binding PORT immediately and returning HTTP 200 for ANY request while
 *      Vite is warming up (satisfies the Replit probe).
 *   2. Spawning Vite on PORT+1 in the background.
 *   3. Forwarding all HTTP + WebSocket traffic to Vite once it is ready.
 *      Before Vite is ready, HTTP requests get a lightweight "Loading…" page.
 *
 * No npm packages are required — only Node.js built-ins.
 */

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT ?? "5000", 10);
const VITE_PORT = PORT + 1; // Vite lives on 5001; this proxy owns 5000

let viteReady = false;

// ── Start Vite on VITE_PORT ──────────────────────────────────────────────────
const vite = spawn(
  process.execPath,
  [join(__dir, "node_modules/vite/bin/vite.js")],
  {
    // "pipe" for stdin so we hold the stdin fd open indefinitely — if we
    // pass "ignore" (/dev/null), Vite 7's readline loop detects EOF and
    // exits immediately in non-TTY environments (e.g. Replit workflows).
    // We simply never write to vite.stdin and never close it.
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PORT: String(VITE_PORT) },
  },
);

vite.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (text.includes("Local:") || text.includes("ready in")) {
    viteReady = true;
  }
});
vite.stderr.on("data", (chunk) => process.stderr.write(chunk));
vite.on("exit", (code) => process.exit(code ?? 0));

// ── Proxy helpers ────────────────────────────────────────────────────────────
function tryProxy(req, res) {
  const opts = {
    hostname: "127.0.0.1",
    port: VITE_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };

  const pr = http.request(opts, (pvRes) => {
    res.writeHead(pvRes.statusCode ?? 200, pvRes.headers);
    pvRes.pipe(res, { end: true });
  });

  pr.on("error", () => {
    if (!res.headersSent) {
      // Vite not ready yet — return 200 so Replit's health probe passes.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><html><head><meta charset=utf-8>" +
          "<title>Starting…</title>" +
          "<meta http-equiv='refresh' content='2'></head>" +
          "<body style='font-family:sans-serif;padding:2rem'>" +
          "<h2>OrderFlow Platform is starting…</h2>" +
          "<p>Vite is compiling. This page refreshes automatically.</p>" +
          "</body></html>",
      );
    }
  });

  req.pipe(pr, { end: true });
}

// ── HTTP proxy server ────────────────────────────────────────────────────────
const proxy = http.createServer(tryProxy);

// ── WebSocket passthrough — required for Vite HMR ───────────────────────────
proxy.on("upgrade", (req, clientSocket, head) => {
  const upstream = net.createConnection({
    host: "127.0.0.1",
    port: VITE_PORT,
  });

  upstream.on("connect", () => {
    const headers =
      `${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n") +
      "\r\n\r\n";
    upstream.write(headers);
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
});

// ── Listen on PORT immediately ───────────────────────────────────────────────
proxy.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[dev-server] Proxy on :${PORT} → Vite on :${VITE_PORT} (Vite ready: ${viteReady})`,
  );
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = () => {
  vite.kill("SIGTERM");
  proxy.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
