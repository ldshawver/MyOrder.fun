import twilio from "twilio";
import { logger } from "./logger";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;

const DEFAULT_ALLOWED_SMS_LINK_DOMAINS = [
  "myorder.fun",
  "www.myorder.fun",
  "lucifercruz.com",
  "www.lucifercruz.com",
  "uber.com",
  "m.uber.com",
  "trip.uber.com",
  "stripe.com",
  "checkout.stripe.com",
  "pay.stripe.com",
];

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

function allowedSmsDomains(): string[] {
  return (process.env.SMS_ALLOWED_LINK_DOMAINS ?? DEFAULT_ALLOWED_SMS_LINK_DOMAINS.join(","))
    .split(",")
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function isAllowedSmsUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return allowedSmsDomains().some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function sanitizeSmsBody(body: string): string {
  const withoutHtml = decodeBasicEntities(body)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  return withoutHtml
    .replace(/https?:\/\/[^\s<>()]+/gi, (url) => isAllowedSmsUrl(url) ? url : "[link removed]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
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

  const safeBody = sanitizeSmsBody(body);
  if (!safeBody) {
    logger.warn({ to: normalized }, "SMS skipped — body was empty after sanitization");
    return;
  }

  try {
    await c.messages.create({ from: fromNumber!, to: normalized, body: safeBody });
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

export function smsAccountApproved(firstName?: string | null): string {
  const name = firstName ? ` ${firstName}` : "";
  return `Hi${name}! Your Lucifer Cruz account has been approved — you can now sign in and start placing orders.`;
}
