import { describe, expect, it, vi, beforeEach } from "vitest";
import { repairPushNotifications } from "../pwaPushRepair";

describe("repairPushNotifications", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("subscribes and posts to backend when permission is granted but subscription is missing", async () => {
    const subscribe = vi.fn(async () => ({ toJSON: () => ({ endpoint: "https://push.example/sub", keys: { p256dh: "p", auth: "a" } }) }));
    const registration = { update: vi.fn(), pushManager: { getSubscription: vi.fn(async () => null), subscribe } };
    Object.defineProperty(window, "Notification", { configurable: true, value: { permission: "granted", requestPermission: vi.fn() } });
    Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {} });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistrations: vi.fn(async () => []), register: vi.fn(async () => registration), ready: Promise.resolve(registration) } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("vapid-public-key")
      ? new Response(JSON.stringify({ publicKey: "BEl6ecxLkz5Qd0SMockKey______________-___________________________" }), { status: 200 })
      : new Response(JSON.stringify({ ok: true, pushSubscriptionActive: true }), { status: 200 })));

    const result = await repairPushNotifications(async () => "token");

    expect(result.ok).toBe(true);
    expect(registration.pushManager.getSubscription).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("api/pwa/push/subscribe"), expect.objectContaining({ method: "POST" }));
  });
});
