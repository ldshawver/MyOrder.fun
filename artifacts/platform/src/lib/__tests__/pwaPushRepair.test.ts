// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { repairPushNotifications } from "../pwaPushRepair";

describe("repairPushNotifications", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("subscribes and posts to backend when permission is granted but subscription is missing", async () => {
    const subscribe = vi.fn(async () => ({ toJSON: () => ({ endpoint: "https://push.example/sub", keys: { p256dh: "p", auth: "a" } }) }));
    const registration = { update: vi.fn(async () => undefined), pushManager: { getSubscription: vi.fn(async () => null), subscribe } };
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

  it("stops cleanly when browser permission is denied", async () => {
    const requestPermission = vi.fn(async () => "denied" as NotificationPermission);
    Object.defineProperty(window, "Notification", { configurable: true, value: { permission: "default", requestPermission } });
    Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {} });
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    const result = await repairPushNotifications(async () => "token");
    expect(result).toMatchObject({ ok: false, code: "permission_not_granted" });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports unsupported browsers without attempting registration", async () => {
    Object.defineProperty(window, "Notification", { configurable: true, value: { permission: "granted" } });
    vi.stubGlobal("navigator", { userAgent: "test browser", platform: "test", maxTouchPoints: 0 });
    const result = await repairPushNotifications(async () => "token");
    expect(result).toMatchObject({ ok: false, code: "unsupported_service_worker" });
  });

  it("reuses an existing subscription and persists registration after refresh or login", async () => {
    const existing = { toJSON: () => ({ endpoint: "https://push.example/existing", keys: { p256dh: "p", auth: "a" } }) };
    const subscribe = vi.fn();
    const registration = { update: vi.fn(async () => undefined), pushManager: { getSubscription: vi.fn(async () => existing), subscribe } };
    Object.defineProperty(window, "Notification", { configurable: true, value: { permission: "granted" } });
    Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {} });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistrations: vi.fn(async () => []), register: vi.fn(async () => registration), ready: Promise.resolve(registration) } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const result = await repairPushNotifications(async () => "refreshed-session-token");
    expect(result.ok).toBe(true);
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("api/pwa/push/subscribe"), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer refreshed-session-token" }),
    }));
  });

  it("turns service worker and push registration failures into a helpful result", async () => {
    Object.defineProperty(window, "Notification", { configurable: true, value: { permission: "granted" } });
    Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {} });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistrations: vi.fn(async () => { throw new Error("network token sentinel"); }) } });
    const result = await repairPushNotifications(async () => "token");
    expect(result).toMatchObject({ ok: false, code: "push_setup_failed" });
    expect(JSON.stringify(result)).not.toContain("network token sentinel");
  });
});
