/**
 * Runtime receipt fallback. The routed printer is still tried first. When it
 * cannot print, the slip is queued on the general Brightek_POS80. A banner is
 * added only when that printer is not the one the job was routed to.
 *
 * ESC/POS initialise (`ESC @`) clears anything already in the buffer, so the
 * banner is inserted after the single leading initialise and that command is
 * not repeated.
 */

const ESC = "\x1b";
const INIT = `${ESC}@`;
const STORED_NUL = "\u2400";

export const BRIGHTEK_POS80_QUEUE = "Brightek_POS80";

function decodeStored(text: string): string {
  return text.replaceAll(STORED_NUL, "\x00");
}

function encodeStored(text: string): string {
  return text.replaceAll("\x00", STORED_NUL);
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function isBrightekPos80(printer: { bridgePrinterName?: string | null; name?: string | null }): boolean {
  const queue = (printer.bridgePrinterName ?? "").trim();
  const name = (printer.name ?? "").trim();
  return queue === BRIGHTEK_POS80_QUEUE || name === BRIGHTEK_POS80_QUEUE || name === "Brightek POS80";
}

/** Queue name the job was routed to, safe to print on a thermal roll. */
export function sourcePrinterLabel(printer: { bridgePrinterName?: string | null; name?: string | null }): string {
  const raw = (printer.bridgePrinterName ?? "").trim() || (printer.name ?? "").trim();
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, 48) || "unknown";
}

export function rerouteBanner(sourcePrinter: string): string {
  return `******** Rerouted from ${sourcePrinter}  ********`;
}

export function withRerouteBanner(storedText: string, sourcePrinter: string): string {
  const note = rerouteBanner(sourcePrinter);
  const decoded = decodeStored(storedText ?? "");
  if (decoded.startsWith(note)) return storedText ?? "";
  if (decoded.startsWith(INIT)) {
    const body = decoded.slice(INIT.length);
    const prefixed = `${INIT}${ESC}a\x01${ESC}E\x01${note}\n${ESC}E\x00${ESC}a\x00${body}`;
    return encodeStored(prefixed);
  }
  return encodeStored(`${note}\n${decoded}`);
}

export function shouldRerouteToBrightek(
  job: {
    renderFormat?: string | null;
    jobType?: string | null;
    idempotencyKey?: string | null;
    payloadJson?: unknown;
  },
  printer: { bridgePrinterName?: string | null; name?: string | null },
): boolean {
  if (job.renderFormat && job.renderFormat !== "text") return false;
  if (job.jobType === "label" || job.jobType === "thank_you_sticker") return false;
  if ((job.idempotencyKey ?? "").startsWith("reroute:")) return false;
  if (isBrightekPos80(printer)) return false;
  const payload = payloadRecord(job.payloadJson);
  if (payload.rerouteOfJobId != null || typeof payload.reroutedFrom === "string") return false;
  return true;
}
