import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ordersRoute = readFileSync(resolve(__dirname, "../orders.ts"), "utf8");
const notificationPrefs = readFileSync(resolve(__dirname, "../../lib/notificationPrefs.ts"), "utf8");

describe("order status notification preference wiring", () => {
  it("keeps the status route wired through the preference-gated helper", () => {
    expect(ordersRoute).toContain("sendOrderStatusSmsEmailIfAllowed");
    expect(ordersRoute).toContain("notificationPreferences: usersTable.notificationPreferences");
    expect(ordersRoute).toContain("contactPhone: usersTable.contactPhone");
  });

  it("keeps sms and email checks independent", () => {
    expect(notificationPrefs).toContain('shouldSendNotificationChannel(user.notificationPreferences, "sms")');
    expect(notificationPrefs).toContain('shouldSendNotificationChannel(user.notificationPreferences, "email")');
  });
});
