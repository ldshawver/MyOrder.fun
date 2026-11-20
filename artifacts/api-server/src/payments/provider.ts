import type { PaymentConfig } from "./config";

export type Money = { value: string; currency: string };
export type ProviderOrder = { id: string; status: string; amount: Money; approvalUrl?: string; capture?: ProviderCapture };
/** Provider-reported funding source. These values are evidence, never browser claims. */
export type ProviderFundingSource = "paypal" | "venmo" | "apple_pay" | "google_pay" | "credit" | "debit";
export type ProviderCapture = { orderId: string; captureId: string; status: string; amount: Money; fundingSource?: ProviderFundingSource };
// `amount` is optional because PayPal's minimal response is still a successful
// provider outcome.  The provider identity/status must be committed before any
// optional representation fields are inspected.
export type ProviderRefund = { refundId: string; status: string; amount?: Money };
export type PayPalTransmissionHeaders = { transmissionId: string; transmissionTime: string; transmissionSignature: string; certificateUrl: string; authAlgorithm: string };

export interface PaymentProvider {
  createOrder(input: { amount: Money; requestId: string; internalOrderId: number }): Promise<ProviderOrder>;
  getOrder(providerOrderId: string): Promise<ProviderOrder>;
  captureOrder(providerOrderId: string, requestId: string): Promise<ProviderCapture>;
  getCapture(providerCaptureId: string): Promise<ProviderCapture>;
  refundCapture(providerCaptureId: string, amount: Money, requestId: string, note: string): Promise<ProviderRefund>;
  verifyWebhook(headers: PayPalTransmissionHeaders, event: unknown): Promise<boolean>;
}

export type EnabledPaymentConfig = Extract<PaymentConfig, { enabled: true }>;
