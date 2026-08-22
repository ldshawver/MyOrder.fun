#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseCupsSubmission, extractCupsJobRecord, classifyCupsStatus } = require("./staging-pull-core");

const VERSION = "staging-marklife-pull-v2";
const ENVIRONMENT = "staging";
const QUEUE = "MARKLIFE_X2";
const DEVICE_URI = "usb://MARKLIFE/X2?location=8343000";
const MEDIA = "Custom.1.9375x1.9375in";
const RESOLUTION = "203dpi";
const API = process.env.STAGING_MYORDER_API_URL ?? "";
const BRIDGE_ID = process.env.STAGING_STICKER_BRIDGE_ID ?? "";
const TOKEN = process.env.STAGING_STICKER_BRIDGE_SECRET ?? "";
const STATE_PATH = process.env.STAGING_STICKER_STATE_PATH ?? path.join(os.homedir(), ".myorder-staging-sticker-state.json");
const POLL_MS = Math.max(2000, Number(process.env.STAGING_STICKER_POLL_MS ?? 5000));
const STATUS_TIMEOUT_MS = Math.max(60000, Number(process.env.STAGING_STICKER_STATUS_TIMEOUT_MS ?? 300000));

if (!API.startsWith("https://") || API.includes("127.0.0.1") || API.includes("localhost") || !BRIDGE_ID || TOKEN.length < 32) throw new Error("Staging HTTPS API identity and managed bridge credential are required");
if (/production|prod\./i.test(new URL(API).hostname)) throw new Error("Production API host is prohibited for the staging bridge");

const headers = { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-myorder-bridge-id": BRIDGE_ID, "x-myorder-environment": ENVIRONMENT };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (event, data = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, bridgeId: BRIDGE_ID, ...data }));
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return {}; } };
const writeState = value => { const temp = `${STATE_PATH}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, STATE_PATH); };
const api = async (route, body) => {
  const response = await fetch(new URL(route, API), { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`API_${response.status}_${String(result.error ?? "request_failed").slice(0, 80)}`);
  return result;
};

function inspectPrinter() {
  const read = args => { try { return run("lpstat", args); } catch { return ""; } };
  const queueState = read(["-p", QUEUE, "-l"]);
  const acceptingState = read(["-a", QUEUE]);
  const deviceState = read(["-v", QUEUE]);
  const deviceUri = deviceState.match(/device for MARKLIFE_X2:\s*(\S+)/i)?.[1] ?? "";
  const identityVerified = deviceUri === DEVICE_URI;
  const idle = /printer MARKLIFE_X2 is idle/i.test(queueState) && !/disabled|stopped|error/i.test(queueState);
  const accepting = /MARKLIFE_X2 accepting requests/i.test(acceptingState);
  if (identityVerified && idle && accepting) return { availability: "available", reason: "ready", deviceUri, identityVerified };
  if (identityVerified && (queueState || acceptingState)) return { availability: "degraded", reason: idle ? "not_accepting" : "queue_stopped_or_unhealthy", deviceUri, identityVerified };
  return { availability: "unavailable", reason: deviceUri ? "device_identity_mismatch" : "queue_or_device_not_discoverable", deviceUri, identityVerified };
}

function preflight(status = inspectPrinter()) {
  if (!status.identityVerified) throw Object.assign(new Error("MARKLIFE_X2 device identity mismatch or unavailable"), { state: "rejected" });
  if (status.availability !== "available") throw Object.assign(new Error("MARKLIFE_X2 is not operational"), { state: "printer_unavailable" });
}

function validateJob(job) {
  if (job.jobType !== "thank_you_sticker" || job.queue !== QUEUE || job.copies !== 1 || job.media !== MEDIA || job.resolution !== RESOLUTION || job.rotate !== 0 || job.horizontal !== 0 || job.vertical !== 0 || job.mirror !== 0 || job.negative !== 0 || job.darkness !== 10 || job.templateVersion !== 1 || job.artworkChecksum !== "0fad41aa3b9f338e00f02d4bcd1e80acc34a6d4bb1cb8a846ce52b4d740a83f4" || !job.imageBase64) throw Object.assign(new Error("Claimed job violates MARKLIFE_X2 policy"), { state: "rejected" });
}

function submit(job) {
  const state = readState();
  if (state[job.idempotencyKey]?.submissionAttempted) throw Object.assign(new Error("Local duplicate submission prevented"), { state: "rejected" });
  state[job.idempotencyKey] = { jobId: job.jobId, submissionAttempted: true, attemptedAt: new Date().toISOString(), cupsRequestId: null };
  writeState(state);
  const imagePath = path.join(os.tmpdir(), `myorder-sticker-${job.jobId}.png`);
  fs.writeFileSync(imagePath, Buffer.from(job.imageBase64, "base64"), { mode: 0o600 });
  try {
    const output = run("lp", ["-d", QUEUE, "-n", "1", "-o", `PageSize=${MEDIA}`, "-o", `Resolution=${RESOLUTION}`, "-o", "Horizontal=0", "-o", "Vertical=0", "-o", "Rotate=0", "-o", "ImgMirror=0", "-o", "ImgNegative=0", "-o", "Darkness=10", imagePath]);
    const parsed = parseCupsSubmission(output);
    if (!parsed) throw Object.assign(new Error("CUPS submission response did not contain a request ID"), { state: "submission_unknown" });
    state[job.idempotencyKey].cupsRequestId = parsed.cupsRequestId; state[job.idempotencyKey].cupsJobId = parsed.cupsJobId; writeState(state);
    return parsed;
  } catch (error) {
    if (error.state) throw error;
    const combined = `${error.stdout ?? ""} ${error.stderr ?? ""}`; const parsed = parseCupsSubmission(combined);
    if (parsed) { state[job.idempotencyKey].cupsRequestId = parsed.cupsRequestId; state[job.idempotencyKey].cupsJobId = parsed.cupsJobId; writeState(state); return parsed; }
    throw Object.assign(new Error("CUPS submission outcome is ambiguous"), { state: "submission_unknown" });
  } finally { try { fs.unlinkSync(imagePath); } catch {} }
}

async function waitForCups(requestId) {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let activeHistory = ""; try { activeHistory = run("lpstat", ["-W", "not-completed", "-l", "-o", QUEUE]); } catch {}
    const active = extractCupsJobRecord(activeHistory, requestId);
    const activeState = classifyCupsStatus(active, "");
    if (activeState === "canceled" || activeState === "cups_failed") return activeState;
    if (activeState === "pending") { await sleep(2000); continue; }
    let completedHistory = ""; try { completedHistory = run("lpstat", ["-W", "completed", "-l", "-o", QUEUE]); } catch {}
    const completed = extractCupsJobRecord(completedHistory, requestId);
    const finalState = classifyCupsStatus("", completed);
    if (finalState !== "unknown") return finalState;
    await sleep(2000);
  }
  return "timed_out";
}

async function cycle() {
  const printer = inspectPrinter();
  await api("/api/print-bridge/v1/heartbeat", { environment: ENVIRONMENT, queue: QUEUE, deviceUri: printer.deviceUri, deviceIdentityVerified: printer.identityVerified, printerAvailability: printer.availability, printerReason: printer.reason, bridgeVersion: VERSION });
  if (printer.availability !== "available" || !printer.identityVerified) return;
  const job = await api("/api/print-bridge/v1/claim", { bridgeVersion: VERSION });
  if (!job) return;
  try {
    validateJob(job); preflight();
    await api(`/api/print-bridge/v1/jobs/${job.jobId}/submitting`, {});
    const cups = submit(job);
    await api(`/api/print-bridge/v1/jobs/${job.jobId}/submitted`, cups);
    const state = await waitForCups(cups.cupsRequestId);
    if (state === "completed") await api(`/api/print-bridge/v1/jobs/${job.jobId}/complete`, { cupsRequestId: cups.cupsRequestId });
    else await api(`/api/print-bridge/v1/jobs/${job.jobId}/fail`, { state, reason: `CUPS request ${state}` });
  } catch (error) {
    const state = error.state ?? "submission_unknown";
    await api(`/api/print-bridge/v1/jobs/${job.jobId}/fail`, { state, reason: String(error.message ?? error) }).catch(() => {});
  }
}

(async () => { log("bridge_started", { version: VERSION, queue: QUEUE }); for (;;) { try { await cycle(); } catch (error) { log("poll_failed", { reason: String(error.message ?? error).slice(0, 160) }); } await sleep(POLL_MS); } })();
