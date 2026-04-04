#!/usr/bin/env node
/**
 * Alavont Print Bridge — Ubuntu 24.04
 * Receives print jobs from the Replit API and sends them to a local USB thermal printer.
 *
 * Setup:
 *   cd /opt/print-bridge
 *   npm install
 *   cp .env.example .env && nano .env
 *   node server.js
 *
 * For systemd: see print-bridge.service
 */

const http = require("http");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

require("dotenv").config();

const PORT = parseInt(process.env.PORT ?? "3100", 10);
const API_KEY = process.env.PRINT_BRIDGE_API_KEY ?? "";
const PRINTER_NAME = process.env.PRINTER_NAME ?? ""; // CUPS printer name, empty = default
const USB_DEVICE = process.env.USB_DEVICE ?? ""; // e.g. /dev/usb/lp0

if (!API_KEY) {
  console.error("PRINT_BRIDGE_API_KEY is required");
  process.exit(1);
}

function log(level, msg, data) {
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
 * Print text via raw USB device (fastest, no CUPS needed)
 */
function printRawUsb(text) {
  if (!USB_DEVICE || !fs.existsSync(USB_DEVICE)) {
    throw new Error(`USB device not found: ${USB_DEVICE || "(not configured)"}`);
  }
  fs.appendFileSync(USB_DEVICE, text, "binary");
}

/**
 * Print text via CUPS using lp command
 */
function printViaCups(text, printerName) {
  const tmpFile = path.join(os.tmpdir(), `print_${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, text, "utf8");
  try {
    const args = ["-d", printerName || PRINTER_NAME, tmpFile].filter(Boolean);
    execSync(`lp ${args.join(" ")}`, { timeout: 10000 });
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

/**
 * Main print handler — tries USB first, falls back to CUPS
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

  // Try raw USB first
  if (USB_DEVICE) {
    try {
      printRawUsb(fullText);
      log("info", "Printed via USB", { jobId, device: USB_DEVICE });
      return respond(res, 200, { success: true, method: "usb", device: USB_DEVICE });
    } catch (e) {
      log("warn", "USB print failed, falling back to CUPS", { error: e.message });
    }
  }

  // Fall back to CUPS
  try {
    printViaCups(fullText, printerName);
    log("info", "Printed via CUPS", { jobId, printerName: printerName || PRINTER_NAME });
    return respond(res, 200, { success: true, method: "cups", printer: printerName || PRINTER_NAME });
  } catch (e) {
    log("error", "CUPS print failed", { error: e.message, jobId });
    return respond(res, 500, { success: false, error: e.message });
  }
}

function handleHealth(req, res) {
  if (!authenticate(req)) {
    return respond(res, 401, { success: false, error: "Unauthorized" });
  }

  const usbOk = USB_DEVICE ? fs.existsSync(USB_DEVICE) : null;

  let cupsOk = false;
  try {
    execSync("lpstat -p 2>/dev/null", { timeout: 3000 });
    cupsOk = true;
  } catch { cupsOk = false; }

  respond(res, 200, {
    status: "ok",
    hostname: os.hostname(),
    usbDevice: USB_DEVICE || null,
    usbOnline: usbOk,
    cupsAvailable: cupsOk,
    printerName: PRINTER_NAME || null,
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/print") {
    return handlePrint(req, res);
  }
  if (req.method === "GET" && req.url === "/health") {
    return handleHealth(req, res);
  }
  respond(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  log("info", "Print bridge listening", { port: PORT, usb: USB_DEVICE || "none", cups: PRINTER_NAME || "default" });
});
