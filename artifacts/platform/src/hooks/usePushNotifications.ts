import { useEffect, useCallback, useRef } from "react";

export type NotificationRole = "user" | "business_sitter" | "supervisor" | "admin";

interface UsePushNotificationsOptions {
  role: NotificationRole;
  onPermissionGranted?: () => void;
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

  const sendNotification = useCallback((title: string, body: string, icon = "/lc-icon.png") => {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
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
    if (role === "business_sitter" || role === "supervisor" || role === "admin") {
      sendNotification(
        "New Order Received",
        `Order #${orderId}${customerName ? ` from ${customerName}` : ""} has been placed and awaits processing.`
      );
    }
  }, [role, sendNotification]);

  const notifyOrderReady = useCallback((orderId: number) => {
    if (role === "user") {
      sendNotification(
        "Your Order is Ready!",
        `Order #${orderId} has been completed and is ready. Thank you for choosing Lucifer Cruz.`
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
    if (msg) sendNotification(msg.title, msg.body);
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
