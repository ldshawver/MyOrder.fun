import { describe, expect, it, vi } from "vitest";
import { catalogProductDraftIsValid, createCatalogProductPayload, createSingleFlightSubmit, sanitizedCatalogError, validateCatalogProductDraft } from "../catalogProductForm";
import { readFileSync } from "node:fs";

const valid = { name: "Staging Item", category: "Test", price: "1.00" };

describe("catalog product submission", () => {
  it("rejects invalid input with visible field errors", () => {
    expect(catalogProductDraftIsValid({ name: "", category: "", price: "0" })).toBe(false);
    expect(validateCatalogProductDraft({ name: "", category: "", price: "0" })).toEqual({
      name: "Product name is required.", category: "Category is required.", price: "Price must be greater than zero.",
    });
  });

  it("accepts required Alavont fields and maps them to canonical API fields", () => {
    const draft = { alavontName: " Staging Product ", alavontCategory: " Test ", price: "1.25", isAvailable: true };
    expect(catalogProductDraftIsValid(draft)).toBe(true);
    expect(createCatalogProductPayload(draft)).toEqual(expect.objectContaining({
      name: "Staging Product", category: "Test", alavontName: "Staging Product", alavontCategory: "Test", price: 1.25,
    }));
  });

  it("omits optional blank non-nullable fields from a minimal create request", () => {
    const payload = createCatalogProductPayload({ ...valid, description: " ", imageUrl: "", sku: "" });
    const requestBody = JSON.parse(JSON.stringify(payload));
    expect(requestBody).not.toHaveProperty("description");
    expect(requestBody).not.toHaveProperty("imageUrl");
    expect(requestBody).not.toHaveProperty("sku");
  });

  it("accepts blank image URLs but rejects invalid nonblank image URLs", () => {
    expect(validateCatalogProductDraft({ ...valid, imageUrl: "", alavontImageUrl: " " })).toEqual({});
    expect(validateCatalogProductDraft({ ...valid, imageUrl: "not-a-url" })).toEqual({
      imageUrl: "Image URL must be a valid HTTP or HTTPS URL.",
    });
    expect(validateCatalogProductDraft({ ...valid, alavontImageUrl: "ftp://example.test/image.png" })).toEqual({
      alavontImageUrl: "Image URL must be a valid HTTP or HTTPS URL.",
    });
  });

  it("valid input sends exactly one request despite rapid repeated clicks", async () => {
    const post = vi.fn(async () => ({ item: valid }));
    const submit = createSingleFlightSubmit(post);
    await Promise.all([submit(), submit(), submit()]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("surfaces a sanitized API failure while the caller retains its draft", async () => {
    const draft = { ...valid };
    expect(sanitizedCatalogError(new Error('{"error":"SKU already exists"}'))).toBe("SKU already exists");
    expect(draft).toEqual(valid);
  });

  it("does not expose non-JSON transport or credential-bearing failures", () => {
    expect(sanitizedCatalogError(new Error("upstream failed token=secret-value"))).toBe("Product could not be created. Please try again.");
    expect(sanitizedCatalogError(new Error('{"error":"Bad request Bearer secret-value"}'))).toBe("Bad request [redacted]");
  });

  it("returns the successfully created product", async () => {
    await expect(createSingleFlightSubmit(async () => ({ item: valid }))()).resolves.toEqual({ item: valid });
  });

  it("places the saved response in cache before one active refetch", () => {
    const source = readFileSync(new URL("../../pages/admin/edit-catalog.tsx", import.meta.url), "utf8");
    expect(source).toContain("qc.setQueryData<CatalogProduct[]>");
    expect(source).toContain('setSaveConfirmation(`Product ${saved.id} saved.`)');
    expect(source).toContain('refetchType: "active"');
    expect(source).not.toContain("await refetch();\n      setEditItem(null)");
  });
});
