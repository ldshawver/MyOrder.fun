/**
 * queue-policy.js — optional CUPS queue allowlist for hardened bridges.
 *
 * When ALLOWED_QUEUES is unset the bridge behaves exactly as before.
 * When it is set (comma-separated CUPS queue names) the bridge fails closed:
 *   - it refuses to start if the list is empty or contains a malformed name,
 *     or if PRINTER_NAME is set to a queue outside the list;
 *   - /printers, /health, /healthz and discovery only report listed queues;
 *   - /print requires an explicit, well-formed, listed queue;
 *   - /print rejects imagePath (the MyOrder server sends imageBase64, never a
 *     bridge-local file path).
 */
"use strict";

// The MyOrder server's dispatch shape, additionally requiring a leading
// letter or digit so a queue name can never look like an lp option.
const QUEUE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function parseAllowedQueues(raw, printerName = "") {
  if (raw === undefined) return { configured: false, queues: null };
  const names = String(raw).split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.length) {
    throw new Error("ALLOWED_QUEUES is set but lists no queues");
  }
  for (const name of names) {
    if (!QUEUE_NAME.test(name)) {
      throw new Error(`ALLOWED_QUEUES contains a malformed queue name: ${JSON.stringify(name)}`);
    }
  }
  const queues = new Set(names);
  if (printerName && !queues.has(printerName)) {
    throw new Error(`PRINTER_NAME ${JSON.stringify(printerName)} is not in ALLOWED_QUEUES`);
  }
  return { configured: true, queues };
}

function filterPrinters(printers, policy) {
  if (!policy.configured) return printers;
  return printers.filter((printer) => policy.queues.has(typeof printer === "string" ? printer : printer.name));
}

/** Returns { ok: true } or { ok: false, status, error } for a /print request. */
function checkPrintTarget({ printerName, imagePath }, policy) {
  if (!policy.configured) return { ok: true };
  if (imagePath) {
    return { ok: false, status: 400, error: "imagePath is not accepted by this bridge; send imageBase64" };
  }
  if (!printerName) {
    return { ok: false, status: 400, error: "An explicit printerName is required by this bridge" };
  }
  if (typeof printerName !== "string" || !QUEUE_NAME.test(printerName)) {
    return { ok: false, status: 400, error: "printerName is malformed" };
  }
  if (!policy.queues.has(printerName)) {
    return { ok: false, status: 403, error: `Queue "${printerName}" is not allowed on this bridge` };
  }
  return { ok: true };
}

module.exports = { QUEUE_NAME, parseAllowedQueues, filterPrinters, checkPrintTarget };
