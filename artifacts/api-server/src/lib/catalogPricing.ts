export type CatalogAmountPatch = {
  price?: number;
  compareAtPrice?: number | null;
  regularPrice?: number | null;
  homiePrice?: number | null;
  costBasis?: number | null;
};

/** Catalog write validation is server-owned; clients cannot persist unusable prices. */
export function catalogAmountError(amounts: CatalogAmountPatch): string | null {
  for (const field of ["price", "compareAtPrice", "regularPrice", "homiePrice"] as const) {
    const value = amounts[field];
    if (value != null && (!Number.isFinite(value) || value <= 0)) {
      return `${field} must be greater than zero`;
    }
  }
  if (amounts.costBasis != null && (!Number.isFinite(amounts.costBasis) || amounts.costBasis < 0)) {
    return "costBasis must be zero or greater";
  }
  return null;
}
