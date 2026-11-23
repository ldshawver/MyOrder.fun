import type { NormalizedCartLine } from "./checkoutNormalizer";

export type CheckoutFulfillmentProvider = "alavont" | "lucifer_direct" | "cj";
export type CheckoutFulfillmentMethod = "pickup" | "uber_direct" | "csr_delivery" | "standard_shipping";

export interface CheckoutFulfillmentGroupPlan {
  key: string;
  provider: CheckoutFulfillmentProvider;
  method: CheckoutFulfillmentMethod;
  lineIndexes: number[];
}

/**
 * Derive checkout partitions exclusively from server-normalized catalog data.
 * CJ/Woo lines are always customer-free standard shipping; the selected local
 * method applies only to Alavont and Lucifer Direct inventory.
 */
export function planCheckoutFulfillmentGroups(
  lines: NormalizedCartLine[],
  selectedLocalMethod: Exclude<CheckoutFulfillmentMethod, "standard_shipping">,
): CheckoutFulfillmentGroupPlan[] {
  const groups = new Map<string, CheckoutFulfillmentGroupPlan>();
  for (const [lineIndex, line] of lines.entries()) {
    const provider: CheckoutFulfillmentProvider = line.source_type === "woo"
      ? "cj"
      : line.merchant_brand === "alavont" ? "alavont" : "lucifer_direct";
    const method: CheckoutFulfillmentMethod = provider === "cj" ? "standard_shipping" : selectedLocalMethod;
    const key = `${provider}:${method}`;
    const group = groups.get(key) ?? { key, provider, method, lineIndexes: [] };
    group.lineIndexes.push(lineIndex);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function checkoutGroupsAllowCash(groups: CheckoutFulfillmentGroupPlan[]): boolean {
  return groups.every(group => group.method === "pickup");
}
