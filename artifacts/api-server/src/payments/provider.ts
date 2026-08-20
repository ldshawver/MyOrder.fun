import type { PaymentConfig } from "./config";

export type Money = { value: string; currency: string };
export type ProviderOrder = { id: string; status: string; amount: Money; approvalUrl?: string; capture?: ProviderCapture };
export type ProviderCapture = { orderId: string; captureId: string; status: string; amount: Money; fundingSource?: "paypal" | "card" };
export type ProviderRefund = { refundId: string; status: string; amount: Money };
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
