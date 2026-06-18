import { logger } from "./logger";

export function redactPhone(value: string | null | undefined): string {
  if (!value) return "missing";
  const digits = value.replace(/\D/g, "");
  if (digits.length <= 4) return "****";
  return `***${digits.slice(-4)}`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildForwardTwiML(opts: { callerId?: string; forwardTo?: string }): string {
  const callerId = opts.callerId?.trim() || process.env.TWILIO_CALLER_ID?.trim();
  const forwardTo = opts.forwardTo?.trim() || process.env.CALL_FORWARD_TO?.trim();

  if (!callerId || !forwardTo) {
    logger.warn(
      { hasCallerId: Boolean(callerId), hasForwardTo: Boolean(forwardTo) },
      "Twilio voice forwarding config missing; returning safe Say TwiML",
    );
    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Say>We are unable to connect your call right now. Please try again shortly.</Say></Response>";
  }

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${escapeXml(callerId)}">${escapeXml(forwardTo)}</Dial></Response>`;
}

export function logCallResult(input: { sid?: string | null; status?: string | null; from?: string | null; to?: string | null; direction: "inbound" | "forward" | "status" | "outbound" }): void {
  logger.info(
    {
      sid: input.sid ?? "unknown",
      status: input.status ?? "unknown",
      from: redactPhone(input.from),
      to: redactPhone(input.to),
      direction: input.direction,
    },
    "Twilio call event",
  );
}

export function getOutboundCallerId(): string | undefined {
  return process.env.TWILIO_CALLER_ID?.trim() || undefined;
}
