export type CheckoutPaymentMethod = {
  id: "cash" | "paypal" | "customer_credit" | "split_tender";
  label: string;
  promoted?: boolean;
  available?: boolean;
  message?: string;
};

export function checkoutPaymentMethods(enabledProcessors: readonly string[], paypalConfigured: boolean): CheckoutPaymentMethod[] {
  const enabled = new Set(enabledProcessors);
  return [
    ...(enabled.has("cash") ? [{ id: "cash" as const, label: "Cash", promoted: true, message: "Cash is accepted by an eligible employee in an open accountable session." }] : []),
    ...(enabled.has("paypal") ? [{
      id: "paypal" as const,
      label: "PayPal",
      promoted: false,
      available: paypalConfigured,
      ...(!paypalConfigured ? { message: "PayPal is unavailable until live payment configuration is completed." } : {}),
    }] : []),
    ...(enabled.has("cash") && enabled.has("paypal") && paypalConfigured ? [{
      id: "split_tender" as const,
      label: "Cash + Card",
      promoted: false,
      available: true,
      message: "Pay in separate cash and PayPal card payments. The remaining balance stays due until both are settled.",
    }] : []),
    { id: "customer_credit" as const, label: "Customer Credit", promoted: false },
  ];
}
