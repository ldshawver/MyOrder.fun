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

export type SmsDispatchResult = {
  success: boolean;
  skipped?: boolean;
  sid?: string;
  from?: string;
  to?: string;
  body?: string;
  error?: string;
};

export function getBusinessSmsNumber(): string | null {
  return fromNumber ?? null;
}

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

export function normalizePhoneNumber(to: string | null | undefined): string | null {
  const raw = (to ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("+")) return `+${raw.replace(/\D/g, "")}`;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length > 11) return `+${digits}`;
  return null;
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

export async function sendSmsDetailed(to: string | null | undefined, body: string, statusCallback?: string): Promise<SmsDispatchResult> {
  const normalized = normalizePhoneNumber(to);
  if (!normalized) {
    logger.warn({ to }, "SMS skipped — invalid phone number");
    return { success: false, skipped: true, error: "Invalid phone number" };
  }

  const c = getClient();
  if (!c) return { success: false, skipped: true, to: normalized, error: "Twilio is not configured" };

  const safeBody = sanitizeSmsBody(body);
  if (!safeBody) {
    logger.warn({ to: normalized }, "SMS skipped — body was empty after sanitization");
    return { success: false, skipped: true, to: normalized, error: "Message body is empty" };
  }

  try {
    const message = await c.messages.create({
      from: fromNumber!,
      to: normalized,
      body: safeBody,
      ...(statusCallback ? { statusCallback } : {}),
    });
    logger.info({ to: normalized, messageSid: message.sid }, "SMS sent");
    return { success: true, sid: message.sid, from: fromNumber!, to: normalized, body: safeBody };
  } catch (err) {
    const error = err instanceof Error ? err.message : "SMS send failed";
    logger.error({ err, to: normalized }, "SMS send failed");
    return { success: false, to: normalized, body: safeBody, error };
  }
}

export async function sendSms(to: string | null | undefined, body: string): Promise<void> {
  await sendSmsDetailed(to, body);
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
