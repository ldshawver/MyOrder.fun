#!/usr/bin/env node
/**
 * Alavont Print Bridge — Mac / Ubuntu
 * Receives print jobs from the API server and sends them to a local thermal printer.
 *
 * Failover order:
 *   1. Direct raw socket to DIRECT_PRINTER_IP:DIRECT_PRINTER_PORT (port 9100)
 *   2. CUPS  (lp command)
 *   3. USB   (/dev/usb/lp0 or similar)
 *   → If all fail, returns 500 so the API server queues and retries automatically.
 *
 * Setup:
 *   cd deploy/print-bridge
 *   npm install
 *   cp .env.example .env && nano .env
 *   node server.js
 */

const http = require("http");
const net = require("net");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

require("dotenv").config();

const PORT               = parseInt(process.env.PORT                ?? "3001", 10);
const API_KEY            = process.env.PRINT_BRIDGE_API_KEY         ?? "";
const DIRECT_PRINTER_IP  = process.env.DIRECT_PRINTER_IP            ?? "";   // e.g. 192.168.68.66
const DIRECT_PRINTER_PORT= parseInt(process.env.DIRECT_PRINTER_PORT ?? "9100", 10);
const PRINTER_NAME       = process.env.PRINTER_NAME                 ?? "";   // CUPS printer name
const USB_DEVICE         = process.env.USB_DEVICE                   ?? "";   // e.g. /dev/usb/lp0
const DIRECT_TIMEOUT_MS  = parseInt(process.env.DIRECT_TIMEOUT_MS   ?? "3000", 10);

if (!API_KEY) {
  console.error("PRINT_BRIDGE_API_KEY is required");
  process.exit(1);
}

function log(level, msg, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }));
}

function authenticate(req) {
  return req.headers["x-api-key"] === API_KEY;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function respond(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

/**
 * METHOD 1 — Raw TCP socket to printer (port 9100)
 * Works on any thermal printer with network card. No CUPS needed.
 */
function printRawSocket(text) {
  return new Promise((resolve, reject) => {
    if (!DIRECT_PRINTER_IP) return reject(new Error("DIRECT_PRINTER_IP not configured"));

    const socket = new net.Socket();
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };

    socket.setTimeout(DIRECT_TIMEOUT_MS);
    socket.connect(DIRECT_PRINTER_PORT, DIRECT_PRINTER_IP, () => {
      socket.write(text, "binary", (err) => {
        if (err) return finish(err);
        // Small delay to let the printer buffer flush before closing
        setTimeout(() => finish(null), 200);
      });
    });

    socket.on("timeout", () => finish(new Error(`Socket timeout after ${DIRECT_TIMEOUT_MS}ms`)));
    socket.on("error",   (e) => finish(e));
  });
}

/**
 * METHOD 2 — CUPS via lp command
 * Works on Mac and Linux. Printer must be added via System Settings or lpadmin.
 */
function printViaCups(text, printerOverride) {
  const tmpFile = path.join(os.tmpdir(), `print_${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, text, "utf8");
  try {
    const name = printerOverride || PRINTER_NAME;
    const args = name ? ["-d", name, tmpFile] : [tmpFile];
    execSync(`lp ${args.join(" ")}`, { timeout: 10000 });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * METHOD 3 — Raw USB device (Linux only, /dev/usb/lp0)
 */
function printRawUsb(text) {
  if (!USB_DEVICE || !fs.existsSync(USB_DEVICE)) {
    throw new Error(`USB device not found: ${USB_DEVICE || "(not configured)"}`);
  }
  fs.appendFileSync(USB_DEVICE, text, "binary");
}

/**
 * Main print handler — tries all methods in order, stops at first success.
 */
async function handlePrint(req, res) {
  if (!authenticate(req)) {
    return respond(res, 401, { success: false, error: "Unauthorized" });
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return respond(res, 400, { success: false, error: e.message });
  }

  const { text, printerName, jobId, copies = 1 } = body;

  if (!text) {
    return respond(res, 400, { success: false, error: "Missing text payload" });
  }

  const fullText = text.repeat(Math.max(1, Math.min(copies, 5)));
  log("info", "Print job received", { jobId, printerName, chars: fullText.length });

  // ── METHOD 1: Direct raw socket (fastest) ─────────────────────────────────
  if (DIRECT_PRINTER_IP) {
    try {
      await printRawSocket(fullText);
      log("info", "Printed via direct socket", { jobId, ip: DIRECT_PRINTER_IP, port: DIRECT_PRINTER_PORT });
      return respond(res, 200, { success: true, method: "direct", ip: DIRECT_PRINTER_IP });
    } catch (e) {
      log("warn", "Direct socket failed, trying CUPS", { error: e.message, jobId });
    }
  }

  // ── METHOD 2: CUPS ─────────────────────────────────────────────────────────
  if (PRINTER_NAME || !USB_DEVICE) {
    try {
      printViaCups(fullText, printerName);
      log("info", "Printed via CUPS", { jobId, printer: printerName || PRINTER_NAME || "default" });
      return respond(res, 200, { success: true, method: "cups", printer: printerName || PRINTER_NAME || "default" });
    } catch (e) {
      log("warn", "CUPS failed, trying USB", { error: e.message, jobId });
    }
  }

  // ── METHOD 3: Raw USB ──────────────────────────────────────────────────────
  if (USB_DEVICE) {
    try {
      printRawUsb(fullText);
      log("info", "Printed via USB", { jobId, device: USB_DEVICE });
      return respond(res, 200, { success: true, method: "usb", device: USB_DEVICE });
    } catch (e) {
      log("error", "USB failed", { error: e.message, jobId });
    }
  }

  // ── ALL METHODS FAILED — API server will queue and retry ───────────────────
  log("error", "All print methods failed — job will be queued by API server", { jobId });
  return respond(res, 500, { success: false, error: "All print methods failed" });
}

function handleHealth(req, res) {
  if (!authenticate(req)) {
    return respond(res, 401, { success: false, error: "Unauthorized" });
  }

  const usbOk = USB_DEVICE ? fs.existsSync(USB_DEVICE) : null;

  let cupsOk = false;
  try { execSync("lpstat -p 2>/dev/null", { timeout: 3000 }); cupsOk = true; } catch {}

  respond(res, 200, {
    status: "ok",
    hostname: os.hostname(),
    directPrinter: DIRECT_PRINTER_IP ? `${DIRECT_PRINTER_IP}:${DIRECT_PRINTER_PORT}` : null,
    usbDevice: USB_DEVICE || null,
    usbOnline: usbOk,
    cupsAvailable: cupsOk,
    printerName: PRINTER_NAME || null,
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/print")   return handlePrint(req, res);
  if (req.method === "GET"  && req.url === "/health")  return handleHealth(req, res);
  respond(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  log("info", "Print bridge listening", {
    port: PORT,
    directPrinter: DIRECT_PRINTER_IP ? `${DIRECT_PRINTER_IP}:${DIRECT_PRINTER_PORT}` : "not configured",
    cups: PRINTER_NAME || "default",
    usb: USB_DEVICE || "none",
  });
});
