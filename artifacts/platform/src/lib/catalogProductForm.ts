export type CatalogProductDraft = Record<string, string | boolean | number>;
export type CatalogProductFieldErrors = Partial<Record<"name" | "category" | "price" | "imageUrl" | "alavontImageUrl" | "luciferCruzImageUrl", string>>;

function canonicalText(form: CatalogProductDraft, primary: string, fallback: string): string {
  return String(form[primary] || form[fallback] || "").trim();
}

function optionalText(form: CatalogProductDraft, key: string): string | undefined {
  return String(form[key] || "").trim() || undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateCatalogProductDraft(form: CatalogProductDraft): CatalogProductFieldErrors {
  const errors: CatalogProductFieldErrors = {};
  if (!canonicalText(form, "name", "alavontName")) errors.name = "Product name is required.";
  if (!canonicalText(form, "category", "alavontCategory")) errors.category = "Category is required.";
  const price = Number(form.price);
  if (!Number.isFinite(price) || price <= 0) errors.price = "Price must be greater than zero.";
  for (const key of ["imageUrl", "alavontImageUrl", "luciferCruzImageUrl"] as const) {
    const value = optionalText(form, key);
    if (value && !isHttpUrl(value)) errors[key] = "Image URL must be a valid HTTP or HTTPS URL.";
  }
  return errors;
}

export function createCatalogProductPayload(form: CatalogProductDraft): Record<string, unknown> {
  return {
    name: canonicalText(form, "name", "alavontName"),
    alavontName: String(form.alavontName || "").trim() || null,
    luciferCruzName: String(form.luciferCruzName || "").trim() || null,
    luciferCruzCategory: String(form.luciferCruzCategory || "").trim() || null,
    luciferCruzDescription: String(form.luciferCruzDescription || "").trim() || null,
    luciferCruzImageUrl: String(form.luciferCruzImageUrl || "").trim() || null,
    customerSafeName: String(form.customerSafeName || "").trim() || null,
    customerSafeDescription: String(form.customerSafeDescription || "").trim() || null,
    category: canonicalText(form, "category", "alavontCategory"),
    alavontCategory: String(form.alavontCategory || "").trim() || null,
    description: optionalText(form, "description"),
    alavontDescription: String(form.alavontDescription || "").trim() || null,
    price: Number(form.price),
    regularPrice: form.regularPrice ? Number(form.regularPrice) : null,
    imageUrl: optionalText(form, "imageUrl"),
    alavontImageUrl: String(form.alavontImageUrl || "").trim() || null,
    labName: String(form.labName || "").trim() || null,
    sku: optionalText(form, "sku"),
    isAvailable: form.isAvailable !== false,
  };
}

export function catalogProductDraftIsValid(form: CatalogProductDraft): boolean {
  return Object.keys(validateCatalogProductDraft(form)).length === 0;
}

export function sanitizedCatalogError(error: unknown): string {
  const fallback = "Product could not be created. Please try again.";
  const message = error instanceof Error ? error.message : fallback;
  try {
    const parsed = JSON.parse(message) as { error?: string };
    if (typeof parsed.error !== "string") return fallback;
    return [...parsed.error]
      .map(char => {
        const code = char.charCodeAt(0);
        return code < 32 || code === 127 ? " " : char;
      })
      .join("")
      .replace(/Bearer\s+\S+|token[=:]\s*\S+/gi, "[redacted]")
      .trim()
      .slice(0, 300) || fallback;
  } catch {
    return fallback;
  }
}

export function createSingleFlightSubmit<T>(submit: () => Promise<T>) {
  let pending: Promise<T> | null = null;
  return () => pending ?? (pending = submit().finally(() => { pending = null; }));
}
