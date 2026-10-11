import { quantityText, quantityUnits } from "./exactQuantity";

export type LocationPolicyInput = {
  locationId: number;
  name: string;
  available: string;
  par: string;
  reorderPoint: string;
  preferredReorderQuantity: string;
  moq: string;
  eligible: boolean;
};

export type ReplenishmentRecommendation = {
  locationId: number;
  locationName: string;
  available: string;
  internalTransfers: Array<{ fromLocationId: number; quantity: string }>;
  externalPurchaseQuantity: string;
};

/** Plan transfers first. Balances are never combined or mutated here. */
export function recommendReplenishment(locations: LocationPolicyInput[], mode: "PER_LOCATION" | "COMBINED_LOCATIONS" = "PER_LOCATION", preferredLocationId?: number | null): ReplenishmentRecommendation[] {
  const eligible = locations.filter(location => location.eligible);
  if (mode === "COMBINED_LOCATIONS") {
    if (!eligible.length) return [];
    const total = (key: "available" | "par" | "reorderPoint" | "preferredReorderQuantity" | "moq") => eligible.reduce((sum, location) => sum + quantityUnits(location[key]), 0n);
    const available = total("available");
    const par = total("par");
    const point = total("reorderPoint");
    let external = 0n;
    if (available <= point) {
      const deficit = par > available ? par - available : 0n;
      external = total("preferredReorderQuantity");
      if (external < deficit) external = deficit;
      const moq = total("moq");
      if (external < moq) external = moq;
    }
    const destination = eligible.find(location => location.locationId === preferredLocationId) ?? eligible[0];
    return [{ locationId: destination.locationId, locationName: destination.name, available: quantityText(available), internalTransfers: [], externalPurchaseQuantity: quantityText(external) }];
  }
  const surplus = new Map(eligible.map(location => [location.locationId,
    quantityUnits(location.available) > quantityUnits(location.par)
      ? quantityUnits(location.available) - quantityUnits(location.par) : 0n]));
  return eligible.map(location => {
    const available = quantityUnits(location.available);
    const par = quantityUnits(location.par);
    const point = quantityUnits(location.reorderPoint);
    const transfers: ReplenishmentRecommendation["internalTransfers"] = [];
    let deficit = available < par ? par - available : 0n;
    if (available <= point && deficit > 0n) {
      for (const source of eligible) {
        if (source.locationId === location.locationId || deficit === 0n) continue;
        const excess = surplus.get(source.locationId) ?? 0n;
        const transfer = excess < deficit ? excess : deficit;
        if (transfer <= 0n) continue;
        transfers.push({ fromLocationId: source.locationId, quantity: quantityText(transfer) });
        surplus.set(source.locationId, excess - transfer);
        deficit -= transfer;
      }
    }
    let external = 0n;
    if (available <= point && deficit > 0n) {
      const preferred = quantityUnits(location.preferredReorderQuantity);
      const moq = quantityUnits(location.moq);
      external = preferred > deficit ? preferred : deficit;
      if (external < moq) external = moq;
    }
    return {
      locationId: location.locationId,
      locationName: location.name,
      available: quantityText(available),
      internalTransfers: transfers,
      externalPurchaseQuantity: quantityText(external),
    };
  });
}
