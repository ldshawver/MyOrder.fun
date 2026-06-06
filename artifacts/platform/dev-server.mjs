/**
 * dev-server.mjs — Replit-compatible Vite dev launcher.
 *
 * This process owns port PORT directly (http.createServer proxy) so
 * Replit's workflow runner can track it — the runner monitors ports bound
 * by the workflow PID, not by child processes.
 *
 * Vite runs on PORT+1 in the same process group (detached: false) so that
 * SIGTERM/SIGKILL sent to this process group reaches Vite too. On SIGTERM
 * we kill Vite cleanly and exit so the runner can start a fresh instance.
 *
 * Traffic is proxied to Vite once it signals readiness; before that a
 * self-refreshing "Starting…" page is served so the port always responds.
 */

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "5173", 10);
const VITE_PORT = PORT + 1;

// ── Suppress I/O errors (EIO after PTY master closes) ─────────────────────────
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

// ── Error safety ───────────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  try { process.stderr.write(`[dev-server] UNCAUGHT: ${err.stack}\n`); } catch (_) {}
});
process.on("unhandledRejection", (reason) => {
  try { process.stderr.write(`[dev-server] UNHANDLED REJECTION: ${reason}\n`); } catch (_) {}
});

// ── Vite subprocess ────────────────────────────────────────────────────────────
let viteReady = false;
let viteProcess = null;
let shuttingDown = false;

function startVite() {
  viteReady = false;

  const vite = spawn(
    process.execPath,
    [join(__dir, "node_modules", "vite", "bin", "vite.js"), "--config", "vite.config.ts"],
    {
      detached: false,          // same process group — SIGTERM reaches Vite too
      stdio: ["pipe", "pipe", "pipe"],
      cwd: __dir,
      env: { ...process.env, PORT: String(VITE_PORT), CI: "true" },
    },
  );

  viteProcess = vite;

  vite.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    try { process.stdout.write(text); } catch (_) {}
    if (text.includes("ready in") || text.includes("Local:")) {
      viteReady = true;
    }
  });

  vite.stderr.on("data", (chunk) => {
    try { process.stderr.write(chunk); } catch (_) {}
  });

  vite.on("exit", (code, signal) => {
    viteReady = false;
    viteProcess = null;
    if (!shuttingDown) {
      try {
        process.stderr.write(
          `[dev-server] Vite exited (code=${code} signal=${signal}), restarting in 1s…\n`,
        );
      } catch (_) {}
      setTimeout(startVite, 1000);
    }
  });
}

// ── HTTP proxy (owned by this process — Replit tracks this port) ───────────────
function tryProxy(req, res) {
  if (!viteReady) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(
      "<!DOCTYPE html><html><head><meta charset=utf-8><title>Starting…</title>" +
      "<meta http-equiv='refresh' content='2'></head>" +
      "<body style='background:#0B1121;color:#3B82F6;font-family:sans-serif;padding:2rem'>" +
      "<h2>OrderFlow is starting…</h2><p>Vite is compiling — page refreshes automatically.</p>" +
      "</body></html>",
    );
  }

  const pr = http.request(
    { hostname: "127.0.0.1", port: VITE_PORT, path: req.url, method: req.method, headers: req.headers },
    (pvRes) => {
      res.writeHead(pvRes.statusCode ?? 200, pvRes.headers);
      pvRes.pipe(res, { end: true });
    },
  );
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

proxy.on("error", (err) => {
  try { process.stderr.write(`[dev-server] Proxy error: ${err.message}\n`); } catch (_) {}
});

// ── Clean shutdown ─────────────────────────────────────────────────────────────
function doShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { process.stderr.write(`[dev-server] Shutting down (${signal})\n`); } catch (_) {}
  if (viteProcess) {
    try { viteProcess.kill("SIGTERM"); } catch (_) {}
  }
  proxy.close(() => process.exit(0));
  // Force exit after 3s in case Vite hangs
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", () => doShutdown("SIGTERM"));
process.on("SIGINT",  () => doShutdown("SIGINT"));
process.on("SIGHUP",  () => {});  // PTY close — ignore

// ── Bind proxy then start Vite ─────────────────────────────────────────────────
proxy.listen(PORT, "0.0.0.0", () => {
  try {
    process.stdout.write(`[dev-server] Proxy on :${PORT} → Vite on :${VITE_PORT}\n`);
  } catch (_) {}
  startVite();
});
