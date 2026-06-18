import { describe, expect, it, vi } from "vitest";
import { sendOrderStatusSmsEmailIfAllowed, shouldSendNotificationChannel } from "../notificationPrefs";

describe("notification preference guards", () => {
  it("defaults sms and email order-status channels to allowed", () => {
    expect(shouldSendNotificationChannel(undefined, "sms")).toBe(true);
    expect(shouldSendNotificationChannel(undefined, "email")).toBe(true);
  });

  it("honors independent nested sms and email opt-outs", () => {
    const prefs = { orderStatusNotifications: { sms: false, email: true } };
    expect(shouldSendNotificationChannel(prefs, "sms")).toBe(false);
    expect(shouldSendNotificationChannel(prefs, "email")).toBe(true);
  });

  it("does not let a blocked sms preference block an allowed email callback", async () => {
    const sms = vi.fn();
    const email = vi.fn();
    const result = await sendOrderStatusSmsEmailIfAllowed(
      {
        id: 10,
        email: "customer@example.com",
        contactPhone: "+15555550100",
        notificationPreferences: { orderStatusNotifications: { sms: false, email: true } },
      },
      { id: 123, tenantId: 1 },
      "delivered",
      { sms, email },
    );

    expect(sms).not.toHaveBeenCalled();
    expect(email).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sms: false, email: true });
  });

  it("does not let a blocked email preference block an allowed sms callback", async () => {
    const sms = vi.fn();
    const email = vi.fn();
    const result = await sendOrderStatusSmsEmailIfAllowed(
      {
        id: 10,
        email: "customer@example.com",
        contactPhone: "+15555550100",
        notificationPreferences: { orderStatusNotifications: { sms: true, email: false } },
      },
      { id: 123, tenantId: 1 },
      "ready",
      { sms, email },
    );

    expect(sms).toHaveBeenCalledTimes(1);
    expect(email).not.toHaveBeenCalled();
    expect(result).toEqual({ sms: true, email: false });
  });
});
