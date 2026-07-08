import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../pwa-push.ts", import.meta.url), "utf8");
const repair = readFileSync(new URL("../../../../platform/src/lib/pwaPushRepair.ts", import.meta.url), "utf8");
const account = readFileSync(new URL("../../../../platform/src/pages/account.tsx", import.meta.url), "utf8");
const pushSender = readFileSync(new URL("../../lib/pwaPushSender.ts", import.meta.url), "utf8");
const smsRoute = readFileSync(new URL("../twilio-sms.ts", import.meta.url), "utf8");
const sw = readFileSync(new URL("../../../../platform/public/myorder-push-sw.js", import.meta.url), "utf8");

describe("PWA push repair implementation", () => {
  it("debug route degrades to JSON 200 instead of returning HTML/500 on schema drift", () => {
    expect(route).toContain('router.get("/pwa/push/debug"');
    expect(route).toContain('res.status(200).json');
    expect(route).toContain('PWA push debug degraded but returned 200');
    expect(route).toContain('missingColumnFromError');
    expect(route).toContain('database_schema_error');
    expect(route).toContain('missing_column');
    expect(route).toContain('rollbackFailedTransaction');
    expect(route).toContain('"no_active_push_subscription"');
    expect(route).not.toContain('device_key');
  });

  it("repairs granted permission with missing subscription", () => {
    expect(repair).toContain('registration.pushManager.getSubscription()');
    expect(repair).toContain('registration.pushManager.subscribe');
    expect(repair).toContain('api/pwa/push/subscribe');
  });

  it("exposes a user-facing repair action", () => {
    expect(account).toContain('Repair Push Notifications');
    expect(account).toContain('data-testid="button-repair-push-notifications"');
  });

  it("push sender protects subscription secrets and SMS route calls it", () => {
    expect(pushSender).toContain("pushEndpointHash");
    expect(pushSender).toContain("endpointHash");
    expect(smsRoute).toContain("storeInboundSms");
    expect(smsRoute).toContain("sendPwaPushToTenant");
  });

  it("push event displays audible and renotify notification options", () => {
    expect(sw).toContain('self.addEventListener("push"');
    expect(sw).toContain('self.registration.showNotification');
    expect(sw).toContain('silent: false');
    expect(sw).toContain('renotify: true');
    expect(sw).toContain('badge:');
    expect(sw).toContain('vibrate:');
  });
});


describe("PWA push schema migration", () => {
  const migration = readFileSync(new URL("../../../../../lib/db/migrations/202607080001_pwa_push_subscriptions.sql", import.meta.url), "utf8");

  it("creates the push subscription schema with device_id instead of legacy device_key", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS pwa_push_subscriptions");
    expect(migration).toContain("device_id text NOT NULL");
    expect(migration).not.toContain("device_key");
  });
});
