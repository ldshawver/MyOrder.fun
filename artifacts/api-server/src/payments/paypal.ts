import type { EnabledPaymentConfig, Money, PaymentProvider, PayPalTransmissionHeaders, ProviderCapture, ProviderOrder, ProviderRefund } from "./provider";

type Json = Record<string, unknown>;

export class PayPalProviderError extends Error {
  constructor(public readonly failureClass: "declined" | "timeout" | "provider_error" | "invalid_response" | "unknown_outcome", message: string) { super(message); this.name = "PayPalProviderError"; }
}

export class PayPalProvider implements PaymentProvider {
  private accessToken?: { value: string; expiresAt: number };
  constructor(private readonly config: EnabledPaymentConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) return this.accessToken.value;
    const auth = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const response = await this.fetchImpl(`${this.config.apiOrigin}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new PayPalProviderError("provider_error", "PayPal authentication failed");
    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new PayPalProviderError("invalid_response", "PayPal authentication response invalid");
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + Math.max(60, body.expires_in ?? 300) * 1000 };
    return body.access_token;
  }

  private async request(path: string, init: RequestInit, requestId?: string): Promise<Json> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.apiOrigin}${path}`, { ...init, headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json", Accept: "application/json", ...(requestId ? { "PayPal-Request-Id": requestId } : {}), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw new PayPalProviderError("unknown_outcome", "PayPal request timed out");
      throw new PayPalProviderError("provider_error", "PayPal request failed");
    }
    const body = await response.json().catch(() => ({})) as Json;
    if (!response.ok) throw new PayPalProviderError(response.status === 422 ? "declined" : "provider_error", `PayPal request rejected (${response.status})`);
    return body;
  }

  async createOrder(input: { amount: Money; requestId: string; internalOrderId: number }): Promise<ProviderOrder> {
    const body = await this.request("/v2/checkout/orders", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ reference_id: String(input.internalOrderId), amount: { currency_code: input.amount.currency, value: input.amount.value } }] }) }, input.requestId);
    const unit = (body.purchase_units as Array<Json> | undefined)?.[0]; const amount = unit?.amount as Json | undefined;
    if (typeof body.id !== "string" || typeof body.status !== "string" || typeof amount?.value !== "string" || typeof amount.currency_code !== "string") throw new PayPalProviderError("invalid_response", "PayPal order response invalid");
    const approvalUrl = (body.links as Array<Json> | undefined)?.find(link => link.rel === "payer-action" || link.rel === "approve")?.href;
    return { id: body.id, status: body.status, amount: { value: amount.value, currency: amount.currency_code }, approvalUrl: typeof approvalUrl === "string" ? approvalUrl : undefined };
  }
  async getOrder(id: string): Promise<ProviderOrder> {
    const body = await this.request(`/v2/checkout/orders/${encodeURIComponent(id)}`, { method: "GET" }); const unit = (body.purchase_units as Array<Json> | undefined)?.[0]; const amount = unit?.amount as Json | undefined;
    if (typeof body.id !== "string" || typeof body.status !== "string" || typeof amount?.value !== "string" || typeof amount.currency_code !== "string") throw new PayPalProviderError("invalid_response", "PayPal order response invalid");
    const rawCapture = (((unit?.payments as Json | undefined)?.captures as Array<Json> | undefined) ?? [])[0]; const captureAmount = rawCapture?.amount as Json | undefined;
    const capture = typeof rawCapture?.id === "string" && typeof rawCapture.status === "string" && typeof captureAmount?.value === "string" && typeof captureAmount.currency_code === "string" ? { orderId: body.id, captureId: rawCapture.id, status: rawCapture.status, amount: { value: captureAmount.value, currency: captureAmount.currency_code } } : undefined;
    return { id: body.id, status: body.status, amount: { value: amount.value, currency: amount.currency_code }, capture };
  }
  async captureOrder(id: string, requestId: string): Promise<ProviderCapture> {
    const body = await this.request(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, { method: "POST", headers: { Prefer: "return=representation" }, body: "{}" }, requestId); return this.parseCapture(body, id);
  }
  async getCapture(id: string): Promise<ProviderCapture> {
    const body = await this.request(`/v2/payments/captures/${encodeURIComponent(id)}`, { method: "GET" });
    const amount = body.amount as Json | undefined; const related = (body.supplementary_data as Json | undefined)?.related_ids as Json | undefined;
    if (typeof body.id !== "string" || typeof body.status !== "string" || typeof amount?.value !== "string" || typeof amount.currency_code !== "string" || typeof related?.order_id !== "string") throw new PayPalProviderError("invalid_response", "PayPal capture response invalid");
    return { orderId: related.order_id, captureId: body.id, status: body.status, amount: { value: amount.value, currency: amount.currency_code } };
  }
  private parseCapture(body: Json, orderId: string): ProviderCapture {
    const unit = (body.purchase_units as Array<Json> | undefined)?.[0]; const payments = unit?.payments as Json | undefined; const capture = (payments?.captures as Array<Json> | undefined)?.[0]; const amount = capture?.amount as Json | undefined;
    if (typeof capture?.id !== "string" || typeof capture.status !== "string" || typeof amount?.value !== "string" || typeof amount.currency_code !== "string") throw new PayPalProviderError("invalid_response", "PayPal capture response invalid");
    return { orderId, captureId: capture.id, status: capture.status, amount: { value: amount.value, currency: amount.currency_code } };
  }
  async refundCapture(id: string, amount: Money, requestId: string, note: string): Promise<ProviderRefund> {
    const body = await this.request(`/v2/payments/captures/${encodeURIComponent(id)}/refund`, { method: "POST", body: JSON.stringify({ amount: { value: amount.value, currency_code: amount.currency }, note_to_payer: note.slice(0, 255) }) }, requestId);
    const returned = body.amount as Json | undefined;
    if (typeof body.id !== "string" || typeof body.status !== "string" || typeof returned?.value !== "string" || typeof returned.currency_code !== "string") throw new PayPalProviderError("invalid_response", "PayPal refund response invalid");
    return { refundId: body.id, status: body.status, amount: { value: returned.value, currency: returned.currency_code } };
  }
  async verifyWebhook(headers: PayPalTransmissionHeaders, event: unknown): Promise<boolean> {
    const body = await this.request("/v1/notifications/verify-webhook-signature", { method: "POST", body: JSON.stringify({ auth_algo: headers.authAlgorithm, cert_url: headers.certificateUrl, transmission_id: headers.transmissionId, transmission_sig: headers.transmissionSignature, transmission_time: headers.transmissionTime, webhook_id: this.config.webhookId, webhook_event: event }) });
    return body.verification_status === "SUCCESS";
  }
}
