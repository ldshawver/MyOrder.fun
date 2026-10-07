export type WooVariationAttribute = { name?: string; option?: string };

/** Normalize Woo's variation attributes into the stable option-value map we persist on catalogue_options. */
export function wooVariationOptionValues(attributes: WooVariationAttribute[] | undefined, variationId: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const attribute of attributes ?? []) {
    const name = attribute.name?.trim();
    const value = attribute.option?.trim();
    if (!name || !value) continue;
    if (Object.hasOwn(values, name)) throw new Error("Woo variation contains duplicate option names");
    values[name] = value;
  }
  if (!Object.keys(values).length) values.Variation = variationId;
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
}

export function wooVariationLabel(values: Record<string, string>): string {
  return Object.entries(values).map(([name, value]) => `${name}: ${value}`).join(" / ");
}

/**
 * Keep a Woo variable parent's compliance hold attached to newly imported
 * variations without losing an independently held variation on parent release.
 * A newly created variation inherits publication metadata, but not the parent's
 * compliance bookkeeping as if it were its own independent hold.
 */
export function wooVariationMetadata(
  parentMetadata: Record<string, unknown>,
  currentMetadata: Record<string, unknown> | null,
  parentCatalogItemId: number,
): Record<string, unknown> {
  const metadata = currentMetadata ? { ...currentMetadata } : { ...parentMetadata };
  if (!currentMetadata) {
    delete metadata.complianceHold;
    delete metadata.complianceReason;
    delete metadata.complianceMatchedTerms;
    delete metadata.complianceProductHoldParentId;
    delete metadata.complianceProductHoldPrevious;
  }

  const parentIsHeld = parentMetadata.complianceHold === true;
  const heldByParent = Number(metadata.complianceProductHoldParentId) === parentCatalogItemId;
  if (parentIsHeld) {
    if (!heldByParent) {
      metadata.complianceProductHoldPrevious = {
        complianceHold: metadata.complianceHold === true,
        complianceReason: metadata.complianceReason ?? null,
        complianceMatchedTerms: metadata.complianceMatchedTerms ?? [],
      };
    }
    metadata.complianceProductHoldParentId = parentCatalogItemId;
    metadata.complianceHold = true;
    metadata.complianceReason = parentMetadata.complianceReason ?? "Held on parent product";
    metadata.complianceMatchedTerms = parentMetadata.complianceMatchedTerms ?? [];
  } else if (heldByParent) {
    const previous = metadata.complianceProductHoldPrevious && typeof metadata.complianceProductHoldPrevious === "object"
      ? metadata.complianceProductHoldPrevious as Record<string, unknown> : {};
    metadata.complianceHold = previous.complianceHold === true;
    metadata.complianceReason = previous.complianceHold === true ? previous.complianceReason ?? null : null;
    metadata.complianceMatchedTerms = previous.complianceHold === true ? previous.complianceMatchedTerms ?? [] : [];
    delete metadata.complianceProductHoldParentId;
    delete metadata.complianceProductHoldPrevious;
  }
  return metadata;
}
