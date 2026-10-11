import { createHash, createHmac, randomUUID } from "node:crypto";

export type TuyaRegion = "us" | "eu" | "in" | "cn" | "ueaz" | "weaz";
export type TuyaCredentials = { clientId: string; clientSecret: string; region: TuyaRegion };
export type SmsCredentials = { accountSid: string; authToken: string; sender: string };

const TUYA_HOSTS: Record<TuyaRegion, string> = {
  us: "openapi.tuyaus.com", eu: "openapi.tuyaeu.com", in: "openapi.tuyain.com",
  cn: "openapi.tuyacn.com", ueaz: "openapi-ueaz.tuyaus.com", weaz: "openapi-weaz.tuyaeu.com",
};
const PROVIDER_TIMEOUT_MS = 8000;

export class NotificationProviderError extends Error {
  constructor(readonly failure: "configuration" | "transient" | "permanent" | "uncertain") { super(failure); }
}

async function twilioRequest(config: SmsCredentials, path: string, init: RequestInit = {}): Promise<Response> {
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
  try {
    return await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/${path}`, {
      ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: { Authorization: `Basic ${auth}`, ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...init.headers },
    });
  } catch { throw new NotificationProviderError("transient"); }
}

export async function testTwilioConnection(config: SmsCredentials): Promise<boolean> {
  const response = await twilioRequest(config, ".json");
  if (response.status === 401 || response.status === 403) throw new NotificationProviderError("configuration");
  if (!response.ok) throw new NotificationProviderError(response.status === 429 || response.status >= 500 ? "transient" : "permanent");
  return true;
}

export async function sendTwilioSms(config: SmsCredentials, to: string, text: string): Promise<string> {
  const form = new URLSearchParams({ To: to, Body: text, ...(config.sender.startsWith("MG") ? { MessagingServiceSid: config.sender } : { From: config.sender }) });
  let response: Response;
  try { response = await twilioRequest(config, "Messages.json", { method: "POST", body: form }); }
  catch (error) { throw new NotificationProviderError(error instanceof NotificationProviderError && error.failure === "transient" ? "uncertain" : "permanent"); }
  if (!response.ok) throw new NotificationProviderError(response.status === 429 ? "transient" : response.status >= 500 ? "uncertain" : "permanent");
  const data = await response.json() as { sid?: string };
  if (!data.sid) throw new NotificationProviderError("transient");
  return data.sid;
}

export type TuyaDevice = { id: string; name: string; online: boolean };
export async function tuyaRequest(config: TuyaCredentials, method: "GET" | "POST", path: string, body?: string, token?: string): Promise<unknown> {
  const base = new URL(`https://${TUYA_HOSTS[config.region]}`);
  const timestamp = String(Date.now());
  const nonce = randomUUID().replaceAll("-", "");
  const contentHash = createHash("sha256").update(body ?? "").digest("hex");
  const stringToSign = `${method}\n${contentHash}\n\n${path}`;
  const signature = createHmac("sha256", config.clientSecret).update(`${config.clientId}${token ?? ""}${timestamp}${nonce}${stringToSign}`).digest("hex").toUpperCase();
  let response: Response;
  try {
    response = await fetch(new URL(path, base), { method, body, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS), headers: {
      client_id: config.clientId, t: timestamp, nonce, sign: signature, sign_method: "HMAC-SHA256",
      ...(token ? { access_token: token } : {}), ...(body ? { "Content-Type": "application/json" } : {}),
    } });
  } catch { throw new NotificationProviderError("transient"); }
  if (!response.ok) throw new NotificationProviderError(response.status === 429 || response.status >= 500 ? "transient" : "permanent");
  const data = await response.json() as { success?: boolean; result?: unknown; code?: number };
  if (data.success !== true) throw new NotificationProviderError(data.code === 1010 || data.code === 1004 ? "configuration" : "permanent");
  return data.result;
}

export async function getTuyaAccessToken(config: TuyaCredentials): Promise<string> {
  const result = await tuyaRequest(config, "GET", "/v1.0/token?grant_type=1") as { access_token?: string } | null;
  if (!result?.access_token) throw new NotificationProviderError("configuration");
  return result.access_token;
}

export async function listTuyaDevices(config: TuyaCredentials): Promise<TuyaDevice[]> {
  const token = await getTuyaAccessToken(config);
  const result = await tuyaRequest(config, "GET", "/v1.3/iot-03/devices?page_size=100", undefined, token) as { list?: unknown[] } | null;
  return (result?.list ?? []).flatMap((value): TuyaDevice[] => {
    if (!value || typeof value !== "object") return [];
    const row = value as { id?: unknown; name?: unknown; online?: unknown };
    if (typeof row.id !== "string" || typeof row.name !== "string") return [];
    return [{ id: row.id, name: row.name.slice(0, 120), online: row.online === true }];
  });
}

export async function setTuyaDeviceSwitch(config: TuyaCredentials, deviceId: string, code: string, on: boolean): Promise<void> {
  const token = await getTuyaAccessToken(config);
  const body = JSON.stringify({ commands: [{ code, value: on }] });
  const result = await tuyaRequest(config, "POST", `/v1.0/iot-03/devices/${encodeURIComponent(deviceId)}/commands`, body, token);
  if (result !== true) throw new NotificationProviderError("permanent");
}

export function tuyaRegionHost(region: TuyaRegion): string { return TUYA_HOSTS[region]; }
