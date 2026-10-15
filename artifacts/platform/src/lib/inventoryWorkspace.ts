const inventoryPaths = [
  "/api/admin/inventory",
  "/api/admin/non-catalog/sections",
  "/api/admin/non-catalog/items",
  "/api/admin/non-catalog/balances",
] as const;

/** Load all panels as one snapshot. A failed request rejects the whole load so
 * callers cannot render authorization/server errors as a successful empty list. */
export async function loadInventoryWorkspace<T>(request: (path: string) => Promise<T>): Promise<{
  catalogue: T;
  sections: T;
  items: T;
  balances: T;
}> {
  const [catalogue, sections, items, balances] = await Promise.all(inventoryPaths.map(request));
  return { catalogue, sections, items, balances };
}

export function catalogueItemsAtLocation<T extends { locations?: Array<{ locationId: number }> }>(items: T[], locationId: number | null): T[] {
  if (locationId === null) return items;
  return items.filter(item => item.locations?.some(location => location.locationId === locationId));
}
