import type { NormalizedCartLine } from "./checkoutNormalizer";

export type CheckoutFulfillmentProvider = "alavont" | "lucifer_direct" | "cj";
export type CheckoutFulfillmentMethod = "pickup" | "uber_direct" | "csr_delivery" | "carrier" | "standard_shipping";

export interface CheckoutFulfillmentGroupPlan {
  key: string;
  provider: CheckoutFulfillmentProvider;
  method: CheckoutFulfillmentMethod;
  lineIndexes: number[];
}

export type CheckoutFulfillmentDestination =
  | { type: "pickup"; locationId: number; pickupAt: string }
  | { type: "customer_address"; address: string };

export interface CheckoutFulfillmentGroupChoice {
  key: string;
  provider: CheckoutFulfillmentProvider;
  method: CheckoutFulfillmentMethod;
  destination: CheckoutFulfillmentDestination;
}

/**
 * Derive checkout partitions exclusively from server-normalized catalog data.
 * CJ/Woo lines are always customer-free standard shipping; the selected local
 * method applies only to Alavont and Lucifer Direct inventory.
 */
export function planCheckoutFulfillmentGroups(
  lines: NormalizedCartLine[],
  selectedLocalMethod: Exclude<CheckoutFulfillmentMethod, "standard_shipping" | "carrier">,
  luciferDirectMethod: Exclude<CheckoutFulfillmentMethod, "standard_shipping"> = selectedLocalMethod,
): CheckoutFulfillmentGroupPlan[] {
  const groups = new Map<string, CheckoutFulfillmentGroupPlan>();
  for (const [lineIndex, line] of lines.entries()) {
    const provider: CheckoutFulfillmentProvider = line.source_type === "woo"
      ? "cj"
      : line.merchant_brand === "alavont" ? "alavont" : "lucifer_direct";
    const method: CheckoutFulfillmentMethod = provider === "cj"
      ? "standard_shipping"
      : provider === "lucifer_direct" ? luciferDirectMethod : selectedLocalMethod;
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

/** Select only the server-derived Lucifer Direct lines eligible for carrier rating. */
export function luciferDirectCarrierLines(lines: NormalizedCartLine[]): NormalizedCartLine[] {
  const plan = planCheckoutFulfillmentGroups(lines, "pickup")
    .find(group => group.provider === "lucifer_direct");
  if (!plan) throw new Error("CARRIER_GROUP_UNAVAILABLE");
  return plan.lineIndexes.map(index => lines[index]!);
}

/** Build the immutable customer-visible choice bound into a checkout quote. */
export function snapshotCheckoutFulfillmentGroups(
  groups: CheckoutFulfillmentGroupPlan[],
  input: { pickup: { locationId: number; pickupAt: string } | null; shippingAddress?: string | null },
): CheckoutFulfillmentGroupChoice[] {
  return groups.map(group => ({
    key: group.key,
    provider: group.provider,
    method: group.method,
    destination: group.method === "pickup"
      ? { type: "pickup", locationId: input.pickup!.locationId, pickupAt: input.pickup!.pickupAt }
      : { type: "customer_address", address: input.shippingAddress!.trim() },
  }));
}
