#!/usr/bin/env node
/**
 * Alavont / MyOrder.fun Print Bridge
 *
 * Supports:
 *   1) Direct raw socket printing (port 9100)
 *   2) CUPS printing via lp
 *   3) Raw USB device printing (/dev/usb/lp0, etc.)
 *
 * Endpoints:
 *   GET  /health
 *   GET  /printers
 *   POST /print
 *
 * Auth:
 *   x-api-key header must match PRINT_BRIDGE_API_KEY
 *
 * Notes:
 *   - printerName in /print can override the configured CUPS printer
 *   - text printing is supported directly
 *   - imagePath is accepted for CUPS printing if you want to print rendered label images
 */

const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

try {
  require("dotenv").config();
} catch {
  // dotenv is convenient for local runs; systemd also supplies EnvironmentFile.
}

const PORT = parseInt(process.env.PORT ?? "3100", 10);
const BIND_HOST = process.env.BIND_HOST ?? "0.0.0.0";
const API_KEY = process.env.PRINT_BRIDGE_API_KEY ?? "";

const DIRECT_PRINTER_IP = process.env.DIRECT_PRINTER_IP ?? "";
const DIRECT_PRINTER_PORT = parseInt(process.env.DIRECT_PRINTER_PORT ?? "9100", 10);
const DIRECT_TIMEOUT_MS = parseInt(process.env.DIRECT_TIMEOUT_MS ?? "3000", 10);

const PRINTER_NAME = process.env.PRINTER_NAME ?? "";
const USB_DEVICE = process.env.USB_DEVICE ?? "";
const CUPS_RAW = String(process.env.CUPS_RAW ?? "false").toLowerCase() === "true";
const MAX_COPIES = parseInt(process.env.MAX_COPIES ?? "5", 10);
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES ?? String(2 * 1024 * 1024), 10);

if (!API_KEY) {
  console.error("PRINT_BRIDGE_API_KEY is required");
  process.exit(1);
}

function log(level, msg, data = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...data,
    })
  );
}

function respond(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function authenticate(req) {
  const headerKey = String(req.headers["x-api-key"] ?? "");
  const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const presented = headerKey || bearer;
  if (!presented || !API_KEY) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function clampCopies(copies) {
  const n = Number(copies);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_COPIES);
}

function listPrinters() {
  try {
    const out = execFileSync("lpstat", ["-p"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    return out
      .split("\n")
      .map((line) => {
        const match = line.match(/^printer\s+(.+?)\s+is\s+(idle|printing|disabled)/);
        return match ? { name: match[1], state: match[2], enabled: match[2] !== "disabled" } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * METHOD 1 — Raw socket (best for ethernet printers on port 9100)
 */
function printRawSocket(buffer) {
  return new Promise((resolve, reject) => {
    if (!DIRECT_PRINTER_IP) {
      reject(new Error("DIRECT_PRINTER_IP not configured"));
      return;
    }

    const socket = new net.Socket();
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      err ? reject(err) : resolve();
    };

    socket.setTimeout(DIRECT_TIMEOUT_MS);

    socket.connect(DIRECT_PRINTER_PORT, DIRECT_PRINTER_IP, () => {
      socket.write(buffer, (err) => {
        if (err) return finish(err);
        setTimeout(() => finish(null), 200);
      });
    });

    socket.on("timeout", () => finish(new Error(`Socket timeout after ${DIRECT_TIMEOUT_MS}ms`)));
    socket.on("error", (err) => finish(err));
  });
}

/**
 * METHOD 2 — CUPS via lp
 * Supports text temp files and image files.
 */
function printerNames(printers) {
  return printers.map((printer) => typeof printer === "string" ? printer : printer.name).filter(Boolean);
}

function printViaCups({ text, imagePath, printerName, copies, raw }) {
  const name = printerName || PRINTER_NAME;
  const safeCopies = clampCopies(copies);

  let fileToPrint = imagePath || null;
  let tempFile = null;

  if (!fileToPrint) {
    tempFile = path.join(os.tmpdir(), `print_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(tempFile, text, "utf8");
    fileToPrint = tempFile;
  }

  try {
    const args = [];

    if (name) {
      args.push("-d", name);
    }

    if (raw && !imagePath) {
      args.push("-o", "raw");
    }

    args.push("-n", String(safeCopies), fileToPrint);

    execFileSync("lp", args, {
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    if (tempFile) {
      try {
        fs.unlinkSync(tempFile);
      } catch {}
    }
  }
}

/**
 * METHOD 3 — Raw USB write
 * Text only. For direct ESC/POS-style receipt output.
 */
function printRawUsb(text, copies) {
  if (!USB_DEVICE) {
    throw new Error("USB_DEVICE not configured");
  }
  if (!fs.existsSync(USB_DEVICE)) {
    throw new Error(`USB device not found: ${USB_DEVICE}`);
  }

  const safeCopies = clampCopies(copies);
  const payload = text.repeat(safeCopies);

  fs.appendFileSync(USB_DEVICE, payload, "binary");
}

async function handleHealth(req, res) {
  if (!authenticate(req)) {
    return respond(res, 401, { success: false, error: "Unauthorized" });
  }

  const usbOnline = USB_DEVICE ? fs.existsSync(USB_DEVICE) : null;
  const printers = listPrinters();

  let cupsAvailable = false;
  try {
    execFileSync("lpstat", ["-p"], {
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    cupsAvailable = true;
  } catch {}

  return respond(res, 200, {
    success: true,
    status: "ok",
    hostname: os.hostname(),
    port: PORT,
    directPrinter: DIRECT_PRINTER_IP ? `${DIRECT_PRINTER_IP}:${DIRECT_PRINTER_PORT}` : null,
    printerName: PRINTER_NAME || null,
    usbDevice: USB_DEVICE || null,
    usbOnline,
    cupsAvailable,
    printers,
    printerNames: printerNames(printers),
    time: new Date().toISOString(),
  });
}

async function handleHealthz(_req, res) {
  const printers = listPrinters();
  return respond(res, 200, {
    success: true,
    status: "ok",
    hostname: os.hostname(),
    port: PORT,
    printerName: PRINTER_NAME || null,
    cupsAvailable: printers.length > 0,
    printerNames: printerNames(printers),
    time: new Date().toISOString(),
  });
}

async function handlePrinters(req, res) {
  if (!authenticate(req)) {
    return respond(res, 401, { success: false, error: "Unauthorized" });
  }

  const printers = listPrinters();
  return respond(res, 200, {
    success: true,
    printers,
    printerNames: printerNames(printers),
    configuredPrinter: PRINTER_NAME || null,
    usbDevice: USB_DEVICE || null,
  });
}

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

  const {
    text = "",
    imagePath = "",
    imageBase64 = "",
    payloadBase64 = "",
    format = "text",
    printerName: explicitPrinterName = "",
    printer = "",
    jobId = null,
    copies = 1,
    role = "",
    raw = undefined,
  } = body;
  const printerName = explicitPrinterName || printer || "";
  const decodedText = payloadBase64 ? Buffer.from(payloadBase64, "base64").toString("binary") : "";
  const printableText = text || decodedText;
  const rawMode = typeof raw === "boolean" ? raw : CUPS_RAW || role === "receipt" || format === "escpos";

  if (!printableText && !imagePath && !imageBase64) {
    return respond(res, 400, {
      success: false,
      error: "Missing text, payloadBase64, imagePath, or imageBase64 payload",
    });
  }

  // If an imageBase64 payload came in, decode it to a temp PNG so CUPS can print it.
  let tempImagePath = null;
  if (imageBase64) {
    try {
      const buf = Buffer.from(imageBase64, "base64");
      tempImagePath = path.join(
        os.tmpdir(),
        `print_${Date.now()}_${Math.random().toString(36).slice(2)}.png`
      );
      fs.writeFileSync(tempImagePath, buf);
    } catch (e) {
      return respond(res, 500, {
        success: false,
        error: `Failed to decode imageBase64: ${e.message}`,
      });
    }
  }

  // Only validate imagePath if explicitly provided (not the temp file we just wrote)
  if (imagePath && !fs.existsSync(imagePath)) {
    if (tempImagePath) try { fs.unlinkSync(tempImagePath); } catch {}
    return respond(res, 400, {
      success: false,
      error: `imagePath does not exist: ${imagePath}`,
    });
  }

  const resolvedImagePath = tempImagePath || imagePath || null;
  const safeCopies = clampCopies(copies);
  const methodTargetPrinter = printerName || PRINTER_NAME || null;

  log("info", "Print job received", {
    jobId,
    format,
    requestedPrinter: printerName || null,
    configuredPrinter: PRINTER_NAME || null,
    usingPrinter: methodTargetPrinter,
    hasText: Boolean(printableText),
    hasImagePath: Boolean(resolvedImagePath),
    isBase64Image: Boolean(imageBase64),
    copies: safeCopies,
    rawMode,
  });

  // 1) Direct raw socket: text only
  if (printableText && DIRECT_PRINTER_IP) {
    try {
      const payload = Buffer.from(printableText.repeat(safeCopies), "binary");
      await printRawSocket(payload);

      log("info", "Printed via direct socket", {
        jobId,
        ip: DIRECT_PRINTER_IP,
        port: DIRECT_PRINTER_PORT,
      });

      return respond(res, 200, {
        success: true,
        method: "direct",
        printer: `${DIRECT_PRINTER_IP}:${DIRECT_PRINTER_PORT}`,
      });
    } catch (e) {
      log("warn", "Direct socket failed, trying CUPS", {
        jobId,
        error: e.message,
      });
    }
  }

  // Helper: clean up the temp PNG after we're done (success or failure)
  const cleanupTemp = () => {
    if (tempImagePath) {
      try { fs.unlinkSync(tempImagePath); } catch {}
    }
  };

  // 2) CUPS: text or image (including decoded base64 PNG written to tempImagePath)
  try {
    printViaCups({
      text: printableText,
      imagePath: resolvedImagePath,
      printerName,
      copies: safeCopies,
      raw: rawMode,
    });

    cleanupTemp();

    log("info", "Printed via CUPS", {
      jobId,
      printer: methodTargetPrinter || "default",
      imagePath: resolvedImagePath || null,
      isBase64Image: Boolean(imageBase64),
    });

    return respond(res, 200, {
      success: true,
      method: "cups",
      printer: methodTargetPrinter || "default",
    });
  } catch (e) {
    log("warn", "CUPS failed", {
      jobId,
      error: e.message,
    });
  }

  // 3) Raw USB: text only
  if (printableText) {
    try {
      printRawUsb(printableText, safeCopies);

      cleanupTemp();

      log("info", "Printed via USB", {
        jobId,
        device: USB_DEVICE,
      });

      return respond(res, 200, {
        success: true,
        method: "usb",
        device: USB_DEVICE,
      });
    } catch (e) {
      log("error", "USB failed", {
        jobId,
        error: e.message,
      });
    }
  }

  cleanupTemp();

  log("error", "All print methods failed", { jobId });

  return respond(res, 500, {
    success: false,
    error: "All print methods failed",
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    return handleHealth(req, res);
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    return handleHealthz(req, res);
  }

  if (req.method === "GET" && url.pathname === "/printers") {
    return handlePrinters(req, res);
  }

  if (req.method === "POST" && url.pathname === "/print") {
    return handlePrint(req, res);
  }

  return respond(res, 404, { success: false, error: "Not found" });
});

server.on("error", (err) => {
  log("error", "Print bridge failed to start", {
    error: err.message,
    code: err.code,
  });
  process.exit(1);
});

server.listen(PORT, BIND_HOST, () => {
  log("info", "Print bridge listening", {
    port: PORT,
    bindHost: BIND_HOST,
    directPrinter: DIRECT_PRINTER_IP
      ? `${DIRECT_PRINTER_IP}:${DIRECT_PRINTER_PORT}`
      : "not configured",
    cupsPrinter: PRINTER_NAME || "default",
    usbDevice: USB_DEVICE || "none",
    cupsRaw: CUPS_RAW,
  });
});
