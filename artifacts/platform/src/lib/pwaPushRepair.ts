export type PushRepairResult = { ok: true; message: string; pushSubscriptionActive: true } | { ok: false; message: string; code: string };

const PUSH_SW_FILENAME = "myorder-push-sw.js";
const LEGACY_PUSH_SW_FILENAME = "pwa-service-worker.js";
const SW_URL = `${import.meta.env.BASE_URL}${PUSH_SW_FILENAME}`;

function isStandalonePwa(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches || ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function deviceId(): string {
  const key = "myorder_push_device_id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID?.() ?? `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(key, id);
  return id;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

export async function repairPushNotifications(getToken: () => Promise<string | null>): Promise<PushRepairResult> {
  if (!("serviceWorker" in navigator)) return { ok: false, code: "unsupported_service_worker", message: "This browser does not support service workers. Use Chrome, Edge, or an installed iOS Home Screen PWA." };
  if (!("PushManager" in window)) return { ok: false, code: "unsupported_push", message: "This browser does not support Web Push. On iPhone/iPad, open the app from the Home Screen icon." };
  if (!("Notification" in window)) return { ok: false, code: "unsupported_notifications", message: "Notifications are not supported in this browser." };
  if (isIos() && !isStandalonePwa()) return { ok: false, code: "ios_home_screen_required", message: "On iPhone/iPad, install MyOrder.fun to the Home Screen and open that icon before enabling push notifications." };

  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, code: "permission_not_granted", message: "Notification permission is blocked or was not granted. Enable notifications in browser settings, then run repair again." };

  await Promise.all((await navigator.serviceWorker.getRegistrations()).map(async (existing) => {
    const scriptUrl = existing.active?.scriptURL || existing.installing?.scriptURL || existing.waiting?.scriptURL || "";
    if (scriptUrl.endsWith(LEGACY_PUSH_SW_FILENAME)) await existing.unregister();
    else await existing.update().catch(() => undefined);
  }));

  const registration = await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  await navigator.serviceWorker.ready;
  await registration.update().catch(() => undefined);

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const token = await getToken();
    const keyRes = await fetch(`${import.meta.env.BASE_URL}api/pwa/push/vapid-public-key`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    const keyBody = await keyRes.json().catch(() => ({}));
    const publicKey = String(keyBody.publicKey ?? import.meta.env.VITE_VAPID_PUBLIC_KEY ?? "");
    if (!publicKey) return { ok: false, code: "missing_vapid_key", message: "Push is not configured on the server: missing VAPID public key." };
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer });
  }

  const token = await getToken();
  const res = await fetch(`${import.meta.env.BASE_URL}api/pwa/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ subscription: subscription.toJSON(), device: { id: deviceId(), userAgent: navigator.userAgent, platform: navigator.platform } }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, code: "backend_registration_failed", message: body.error ?? "Could not register this device for push notifications." };
  }
  return { ok: true, message: "Push notifications repaired. Diagnostics should now show pushSubscriptionActive=true.", pushSubscriptionActive: true };
}
