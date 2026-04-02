import twilio from "twilio";
import { logger } from "./logger";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;

let client: twilio.Twilio | null = null;

function getClient(): twilio.Twilio | null {
  if (!accountSid || !authToken || !fromNumber) {
    logger.warn("Twilio not configured — SMS skipped (missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER)");
    return null;
  }
  if (!client) {
    client = twilio(accountSid, authToken);
  }
  return client;
}

export async function sendSms(to: string | null | undefined, body: string): Promise<void> {
  if (!to) return;

  // Normalize: ensure it starts with +
  const normalized = to.startsWith("+") ? to : `+1${to.replace(/\D/g, "")}`;
  if (normalized.replace(/\D/g, "").length < 10) {
    logger.warn({ to }, "SMS skipped — invalid phone number");
    return;
  }

  const c = getClient();
  if (!c) return;

  try {
    await c.messages.create({ from: fromNumber!, to: normalized, body });
    logger.info({ to: normalized }, "SMS sent");
  } catch (err) {
    logger.error({ err, to: normalized }, "SMS send failed");
  }
}

/* ── Message templates ──────────────────────────────── */

export function smsOrderConfirmation(orderId: number, total: number, itemCount: number): string {
  return `Alavont Therapeutics — Order #${orderId} confirmed. ${itemCount} item${itemCount !== 1 ? "s" : ""} · $${total.toFixed(2)}. We'll update you when your order is ready.`;
}

export function smsNewOrderAlert(orderId: number, customerName: string, total: number, itemCount: number): string {
  return `[Alavont] New order #${orderId} from ${customerName || "a customer"}. ${itemCount} item${itemCount !== 1 ? "s" : ""} · $${total.toFixed(2)}. Check the Sitter Queue.`;
}

export function smsStatusUpdate(orderId: number, status: string): string {
  const statusLabels: Record<string, string> = {
    pending: "received and pending",
    processing: "being processed",
    ready: "ready for pickup/delivery",
    dispatched: "dispatched",
    delivered: "delivered",
    cancelled: "cancelled",
    completed: "completed",
  };
  const label = statusLabels[status] ?? status;
  return `Alavont Therapeutics — Order #${orderId} is now ${label}.`;
}

export function smsTrackingReady(orderId: number, trackingUrl: string): string {
  return `Alavont Therapeutics — Your Order #${orderId} is on its way! Track your delivery: ${trackingUrl}`;
}
