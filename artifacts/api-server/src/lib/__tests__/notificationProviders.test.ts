import { afterEach, describe, expect, it, vi } from "vitest";
import { listTuyaDevices, sendTwilioSms, setTuyaDeviceSwitch, testTwilioConnection, type SmsCredentials, type TuyaCredentials } from "../notificationProviders";

const sms: SmsCredentials = { accountSid: `AC${"a".repeat(32)}`, authToken: "unit-test-auth-token-123456", sender: "+15551234567" };
const tuya: TuyaCredentials = { clientId: "unit-test-client", clientSecret: "unit-test-client-secret-123", region: "us" };

afterEach(() => vi.unstubAllGlobals());

describe("notification provider adapters", () => {
  it("tests Twilio credentials against the actual account endpoint", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(testTwilioConnection(sms)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toContain(sms.accountSid);
  });

  it("sends SMS through Twilio and returns only its message identifier", async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("MyOrder.fun");
      return new Response(JSON.stringify({ sid: "SMunit-test" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(sendTwilioSms(sms, "+15557654321", "MyOrder.fun test")).resolves.toBe("SMunit-test");
  });

  it("discovers Tuya devices through its cloud API", async () => {
    const fetch = vi.fn(async (input: unknown) => String(input).includes("/token?")
      ? new Response(JSON.stringify({ success: true, result: { access_token: "ephemeral" } }), { status: 200 })
      : new Response(JSON.stringify({ success: true, result: { list: [{ id: "device-1", name: "Order light", online: true }, { invalid: true }] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(listTuyaDevices(tuya)).resolves.toEqual([{ id: "device-1", name: "Order light", online: true }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("controls the selected Tuya switch through the device command endpoint", async () => {
    const fetch = vi.fn(async (input: unknown, _init?: RequestInit) => String(input).includes("/token?")
      ? new Response(JSON.stringify({ success: true, result: { access_token: "ephemeral" } }), { status: 200 })
      : new Response(JSON.stringify({ success: true, result: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(setTuyaDeviceSwitch(tuya, "device-1", "switch_1", true)).resolves.toBeUndefined();
    expect(String(fetch.mock.calls[1]?.[0])).toContain("/devices/device-1/commands");
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ commands: [{ code: "switch_1", value: true }] }));
  });
});
