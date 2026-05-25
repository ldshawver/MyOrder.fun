/**
 * dev-server.mjs — Replit-compatible Vite dev launcher.
 *
 * Owns port PORT directly (http.createServer) so Replit's workflow health
 * probe can always reach it — even before Vite finishes compiling.
 *
 * Vite runs on PORT+1.  All traffic is proxied to Vite once ready.
 * If Vite exits unexpectedly it is restarted automatically.
 */

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const VITE_PORT = PORT + 1;

let viteReady = false;
let viteProcess = null;

function startVite() {
  viteReady = false;

  const vite = spawn(
    process.execPath,
    [join(__dir, "node_modules", "vite", "bin", "vite.js"), "--config", "vite.config.ts"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: __dir,
      env: { ...process.env, PORT: String(VITE_PORT) },
    },
  );

  viteProcess = vite;

  vite.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (text.includes("ready in") || text.includes("Local:")) {
      viteReady = true;
    }
  });

  vite.stderr.on("data", (chunk) => process.stderr.write(chunk));

  vite.on("exit", (code, signal) => {
    viteReady = false;
    viteProcess = null;
    // Don't exit the proxy — restart Vite after a short delay.
    if (!shuttingDown) {
      process.stderr.write(`[dev-server] Vite exited (code=${code} signal=${signal}), restarting in 1s…\n`);
      setTimeout(startVite, 1000);
    }
  });
}

// ── HTTP proxy ────────────────────────────────────────────────────────────────
function tryProxy(req, res) {
  if (!viteReady) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(
      "<!DOCTYPE html><html><head><meta charset=utf-8><title>Starting…</title>" +
      "<meta http-equiv='refresh' content='2'></head>" +
      "<body style='background:#0B1121;color:#3B82F6;font-family:sans-serif;padding:2rem'>" +
      "<h2>OrderFlow is starting…</h2><p>Vite is compiling — this page refreshes automatically.</p>" +
      "</body></html>",
    );
  }

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
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Vite not ready yet — please wait.");
    }
  });

  req.pipe(pr, { end: true });
}

const proxy = http.createServer(tryProxy);

// WebSocket passthrough (Vite HMR)
proxy.on("upgrade", (req, clientSocket, head) => {
  const upstream = net.createConnection({ host: "127.0.0.1", port: VITE_PORT });
  upstream.on("connect", () => {
    const hdrs =
      `${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
      "\r\n\r\n";
    upstream.write(hdrs);
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
});

// Keep event loop alive independently of Vite or the HTTP server
const keepAlive = setInterval(() => {}, 1 << 30);

// Catch uncaught errors so the process never exits silently
process.on("uncaughtException", (err) => {
  process.stderr.write(`[dev-server] UNCAUGHT: ${err.stack}\n`);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[dev-server] UNHANDLED REJECTION: ${reason}\n`);
});

proxy.on("error", (err) => {
  process.stderr.write(`[dev-server] Proxy server error: ${err.message}\n`);
});

proxy.listen(PORT, "::", () => {
  process.stdout.write(`[dev-server] Proxy on :${PORT} (::) → Vite on :${VITE_PORT}\n`);
  startVite();
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false;
const startTime = Date.now();

const doShutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(keepAlive);
  if (viteProcess) viteProcess.kill("SIGTERM");
  proxy.close(() => process.exit(0));
};

process.on("SIGTERM", () => {
  const uptime = Date.now() - startTime;
  process.stderr.write(`[dev-server] SIGTERM received after ${uptime}ms uptime\n`);
  // Delay shutdown so the workflow health-checker can detect port 5173 is open.
  // The runner sometimes sends SIGTERM immediately during its restart sequence.
  if (uptime < 30_000) {
    process.stderr.write("[dev-server] Deferring shutdown 30 s (startup grace period)\n");
    setTimeout(doShutdown, 30_000);
  } else {
    doShutdown();
  }
});

process.on("SIGINT", doShutdown);

process.on("beforeExit", (code) => {
  process.stderr.write(`[dev-server] beforeExit code=${code} — event loop may be draining\n`);
});
