import { useEffect, useCallback, useRef } from "react";

export type NotificationRole = "global_admin" | "admin" | "supervisor" | "csr" | "user";

export function normalizeNotificationRole(role?: string | null): NotificationRole {
  const normalized = role?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "global_admin") return "global_admin";
  if (normalized === "admin" || normalized === "tenant_admin" || normalized === "manager") return "admin";
  if (normalized === "supervisor") return "supervisor";
  if (
    normalized === "customer_service_rep" ||
    normalized === "customer_service_representative" ||
    normalized === "csr" ||
    normalized === "qsr" ||
    normalized === "customer_service" ||
    normalized === "customer_service_specialist" ||
    normalized === "customer_success" ||
    normalized === "service_rep" ||
    normalized === "business_sitter" ||
    normalized === "sales_rep" ||
    normalized === "lab_tech" ||
    normalized === "lab_technician"
  ) {
    return "csr";
  }
  return "user";
}

interface UsePushNotificationsOptions {
  role: NotificationRole;
  onPermissionGranted?: () => void;
}

type NotificationMode = "in_app" | "silent" | "sound" | "vibrate";
type NotificationChannel = "orderAlerts" | "platformUpdates";

function getNotificationMode(channel: NotificationChannel): NotificationMode {
  try {
    const raw = localStorage.getItem("notification_preferences");
    if (raw) {
      const parsed = JSON.parse(raw);
      const mode = parsed?.[channel];
      if (mode === "in_app" || mode === "silent" || mode === "sound" || mode === "vibrate") return mode;
    }
  } catch {
    // Ignore malformed local preferences.
  }
  const legacy = localStorage.getItem("notification_mode");
  if (legacy === "silent" || legacy === "sound" || legacy === "vibrate") return legacy;
  return channel === "orderAlerts" ? "sound" : "in_app";
}

function playNotificationTone() {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.value = 0.04;
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.16);
  } catch {
    // Browsers may block audio before a user gesture.
  }
}

export function usePushNotifications({ role, onPermissionGranted }: UsePushNotificationsOptions) {
  const permissionRef = useRef<NotificationPermission>("default");

  const requestPermission = useCallback(async () => {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") {
      permissionRef.current = "granted";
      onPermissionGranted?.();
      return true;
    }
    if (Notification.permission === "denied") {
      permissionRef.current = "denied";
      return false;
    }
    const result = await Notification.requestPermission();
    permissionRef.current = result;
    if (result === "granted") {
      onPermissionGranted?.();
      return true;
    }
    return false;
  }, [onPermissionGranted]);

  const sendNotification = useCallback((title: string, body: string, icon = "/lc-icon.png", channel: NotificationChannel = "platformUpdates") => {
    const mode = getNotificationMode(channel);
    if (mode === "silent") return;
    if (mode === "sound") playNotificationTone();
    if (mode === "vibrate" && "vibrate" in navigator) navigator.vibrate([90, 40, 90]);
    if (mode === "in_app" || !("Notification" in window) || Notification.permission !== "granted") return;
    const n = new Notification(title, {
      body,
      icon,
      badge: "/lc-icon.png",
      tag: `lc-${Date.now()}`,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    setTimeout(() => n.close(), 8000);
  }, []);

  const notifyOrderPlaced = useCallback((orderId: number, customerName?: string) => {
    if (role === "csr" || role === "supervisor" || role === "admin" || role === "global_admin") {
      sendNotification(
        "New Order Received",
        `Order #${orderId}${customerName ? ` from ${customerName}` : ""} has been placed and awaits processing.`,
        "/lc-icon.png",
        "orderAlerts"
      );
    }
  }, [role, sendNotification]);

  const notifyOrderReady = useCallback((orderId: number) => {
    if (role === "user") {
      sendNotification(
        "Your Order is Ready!",
        `Order #${orderId} has been completed and is ready. Thank you for choosing Lucifer Cruz.`,
        "/lc-icon.png",
        "orderAlerts"
      );
    }
  }, [role, sendNotification]);

  const notifyOrderStatusChange = useCallback((orderId: number, status: string) => {
    const messages: Record<string, { title: string; body: string }> = {
      processing: {
        title: "Order In Progress",
        body: `Order #${orderId} is now being processed by our team.`,
      },
      ready: {
        title: "Order Ready for Pickup",
        body: `Order #${orderId} is ready! Please proceed to collect your order.`,
      },
      delivered: {
        title: "Order Delivered",
        body: `Order #${orderId} has been marked as delivered.`,
      },
    };
    const msg = messages[status];
    if (msg) sendNotification(msg.title, msg.body, "/lc-icon.png", "orderAlerts");
  }, [sendNotification]);

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      const timer = setTimeout(() => requestPermission(), 3000);
      return () => clearTimeout(timer);
    }
    return;
  }, [requestPermission]);

  return {
    requestPermission,
    sendNotification,
    notifyOrderPlaced,
    notifyOrderReady,
    notifyOrderStatusChange,
    permission: typeof window !== "undefined" && "Notification" in window
      ? Notification.permission
      : "denied" as NotificationPermission,
  };
}
