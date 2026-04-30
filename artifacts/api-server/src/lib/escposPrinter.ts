/**
 * escposPrinter.ts — Secure ESC/POS receipt printer via local CUPS queue.
 *
 * Uses spawn("lp", ["-d", printerName]) — no shell interpolation.
 * Accepts only pre-rendered body text; ESC/POS framing is added here.
 * Never accepts raw printer commands from clients.
 */

import { spawn } from "node:child_process";
import { logger as _logger } from "./logger";

const log = _logger.child({ module: "escposPrinter" });

const ESC_RESET = "\x1b@";       // ESC @ — initialize/reset printer
const FEED_LINES = "\n\n\n";     // feed blank lines before cut
const CUT = "\x1dV1";            // GS V 1 — full cut

export interface LpPrintResult {
  jobRef: string;
}

/**
 * printReceiptEscPos — Wrap body text in ESC/POS framing and pipe to lp.
 *
 * @param body  Plain receipt body text, built server-side from trusted DB data.
 *              Must NOT contain ESC/POS control sequences — framing is added here.
 */
export async function printReceiptEscPos(body: string): Promise<LpPrintResult> {
  const printerName = process.env.RECEIPT_PRINTER_NAME || "receipt";

  const payload = ESC_RESET + body + FEED_LINES + CUT;

  return new Promise<LpPrintResult>((resolve, reject) => {
    const lp = spawn("lp", ["-d", printerName], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    lp.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    lp.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    lp.on("error", (err: Error) => {
      log.error(
        { event: "lp_spawn_error", printerName, errMsg: err.message },
        "Failed to spawn lp"
      );
      reject(err);
    });

    lp.on("close", (code: number | null) => {
      if (code === 0) {
        const match = stdout.match(/request id is (\S+)/);
        const jobRef = match?.[1] ?? printerName;
        log.info(
          { event: "lp_success", printerName, jobRef },
          "Receipt sent to CUPS queue"
        );
        resolve({ jobRef });
      } else {
        const msg = `lp exited with code ${code ?? "?"}: ${stderr.trim()}`;
        log.warn(
          { event: "lp_failed", printerName, code, stderr: stderr.trim() },
          "Receipt print failed"
        );
        reject(new Error(msg));
      }
    });

    lp.stdin.write(Buffer.from(payload, "binary"));
    lp.stdin.end();
  });
}
