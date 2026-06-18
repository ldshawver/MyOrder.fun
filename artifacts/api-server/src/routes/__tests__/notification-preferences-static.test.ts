import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("notification preference wiring", () => {
  it("fixes the account notification settings URL and exposes controls", () => {
    const app = readFileSync("../platform/src/App.tsx", "utf8");
    const layout = readFileSync("../platform/src/components/layout.tsx", "utf8");
    const account = readFileSync("../platform/src/pages/account.tsx", "utf8");
    expect(app).toContain('<Route path="/account">');
    expect(layout).toContain('href: "/account", label: "Account Settings"');
    expect(account).toContain('data-testid={`button-notification-${channel.key}`}');
    expect(account).toContain('sound_vibrate');
  });

  it("order status notification pipeline checks tenant-scoped current preferences before inserting in-app alerts", () => {
    const orders = readFileSync("src/routes/orders.ts", "utf8");
    expect(orders).toContain('shouldSendNotificationChannel(customerPrefs.notificationPreferences, "in_app")');
    expect(orders).toContain('sendOrderStatusSmsEmailIfAllowed(customerPrefs.notificationPreferences, {})');
    expect(orders).toContain('eq(usersTable.tenantId, order.tenantId)');
  });
});
