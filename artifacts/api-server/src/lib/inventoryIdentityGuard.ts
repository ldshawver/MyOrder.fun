import { logger } from "./logger";

const STRICT_IDENTITY_ENVS = new Set(["development", "staging", "test"]);

export function assertCatalogIdInventoryLookup(catalogItemId: unknown, lookupSource: string): asserts catalogItemId is number {
  const ok = typeof catalogItemId === "number" && Number.isInteger(catalogItemId) && catalogItemId > 0;
  if (ok) return;

  const err = new Error(`Forbidden inventory lookup identity from ${lookupSource}: inventory lookups must use catalog_items.id only`);
  logger.error({ event: "inventory_identity_violation", lookupSource, catalogItemId, stack: err.stack }, err.message);
  if (STRICT_IDENTITY_ENVS.has(process.env.NODE_ENV ?? "development")) throw err;
}
