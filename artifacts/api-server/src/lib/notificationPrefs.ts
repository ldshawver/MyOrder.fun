import { logger } from "./logger";

type NotificationChannel = "sms" | "email";
type PreferenceValue = Record<string, unknown> | null | undefined;

type OrderStatusNotificationTarget = {
  id: number;
  email?: string | null;
  contactPhone?: string | null;
  notificationPreferences?: PreferenceValue;
};

type OrderStatusNotificationOrder = {
  id: number;
  tenantId?: number | null;
};

type OrderStatusNotificationCallbacks = Partial<Record<NotificationChannel, (payload: {
  user: OrderStatusNotificationTarget;
  order: OrderStatusNotificationOrder;
  status: string;
  message: string;
}) => Promise<void> | void>>;

function readNestedBoolean(raw: PreferenceValue, channel: NotificationChannel): boolean | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const prefs = raw as Record<string, unknown>;
  const direct = prefs[channel];
  if (typeof direct === "boolean") return direct;

  for (const key of ["orderStatus", "orderStatuses", "orderUpdates", "orderNotifications", "orderStatusNotifications"]) {
    const group = prefs[key];
    if (group && typeof group === "object" && !Array.isArray(group)) {
      const value = (group as Record<string, unknown>)[channel];
      if (typeof value === "boolean") return value;
    }
  }

  return undefined;
}

export function shouldSendNotificationChannel(raw: PreferenceValue, channel: NotificationChannel): boolean {
  const explicit = readNestedBoolean(raw, channel);
  if (explicit !== undefined) return explicit;
  return true;
}

export async function sendOrderStatusSmsEmailIfAllowed(
  user: OrderStatusNotificationTarget,
  order: OrderStatusNotificationOrder,
  status: string,
  callbacks: OrderStatusNotificationCallbacks = {},
): Promise<{ sms: boolean; email: boolean }> {
  const message = `Your order #${order.id} status changed to ${status}.`;
  const sent = { sms: false, email: false };

  if (user.contactPhone && shouldSendNotificationChannel(user.notificationPreferences, "sms")) {
    const sendSms = callbacks.sms;
    if (sendSms) {
      await sendSms({ user, order, status, message });
      sent.sms = true;
    } else {
      logger.debug({ userId: user.id, orderId: order.id, status }, "SMS order status notification allowed but no sender configured");
    }
  }

  if (user.email && shouldSendNotificationChannel(user.notificationPreferences, "email")) {
    const sendEmail = callbacks.email;
    if (sendEmail) {
      await sendEmail({ user, order, status, message });
      sent.email = true;
    } else {
      logger.debug({ userId: user.id, orderId: order.id, status }, "Email order status notification allowed but no sender configured");
    }
  }

  return sent;
}
