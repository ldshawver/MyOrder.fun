import { describe, expect, it, vi } from "vitest";
import { normalizeNotificationPreferences, sendOrderStatusSmsEmailIfAllowed, shouldSendNotificationChannel, notificationPreferencesSchema } from "../notificationPrefs";

describe("notification preference normalization and enforcement", () => {
  it("persists all supported channels and the in-app mode", () => {
    const prefs = notificationPreferencesSchema.parse({
      inAppAlerts: true,
      smsTexts: false,
      emails: false,
      inAppAlertMode: "sound_vibrate",
    });
    expect(prefs.inAppAlertMode).toBe("sound_vibrate");
    expect(shouldSendNotificationChannel(prefs, "sms")).toBe(false);
    expect(shouldSendNotificationChannel(prefs, "email")).toBe(false);
    expect(shouldSendNotificationChannel(prefs, "in_app")).toBe(true);
  });

  it("rejects unknown preference fields", () => {
    expect(() => notificationPreferencesSchema.parse({
      inAppAlerts: true,
      smsTexts: true,
      emails: true,
      inAppAlertMode: "sound",
      userId: 2,
    })).toThrow();
  });

  it("blocks SMS callback when SMS is opted out while allowed email still runs", async () => {
    const sms = vi.fn();
    const email = vi.fn();

    await sendOrderStatusSmsEmailIfAllowed({
      inAppAlerts: true,
      smsTexts: false,
      emails: true,
      inAppAlertMode: "sound",
    }, { sms, email });

    expect(sms).not.toHaveBeenCalled();
    expect(email).toHaveBeenCalledTimes(1);
  });

  it("blocks email callback when email is opted out while allowed SMS still runs", async () => {
    const sms = vi.fn();
    const email = vi.fn();

    await sendOrderStatusSmsEmailIfAllowed({
      inAppAlerts: true,
      smsTexts: true,
      emails: false,
      inAppAlertMode: "sound",
    }, { sms, email });

    expect(sms).toHaveBeenCalledTimes(1);
    expect(email).not.toHaveBeenCalled();
  });

  it("blocks both SMS and email callbacks when both channels are opted out", async () => {
    const sms = vi.fn();
    const email = vi.fn();

    await sendOrderStatusSmsEmailIfAllowed({
      inAppAlerts: true,
      smsTexts: false,
      emails: false,
      inAppAlertMode: "sound",
    }, { sms, email });

    expect(sms).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
  });

  it("uses default preferences when stored preferences are missing", async () => {
    const sms = vi.fn();
    const email = vi.fn();

    await sendOrderStatusSmsEmailIfAllowed(undefined, { sms, email });

    expect(sms).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(1);
  });

  it("migrates legacy order alert mode without enabling client-controlled recipients", () => {
    expect(normalizeNotificationPreferences({ orderAlerts: "vibrate" }).inAppAlertMode).toBe("vibrate");
  });
});
