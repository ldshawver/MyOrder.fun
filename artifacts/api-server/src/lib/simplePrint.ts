/**
 * simplePrint.ts — Simplified printer dispatch for Task #9.
 *
 * Two and only two modes:
 *   1. local_cups — spawn `lp -d <queue>` and pipe ESC/POS bytes via stdin.
 *      No shell interpolation, no template injection.
 *   2. bridge     — POST to the Tailscale Print Bridge at
 *      http://100.103.51.63:3100 (overridable via PRINT_BRIDGE_URL).
 *
 * All callers receive structured `{ ok, message, ... }` results — no thrown
 * exceptions leak across the route boundary, so route handlers can always
 * respond with JSON.
 */

import { spawn } from "node:child_process";
import { logger as _logger } from "./logger";

const log = _logger.child({ module: "simplePrint" });

export const DEFAULT_BRIDGE_URL = "http://100.103.51.63:3100";
// Health preflight is intentionally short — we'd rather report "bridge
// unreachable, use Local VPS CUPS" quickly than make the admin wait.
export const BRIDGE_HEALTH_TIMEOUT_MS = 2000;
// Print POSTs get a slightly longer budget for the actual job.
export const BRIDGE_REQUEST_TIMEOUT_MS = 4000;

export type PrintRole = "receipt" | "label";
export type PrintMethod = "local_cups" | "bridge";

export interface PrintAttemptResult {
  ok: boolean;
  message: string;
  mode: PrintMethod;
  printerName: string;
  /** Human-readable command we attempted (local CUPS only). */
  command?: string;
  jobRef?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  latencyMs?: number;
  bridgeStatus?: number;
}

const ESC_RESET = "\x1b@";
const FEED = "\n\n\n";
const CUT = "\x1dV1";

/** Build a small ESC/POS test payload for receipt printers. */
export function buildReceiptTestPayload(): Buffer {
  const body =
    "=== TEST RECEIPT ===\n" +
    `Printed ${new Date().toLocaleString()}\n\n` +
    "If you can read this, the\n" +
    "receipt printer is working.\n";
  return Buffer.from(ESC_RESET + body + FEED + CUT, "binary");
}

/** Build a tiny test payload for label printers. */
export function buildLabelTestPayload(): Buffer {
  const body =
    "=== TEST LABEL ===\n" +
    `${new Date().toISOString()}\n` +
    "Label printer OK\n";
  return Buffer.from(ESC_RESET + body + FEED + CUT, "binary");
}

/** Resolve the bridge base URL (env override, then constant). */
export function getBridgeUrl(): string {
  return process.env.PRINT_BRIDGE_URL ?? DEFAULT_BRIDGE_URL;
}

/** Validate a printer queue name — only safe characters. */
export function isValidQueueName(name: string): boolean {
  return typeof name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(name);
}

/**
 * Print via local CUPS using `lp -d <queue>` with the payload streamed on
 * stdin. Never interpolates the queue name into a shell command.
 */
export function printViaCups(
  printerName: string,
  payload: Buffer,
): Promise<PrintAttemptResult> {
  return new Promise((resolve) => {
    const command = `lp -d ${printerName}`;
    if (!isValidQueueName(printerName)) {
      resolve({
        ok: false,
        mode: "local_cups",
        printerName,
        command,
        message: `Invalid CUPS queue name "${printerName}". Allowed: A–Z, 0–9, _ . -`,
      });
      return;
    }

    let lp;
    try {
      lp = spawn("lp", ["-d", printerName], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({
        ok: false,
        mode: "local_cups",
        printerName,
        command,
        message: `Could not start lp: ${(err as Error).message}. Is CUPS installed on this server?`,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (r: PrintAttemptResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    lp.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    lp.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });

    lp.on("error", (err: Error) => {
      log.warn({ event: "lp_spawn_error", printerName, errMsg: err.message }, "lp spawn error");
      finish({
        ok: false,
        mode: "local_cups",
        printerName,
        command,
        message: `Could not run lp: ${err.message}. Is CUPS installed and is the queue "${printerName}" configured?`,
      });
    });

    lp.on("close", (code: number | null) => {
      if (code === 0) {
        const match = stdout.match(/request id is (\S+)/);
        const jobRef = match?.[1] ?? printerName;
        finish({
          ok: true,
          mode: "local_cups",
          printerName,
          command,
          jobRef,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code,
          message: `Sent to CUPS queue "${printerName}" (job ${jobRef}).`,
        });
      } else {
        const trimmed = stderr.trim() || stdout.trim() || "no output";
        finish({
          ok: false,
          mode: "local_cups",
          printerName,
          command,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code,
          message:
            `lp exited with code ${code ?? "?"} for queue "${printerName}". ` +
            `Check that the queue exists (lpstat -p) and is enabled. Details: ${trimmed}`,
        });
      }
    });

    lp.stdin.on("error", () => { /* surfaced via close handler */ });
    lp.stdin.write(payload);
    lp.stdin.end();
  });
}

/**
 * GET <bridge>/healthz with an AbortController-based timeout. Returns a
 * structured result instead of throwing, so callers can render a friendly
 * message.
 */
export async function probeBridge(
  bridgeUrl: string = getBridgeUrl(),
  timeoutMs: number = BRIDGE_HEALTH_TIMEOUT_MS,
): Promise<{ ok: boolean; latencyMs?: number; status?: number; message: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${bridgeUrl}/healthz`, { signal: ctrl.signal });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        latencyMs,
        message:
          `Bridge at ${bridgeUrl} responded ${res.status}. ` +
          `Use Local VPS CUPS or check that the bridge service is running.`,
      };
    }
    return { ok: true, status: res.status, latencyMs, message: `Bridge healthy (${latencyMs}ms).` };
  } catch (err) {
    const aborted = (err as Error).name === "AbortError";
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: aborted
        ? `Bridge unreachable at ${bridgeUrl} (timeout after ${timeoutMs}ms). ` +
          `Use Local VPS CUPS or check Tailscale / the bridge service.`
        : `Bridge unreachable at ${bridgeUrl}: ${(err as Error).message}. ` +
          `Use Local VPS CUPS or check Tailscale / the bridge service.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Print via the Tailscale bridge. First probes /healthz so we can return a
 * friendly message instead of timing out twice.
 */
export async function printViaBridge(
  role: PrintRole,
  printerName: string,
  payload: Buffer,
  bridgeUrl: string = getBridgeUrl(),
  timeoutMs: number = BRIDGE_REQUEST_TIMEOUT_MS,
  healthTimeoutMs: number = BRIDGE_HEALTH_TIMEOUT_MS,
): Promise<PrintAttemptResult> {
  const health = await probeBridge(bridgeUrl, healthTimeoutMs);
  if (!health.ok) {
    return { ok: false, mode: "bridge", printerName, message: health.message };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  const apiKey = process.env.PRINT_BRIDGE_API_KEY ?? "";

  try {
    const res = await fetch(`${bridgeUrl}/print`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({
        role,
        printer: printerName,
        payloadBase64: payload.toString("base64"),
      }),
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        mode: "bridge",
        printerName,
        bridgeStatus: res.status,
        latencyMs,
        message:
          `Bridge rejected the job (${res.status}) for queue "${printerName}". ` +
          `Details: ${text.slice(0, 200) || "no body"}.`,
      };
    }
    return {
      ok: true,
      mode: "bridge",
      printerName,
      bridgeStatus: res.status,
      latencyMs,
      message: `Sent to bridge queue "${printerName}" in ${latencyMs}ms.`,
    };
  } catch (err) {
    const aborted = (err as Error).name === "AbortError";
    return {
      ok: false,
      mode: "bridge",
      printerName,
      latencyMs: Date.now() - started,
      message: aborted
        ? `Bridge timed out sending to "${printerName}" after ${timeoutMs}ms. ` +
          `Try Local VPS CUPS or check Tailscale / the bridge service.`
        : `Bridge request failed for "${printerName}": ${(err as Error).message}.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe local CUPS by running `lpstat -p` and parsing queue names. Returns a
 * structured result; never throws.
 */
export function probeCupsQueues(): Promise<{
  ok: boolean;
  queues: string[];
  message: string;
}> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("lpstat", ["-p"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, queues: [], message: `Could not run lpstat: ${(err as Error).message}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: { ok: boolean; queues: string[]; message: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("error", (err) => {
      finish({
        ok: false,
        queues: [],
        message: `Could not run lpstat: ${err.message}. Is CUPS installed on this server?`,
      });
    });
    proc.on("close", (code) => {
      const queues = Array.from(stdout.matchAll(/^printer\s+(\S+)/gm)).map((m) => m[1]);
      if (code === 0 || queues.length > 0) {
        finish({
          ok: true,
          queues,
          message: queues.length
            ? `Found ${queues.length} CUPS queue(s).`
            : "lpstat returned no printer queues. Add one with lpadmin.",
        });
      } else {
        finish({
          ok: false,
          queues,
          message: `lpstat exited ${code}: ${stderr.trim() || "no output"}`,
        });
      }
    });
  });
}
