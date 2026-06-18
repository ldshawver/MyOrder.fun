import { z } from "zod/v4";
import { logger } from "./logger";

export const inAppAlertModeSchema = z.enum(["silent", "sound", "vibrate", "sound_vibrate"]);

export const notificationPreferencesSchema = z
  .object({
    inAppAlerts: z.boolean().default(true),
    smsTexts: z.boolean().default(true),
    emails: z.boolean().default(true),
    inAppAlertMode: inAppAlertModeSchema.default("sound"),
  })
  .strict();

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export type NotificationChannel = "in_app" | "sms" | "email";

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  inAppAlerts: true,
  smsTexts: true,
  emails: true,
  inAppAlertMode: "sound",
};

export function normalizeNotificationPreferences(raw: unknown): NotificationPreferences {
  if (!raw || typeof raw !== "object") return DEFAULT_NOTIFICATION_PREFERENCES;

  const legacy = raw as Record<string, unknown>;
  const candidate = {
    inAppAlerts: legacy.inAppAlerts ?? true,
    smsTexts: legacy.smsTexts ?? true,
    emails: legacy.emails ?? true,
    inAppAlertMode: legacy.inAppAlertMode ?? normalizeLegacyInAppMode(legacy.orderAlerts),
  };

  const parsed = notificationPreferencesSchema.safeParse(candidate);
  if (!parsed.success) return DEFAULT_NOTIFICATION_PREFERENCES;
  return parsed.data;
}

function normalizeLegacyInAppMode(mode: unknown): NotificationPreferences["inAppAlertMode"] {
  if (mode === "silent" || mode === "sound" || mode === "vibrate" || mode === "sound_vibrate") return mode;
  return "sound";
}

export function shouldSendNotificationChannel(raw: unknown, channel: NotificationChannel): boolean {
  const prefs = normalizeNotificationPreferences(raw);
  if (channel === "in_app") return prefs.inAppAlerts;
  if (channel === "sms") return prefs.smsTexts;
  return prefs.emails;
}

type OptionalNotificationSender = (() => Promise<void> | void) | undefined;

export async function sendOrderStatusSmsEmailIfAllowed(
  raw: unknown,
  senders: { sms?: OptionalNotificationSender; email?: OptionalNotificationSender } = {},
): Promise<{ sms: boolean; email: boolean }> {
  const sent = { sms: false, email: false };

  if (shouldSendNotificationChannel(raw, "sms")) {
    if (senders.sms) {
      await senders.sms();
      sent.sms = true;
    } else {
      logger.debug("SMS order status notification allowed but no sender configured");
    }
  }

  if (shouldSendNotificationChannel(raw, "email")) {
    if (senders.email) {
      await senders.email();
      sent.email = true;
    } else {
      logger.debug("Email order status notification allowed but no sender configured");
    }
  }

  return sent;
}