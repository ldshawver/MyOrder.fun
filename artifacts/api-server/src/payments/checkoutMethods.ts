export type CheckoutPaymentMethod = {
  id: "cash" | "paypal" | "customer_credit";
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
    { id: "customer_credit" as const, label: "Customer Credit", promoted: false },
  ];
}
