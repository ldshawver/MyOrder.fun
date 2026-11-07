import { and, eq } from "drizzle-orm";
import { db, printBridgeProfilesTable } from "@workspace/db";

export type RaspberryPiWifiResult =
  | { ok: true }
  | { ok: false; error: string };

function bridgeHost(url: string): string {
  try { return new URL(url).host; } catch { return "the print bridge"; }
}

async function postWifi(bridgeUrl: string, apiKey: string, ssid: string, password: string): Promise<RaspberryPiWifiResult> {
  const url = bridgeUrl.replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 70_000);
  try {
    const response = await fetch(`${url}/wifi`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ ssid, password }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
    if (response.ok && body.success === true) return { ok: true };
    return { ok: false, error: body.error || "The Raspberry Pi rejected that Wi-Fi." };
  } catch {
    try {
      const health = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5_000) });
      if (health.ok) return { ok: false, error: "The Raspberry Pi is online, but it did not confirm the new Wi-Fi. Check the name and password, then save again." };
    } catch { /* still unreachable */ }
    return { ok: false, error: `The Raspberry Pi at ${bridgeHost(url)} did not stay reachable. If that network was wrong, it returns to the previous Wi-Fi within a minute.` };
  } finally {
    clearTimeout(timer);
  }
}

/** Tell each active Raspberry Pi print bridge to join this WPA network. */
export async function pushRaspberryPiWifi(tenantId: number, ssid: string, password: string): Promise<RaspberryPiWifiResult> {
  const profiles = await db.select({
    bridgeUrl: printBridgeProfilesTable.bridgeUrl,
    apiKey: printBridgeProfilesTable.apiKey,
  }).from(printBridgeProfilesTable).where(and(
    eq(printBridgeProfilesTable.tenantId, tenantId),
    eq(printBridgeProfilesTable.isActive, true),
    eq(printBridgeProfilesTable.bridgeType, "raspberry_pi"),
  ));
  const bridges = new Map<string, string>();
  for (const profile of profiles) {
    const url = profile.bridgeUrl.trim().replace(/\/$/, "");
    if (!url.startsWith("http") || !profile.apiKey || bridges.has(url)) continue;
    bridges.set(url, profile.apiKey);
  }
  if (bridges.size === 0) return { ok: false, error: "No Raspberry Pi print bridge is configured." };
  const errors: string[] = [];
  for (const [url, apiKey] of bridges) {
    const result = await postWifi(url, apiKey, ssid, password);
    if (result.ok) return result;
    errors.push(result.error);
  }
  return { ok: false, error: errors[0] ?? "The Raspberry Pi did not join that Wi-Fi." };
}
