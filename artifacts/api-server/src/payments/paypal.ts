import type { EnabledPaymentConfig, Money, PaymentProvider, PayPalTransmissionHeaders, ProviderCapture, ProviderOrder, ProviderRefund } from "./provider";

type Json = Record<string, unknown>;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const ORDER_STATUSES = new Set(["CREATED", "SAVED", "APPROVED", "VOIDED", "COMPLETED", "PAYER_ACTION_REQUIRED"]);
const CAPTURE_STATUSES = new Set(["COMPLETED", "DECLINED", "PARTIALLY_REFUNDED", "PENDING", "REFUNDED", "FAILED"]);

async function boundedJson(response: Response): Promise<Json> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new PayPalProviderError("invalid_response", "PayPal response exceeded the size limit");
  }
  if (!response.body) throw new PayPalProviderError("invalid_response", "PayPal response was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PayPalProviderError("invalid_response", "PayPal response exceeded the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Json;
  } catch {
    throw new PayPalProviderError("invalid_response", "PayPal response was not valid JSON");
  }
}

function fundingSource(source: Json | undefined): import("./provider").ProviderFundingSource | undefined {
  if (!source) return undefined;
  if (source.venmo) return "venmo";
  if (source.apple_pay) return "apple_pay";
  if (source.google_pay) return "google_pay";
  const card = source.card as Json | undefined;
  const cardType = typeof card?.card_type === "string" ? card.card_type.toLowerCase() : "";
  if (cardType === "debit") return "debit";
  if (cardType === "credit") return "credit";
  if (source.paypal) return "paypal";
  return undefined;
}

function approvalUrl(value: unknown, environment: EnabledPaymentConfig["environment"]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new PayPalProviderError("invalid_response", "PayPal approval URL invalid");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new PayPalProviderError("invalid_response", "PayPal approval URL invalid"); }
  const expectedOrigin = environment === "sandbox" ? "https://www.sandbox.paypal.com" : "https://www.paypal.com";
  if (parsed.origin !== expectedOrigin || parsed.username || parsed.password) {
    throw new PayPalProviderError("invalid_response", "PayPal approval URL invalid");
  }
  return parsed.toString();
}

function onlyObject(value: unknown): Json | undefined {
  return Array.isArray(value) && value.length === 1 && value[0] && typeof value[0] === "object" && !Array.isArray(value[0])
    ? value[0] as Json
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validMoney(value: Json | undefined): value is Json & { value: string; currency_code: string } {
  return typeof value?.value === "string"
    && /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(value.value)
    && typeof value.currency_code === "string"
    && /^[A-Z]{3}$/.test(value.currency_code);
}

export class PayPalProviderError extends Error {
  constructor(public readonly failureClass: "declined" | "timeout" | "provider_error" | "invalid_response" | "unknown_outcome", message: string) { super(message); this.name = "PayPalProviderError"; }
}

export class PayPalProvider implements PaymentProvider {
  private accessToken?: { value: string; expiresAt: number };
  constructor(private readonly config: EnabledPaymentConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) return this.accessToken.value;
    const auth = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.apiOrigin}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials", signal: AbortSignal.timeout(10_000) });
    } catch {
      // Authentication happens before a payment mutation is sent, so its
      // transport failure is retryable and never an ambiguous payment outcome.
      throw new PayPalProviderError("provider_error", "PayPal authentication failed");
    }
    if (!response.ok) throw new PayPalProviderError("provider_error", "PayPal authentication failed");
    const body = await boundedJson(response) as { access_token?: string; expires_in?: number };
    if (!nonEmptyString(body.access_token)
      || (body.expires_in !== undefined && (!Number.isInteger(body.expires_in) || body.expires_in <= 0 || body.expires_in > 86_400))) {
      throw new PayPalProviderError("invalid_response", "PayPal authentication response invalid");
    }
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + Math.max(60, body.expires_in ?? 300) * 1000 };
    return body.access_token;
  }

  /** Auth-only diagnostic. It never returns the access token or credentials. */
  async testConnection(): Promise<void> {
    await this.token();
  }

  private async request(path: string, init: RequestInit, requestId?: string): Promise<Json> {
    const accessToken = await this.token();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.apiOrigin}${path}`, { ...init, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json", ...(requestId ? { "PayPal-Request-Id": requestId } : {}), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
    } catch {
      // Once a mutating request is handed to the transport, a rejection cannot
      // prove that PayPal did not accept it. Durable reconciliation and the
      // PayPal-Request-Id must govern any retry.
      if (requestId) throw new PayPalProviderError("unknown_outcome", "PayPal request outcome is unknown");
      throw new PayPalProviderError("provider_error", "PayPal request failed");
    }
    const body = await boundedJson(response);
    if (!response.ok) throw new PayPalProviderError(response.status === 422 ? "declined" : "provider_error", `PayPal request rejected (${response.status})`);
    return body;
  }

  async createOrder(input: { amount: Money; requestId: string; internalOrderId: number }): Promise<ProviderOrder> {
    const body = await this.request("/v2/checkout/orders", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ reference_id: String(input.internalOrderId), amount: { currency_code: input.amount.currency, value: input.amount.value } }] }) }, input.requestId);
    const unit = onlyObject(body.purchase_units); const amount = unit?.amount as Json | undefined;
    if (!nonEmptyString(body.id) || typeof body.status !== "string" || !ORDER_STATUSES.has(body.status) || unit?.reference_id !== String(input.internalOrderId) || amount?.value !== input.amount.value || amount.currency_code !== input.amount.currency) throw new PayPalProviderError("invalid_response", "PayPal order response invalid");
    const rawApprovalUrl = (body.links as Array<Json> | undefined)?.find(link => link.rel === "payer-action" || link.rel === "approve")?.href;
    return { id: body.id, status: body.status, amount: { value: amount.value, currency: amount.currency_code }, approvalUrl: approvalUrl(rawApprovalUrl, this.config.environment) };
  }
  async getOrder(id: string): Promise<ProviderOrder> {
    const body = await this.request(`/v2/checkout/orders/${encodeURIComponent(id)}`, { method: "GET" }); const unit = onlyObject(body.purchase_units); const amount = unit?.amount as Json | undefined;
    if (body.id !== id || typeof body.status !== "string" || !ORDER_STATUSES.has(body.status) || !validMoney(amount)) throw new PayPalProviderError("invalid_response", "PayPal order response invalid");
    const captures = (unit?.payments as Json | undefined)?.captures;
    const rawCapture = captures === undefined ? undefined : onlyObject(captures); const captureAmount = rawCapture?.amount as Json | undefined;
    if (captures !== undefined && !rawCapture) throw new PayPalProviderError("invalid_response", "PayPal order response invalid");
    const capture = nonEmptyString(rawCapture?.id) && typeof rawCapture.status === "string" && CAPTURE_STATUSES.has(rawCapture.status) && validMoney(captureAmount) ? { orderId: body.id, captureId: rawCapture.id, status: rawCapture.status, amount: { value: captureAmount.value, currency: captureAmount.currency_code } } : undefined;
    if (rawCapture && !capture) throw new PayPalProviderError("invalid_response", "PayPal order response invalid");
    return { id: body.id, status: body.status, amount: { value: amount.value, currency: amount.currency_code }, capture };
  }
  async captureOrder(id: string, requestId: string): Promise<ProviderCapture> {
    const body = await this.request(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, { method: "POST", headers: { Prefer: "return=representation" }, body: "{}" }, requestId); return this.parseCapture(body, id);
  }
  async getCapture(id: string): Promise<ProviderCapture> {
    const body = await this.request(`/v2/payments/captures/${encodeURIComponent(id)}`, { method: "GET" });
    const amount = body.amount as Json | undefined; const related = (body.supplementary_data as Json | undefined)?.related_ids as Json | undefined;
    if (body.id !== id || !nonEmptyString(body.id) || typeof body.status !== "string" || !CAPTURE_STATUSES.has(body.status) || !validMoney(amount) || !nonEmptyString(related?.order_id)) throw new PayPalProviderError("invalid_response", "PayPal capture response invalid");
    const source = body.payment_source as Json | undefined;
    return { orderId: related.order_id, captureId: body.id, status: body.status, amount: { value: amount.value, currency: amount.currency_code }, fundingSource: fundingSource(source) };
  }
  private parseCapture(body: Json, orderId: string): ProviderCapture {
    const unit = onlyObject(body.purchase_units); const payments = unit?.payments as Json | undefined; const capture = onlyObject(payments?.captures); const amount = capture?.amount as Json | undefined;
    if (body.id !== orderId || !nonEmptyString(body.id) || typeof body.status !== "string" || !ORDER_STATUSES.has(body.status) || !nonEmptyString(capture?.id) || typeof capture.status !== "string" || !CAPTURE_STATUSES.has(capture.status) || !validMoney(amount)) throw new PayPalProviderError("invalid_response", "PayPal capture response invalid");
    const source = body.payment_source as Json | undefined;
    return { orderId, captureId: capture.id, status: capture.status, amount: { value: amount.value, currency: amount.currency_code }, fundingSource: fundingSource(source) };
  }
  async refundCapture(id: string, amount: Money, requestId: string, note: string): Promise<ProviderRefund> {
    const body = await this.request(`/v2/payments/captures/${encodeURIComponent(id)}/refund`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ amount: { value: amount.value, currency_code: amount.currency }, note_to_payer: note.slice(0, 255) }) }, requestId);
    const returned = body.amount as Json | undefined;
    const status = typeof body.status === "string" ? body.status : undefined;
    const recognizedStatuses = new Set(["COMPLETED", "PENDING", "FAILED", "CANCELLED"]);
    if (!nonEmptyString(body.id) || !status || !recognizedStatuses.has(status)) throw new PayPalProviderError("invalid_response", "PayPal refund response invalid");
    if (returned !== undefined && (typeof returned !== "object" || returned === null || Array.isArray(returned))) throw new PayPalProviderError("invalid_response", "PayPal refund response invalid");
    // PayPal may honor Prefer: return=representation by returning amount, but a
    // valid minimal success response is allowed to omit it. The requested amount
    // is already server-authoritative and is retained for local reconciliation.
    // Validate the optional representation's shape here. The service persists
    // `id` and `status` first, then compares its value durably for reconciliation.
    if (returned && !validMoney(returned)) throw new PayPalProviderError("invalid_response", "PayPal refund response invalid");
    return returned
      ? { refundId: body.id, status, amount: { value: returned.value, currency: returned.currency_code } }
      : { refundId: body.id, status };
  }
  async verifyWebhook(headers: PayPalTransmissionHeaders, event: unknown): Promise<boolean> {
    const body = await this.request("/v1/notifications/verify-webhook-signature", { method: "POST", body: JSON.stringify({ auth_algo: headers.authAlgorithm, cert_url: headers.certificateUrl, transmission_id: headers.transmissionId, transmission_sig: headers.transmissionSignature, transmission_time: headers.transmissionTime, webhook_id: this.config.webhookId, webhook_event: event }) });
    if (body.verification_status !== "SUCCESS" && body.verification_status !== "FAILURE") {
      throw new PayPalProviderError("invalid_response", "PayPal webhook verification response invalid");
    }
    return body.verification_status === "SUCCESS";
  }
}
