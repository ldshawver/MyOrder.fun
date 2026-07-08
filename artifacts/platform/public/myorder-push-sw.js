/* MyOrder.fun PWA push worker */
const SERVICE_WORKER_VERSION = "20260708-push-subscription-repair-v3";
const CACHE_PREFIX = "myorder-push-sw";
const CACHE_VERSION = `${CACHE_PREFIX}-${SERVICE_WORKER_VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION).map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});

function notificationOptions(data) {
  const vibrateEnabled = data.vibrate !== false;
  return {
    body: data.body || data.message || "You have a new MyOrder.fun update.",
    icon: data.icon || "/lc-icon.png",
    badge: typeof data.badge === "string" ? data.badge : "/lc-icon.png",
    tag: data.tag || `myorder-${data.type || "push"}`,
    data: { url: data.url || "/notifications", badgeCount: Number.isFinite(data.badgeCount) ? data.badgeCount : undefined, ...data },
    silent: false,
    renotify: true,
    vibrate: vibrateEnabled ? (Array.isArray(data.vibrate) ? data.vibrate : [120, 60, 120]) : undefined,
  };
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "New MyOrder.fun notification", body: event.data ? event.data.text() : "Open MyOrder.fun for details." };
  }
  const title = data.title || (data.type === "sms" ? "New SMS message" : "New MyOrder.fun notification");
  const badgeCount = Number.isFinite(data.badgeCount) ? data.badgeCount : undefined;
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, notificationOptions(data)),
    badgeCount !== undefined && navigator.setAppBadge ? navigator.setAppBadge(badgeCount).catch(() => undefined) : Promise.resolve(),
  ]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/notifications";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => "focus" in client);
    if (existing) {
      existing.navigate(url);
      return existing.focus();
    }
    return self.clients.openWindow(url);
  }));
});

self.addEventListener("message", (event) => {
  if (event.data === "version") event.source?.postMessage({ serviceWorkerVersion: SERVICE_WORKER_VERSION });
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
