/**
 * The catalogue field registry is deliberately data-only so server-side import
 * and export consumers can share one allow-list.  It is not a database schema:
 * tenant, routing, audit, price-calculation, and movement-ledger fields remain
 * outside this list.
 */
export type InventoryFieldType = "text" | "number" | "boolean" | "url" | "string_list" | "json";
export type InventoryFieldAuthority = "product" | "inventory_balance" | "legacy";
export type CatalogueFieldClassification = "merchant_editable" | "server_managed" | "internal" | "derived" | "inventory_transactional";
export type ImportBlankBehavior = "preserve" | "clear_with_token" | "reject";

export type InventoryFieldDefinition = {
  /** Stable field key used by API payloads and import normalization. */
  key: string;
  label: string;
  /** Canonical CSV/template header. */
  header: string;
  apiField?: string;
  dbField?: string;
  type: InventoryFieldType;
  authority: InventoryFieldAuthority;
  classification: CatalogueFieldClassification;
  scope: "catalogue" | "non_catalog" | "location";
  editable: boolean;
  importable: boolean;
  exportable: boolean;
  inventoryVisible: boolean;
  required?: boolean;
  nullable: boolean;
  clearable: boolean;
  blankImportBehavior: ImportBlankBehavior;
  description: string;
  sampleValue?: string;
  options?: readonly string[];
  protected?: boolean;
  aliases?: readonly string[];
};

const product = (field: Omit<InventoryFieldDefinition, "authority" | "scope" | "classification">): InventoryFieldDefinition => ({
  authority: "product", scope: "catalogue", classification: "merchant_editable", ...field,
});
const internal = (field: Omit<InventoryFieldDefinition, "authority" | "scope" | "classification" | "editable" | "importable" | "exportable" | "inventoryVisible" | "nullable" | "clearable" | "blankImportBehavior">): InventoryFieldDefinition => ({
  authority: "product", scope: "catalogue", classification: "internal", editable: false, importable: false, exportable: false,
  inventoryVisible: false, nullable: true, clearable: false, blankImportBehavior: "preserve", protected: true, ...field,
});

/**
 * The sole registry for merchant-managed catalogue configuration.  `Product ID`
 * is a round-trip identity column only; it is never an editable database field.
 */
export const inventoryFieldRegistry: readonly InventoryFieldDefinition[] = [
  { key: "productId", label: "Product ID", header: "Product ID", dbField: "id", type: "number", authority: "product", classification: "server_managed", scope: "catalogue", editable: false, importable: true, exportable: true, inventoryVisible: true, nullable: false, clearable: false, blankImportBehavior: "preserve", description: "Stable exported product reference used to match an existing product; never editable.", sampleValue: "123", aliases: ["product_id", "id"] },
  product({ key: "sku", label: "SKU", header: "SKU", apiField: "sku", dbField: "sku", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: true, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Merchant SKU. Used as the fallback match when Product ID is not supplied.", sampleValue: "SKU-001", aliases: ["alavont sku", "alavont_id", "merchant_sku"] }),
  product({ key: "name", label: "Product Name", header: "Product Name", apiField: "name", dbField: "name", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: true, required: true, nullable: false, clearable: false, blankImportBehavior: "reject", description: "Internal product name.", sampleValue: "Sample Product", aliases: ["base name", "name"] }),
  product({ key: "category", label: "Category", header: "Category", apiField: "category", dbField: "category", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: true, required: true, nullable: false, clearable: false, blankImportBehavior: "reject", description: "Internal product category.", sampleValue: "Wellness", aliases: ["base category"] }),
  product({ key: "description", label: "Description", header: "Description", apiField: "description", dbField: "description", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Internal product description.", sampleValue: "Sample description", aliases: ["base description"] }),
  product({ key: "imageUrl", label: "Image URL", header: "Image URL", apiField: "imageUrl", dbField: "imageUrl", type: "url", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "HTTP(S) product image.", sampleValue: "https://example.com/product.jpg", aliases: ["base image", "image", "image_url"] }),
  product({ key: "price", label: "Price", header: "Price", apiField: "price", dbField: "price", type: "number", editable: true, importable: true, exportable: true, inventoryVisible: false, required: true, nullable: false, clearable: false, blankImportBehavior: "reject", description: "Current catalogue price. The server remains authoritative at checkout.", sampleValue: "29.99", aliases: ["regular price"] }),
  product({ key: "regularPrice", label: "Regular Price", header: "Regular Price", apiField: "regularPrice", dbField: "regularPrice", type: "number", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Reference/regular price, if used.", sampleValue: "34.99", aliases: ["regular_price"] }),
  product({ key: "compareAtPrice", label: "Sale Price", header: "Sale Price", apiField: "compareAtPrice", dbField: "compareAtPrice", type: "number", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Configured sale price. Effective transaction pricing is server-authoritative.", sampleValue: "24.99", aliases: ["compare_at_price", "sale_price"] }),
  product({ key: "homiePrice", label: "Employee Discount", header: "Employee Discount", apiField: "homiePrice", dbField: "homiePrice", type: "number", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Employee discount price. Eligibility and effective price are determined server-side.", sampleValue: "22.99", aliases: ["homie price", "homie_price", "homieprice", "employee_discount"] }),
  product({ key: "isAvailable", label: "Available for Ordering", header: "Available for Ordering", apiField: "isAvailable", dbField: "isAvailable", type: "boolean", editable: true, importable: true, exportable: true, inventoryVisible: true, nullable: false, clearable: false, blankImportBehavior: "preserve", description: "Whether the product can be ordered.", sampleValue: "true", aliases: ["available", "is_available"] }),
  product({ key: "isTaxable", label: "Taxable", header: "Taxable", apiField: "isTaxable", dbField: "isTaxable", type: "boolean", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: false, clearable: false, blankImportBehavior: "preserve", description: "Whether tax applies at the transaction location.", sampleValue: "true", aliases: ["is_taxable"] }),
  product({ key: "isFeatured", label: "Featured", header: "Featured", apiField: "isFeatured", dbField: "isFeatured", type: "boolean", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: false, clearable: false, blankImportBehavior: "preserve", description: "Merchandising priority only; it does not enable a sale or change stock.", sampleValue: "false" }),
  product({ key: "isSaleFeatured", label: "Sale", header: "Sale", apiField: "isSaleFeatured", dbField: "isSaleFeatured", type: "boolean", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: false, clearable: false, blankImportBehavior: "preserve", description: "Sale marker only; it does not make a product featured.", sampleValue: "false", aliases: ["active sale", "sale", "is_sale_featured"] }),
  product({ key: "alavontName", label: "Catalogue Name", header: "Catalogue Name", apiField: "alavontName", dbField: "alavontName", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Catalogue presentation name.", sampleValue: "Sample Product", aliases: ["alavont name"] }),
  product({ key: "alavontCategory", label: "Catalogue Category", header: "Catalogue Category", apiField: "alavontCategory", dbField: "alavontCategory", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Catalogue presentation category.", sampleValue: "Wellness", aliases: ["alavont category"] }),
  product({ key: "alavontDescription", label: "Catalogue Description", header: "Catalogue Description", apiField: "alavontDescription", dbField: "alavontDescription", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Catalogue presentation description.", sampleValue: "Customer description", aliases: ["alavont description"] }),
  product({ key: "alavontImageUrl", label: "Catalogue Image URL", header: "Catalogue Image URL", apiField: "alavontImageUrl", dbField: "alavontImageUrl", type: "url", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "HTTP(S) catalogue image.", sampleValue: "https://example.com/catalogue.jpg", aliases: ["alavont image"] }),
  product({ key: "alavontInStock", label: "Catalogue In Stock", header: "Catalogue In Stock", apiField: "alavontInStock", dbField: "alavontInStock", type: "boolean", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: false, clearable: false, blankImportBehavior: "preserve", description: "Catalogue stock visibility indicator; it does not mutate the inventory ledger.", sampleValue: "true", aliases: ["alavont in stock"] }),
  product({ key: "customerSafeName", label: "Customer-Safe Name", header: "Customer-Safe Name", apiField: "customerSafeName", dbField: "customerSafeName", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: true, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Customer-safe checkout name.", sampleValue: "Safe Sample", aliases: ["safe name"] }),
  product({ key: "customerSafeDescription", label: "Customer-Safe Description", header: "Customer-Safe Description", apiField: "customerSafeDescription", dbField: "customerSafeDescription", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Customer-safe checkout description.", sampleValue: "Safe description", aliases: ["safe description"] }),
  product({ key: "luciferCruzName", label: "Merchant Name", header: "Merchant Name", apiField: "luciferCruzName", dbField: "luciferCruzName", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Mapped merchant presentation name.", sampleValue: "Merchant Sample", aliases: ["lucifer cruz name"] }),
  product({ key: "luciferCruzCategory", label: "Merchant Category", header: "Merchant Category", apiField: "luciferCruzCategory", dbField: "luciferCruzCategory", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Mapped merchant category.", sampleValue: "Safe Wellness", aliases: ["safe category", "lucifer cruz category"] }),
  product({ key: "luciferCruzDescription", label: "Merchant Description", header: "Merchant Description", apiField: "luciferCruzDescription", dbField: "luciferCruzDescription", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Mapped merchant description.", sampleValue: "Merchant-safe description", aliases: ["lucifer cruz description"] }),
  product({ key: "luciferCruzImageUrl", label: "Merchant Image URL", header: "Merchant Image URL", apiField: "luciferCruzImageUrl", dbField: "luciferCruzImageUrl", type: "url", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "HTTP(S) mapped merchant image.", sampleValue: "https://example.com/merchant.jpg", aliases: ["safe image", "lucifer cruz image"] }),
  product({ key: "displayName", label: "Display Name", header: "Display Name", apiField: "displayName", dbField: "displayName", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Optional customer display override." }),
  product({ key: "displayCategory", label: "Display Category", header: "Display Category", apiField: "displayCategory", dbField: "displayCategory", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Optional customer display category override." }),
  product({ key: "displayDescription", label: "Display Description", header: "Display Description", apiField: "displayDescription", dbField: "displayDescription", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Optional customer display description override." }),
  product({ key: "displayImage", label: "Display Image URL", header: "Display Image URL", apiField: "displayImage", dbField: "displayImage", type: "url", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Optional HTTP(S) customer display image override." }),
  product({ key: "marketingCopy", label: "Marketing Copy", header: "Marketing Copy", apiField: "marketingCopy", dbField: "marketingCopy", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Optional marketing copy." }),
  product({ key: "upsellCopy", label: "Upsell Copy", header: "Upsell Copy", apiField: "upsellCopy", dbField: "upsellCopy", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Optional upsell copy." }),
  product({ key: "promoBadges", label: "Promo Badges", header: "Promo Badges", apiField: "promoBadges", dbField: "promoBadges", type: "string_list", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: false, clearable: true, blankImportBehavior: "clear_with_token", description: "Comma-separated promotional badges.", sampleValue: "New, Staff pick" }),
  product({ key: "mediaGallery", label: "Media Gallery JSON", header: "Media Gallery JSON", apiField: "mediaGallery", dbField: "mediaGallery", type: "json", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: false, clearable: true, blankImportBehavior: "clear_with_token", description: "JSON array of approved image/video media entries.", sampleValue: "[]" }),
  product({ key: "labName", label: "Lab Name", header: "Lab Name", apiField: "labName", dbField: "labName", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Internal lab/operations label." }),
  product({ key: "receiptName", label: "Receipt Name", header: "Receipt Name", apiField: "receiptName", dbField: "receiptName", type: "text", editable: true, importable: true, exportable: true, inventoryVisible: false, nullable: true, clearable: true, blankImportBehavior: "clear_with_token", description: "Configured receipt label." }),
  product({ key: "parLevel", label: "PAR", header: "PAR", apiField: "parLevel", dbField: "parLevel", type: "number", editable: true, importable: true, exportable: true, inventoryVisible: true, nullable: false, clearable: false, blankImportBehavior: "preserve", description: "Desired catalogue stock level; must be non-negative.", sampleValue: "10", aliases: ["par", "par_level"] }),
  product({ key: "moq", label: "Minimum Order Quantity", header: "Minimum Order Quantity", apiField: "moq", dbField: "moq", type: "number", editable: true, importable: true, exportable: true, inventoryVisible: true, nullable: false, clearable: false, blankImportBehavior: "preserve", description: "Minimum order quantity; must be non-negative.", sampleValue: "5", aliases: ["moq", "minimum_order_quantity"] }),
  product({ key: "preferredReorderQuantity", label: "Preferred Reorder Quantity", header: "Preferred Reorder Quantity", apiField: "preferredReorderQuantity", dbField: "preferredReorderQuantity", type: "number", editable: true, importable: true, exportable: true, inventoryVisible: true, nullable: false, clearable: false, blankImportBehavior: "preserve", description: "Preferred reorder quantity; must be non-negative.", sampleValue: "20", aliases: ["reorder_quantity", "preferred_reorder_quantity"] }),

  // Explicit exclusions: only catalogue configuration above is lifecycle-managed.
  internal({ key: "costBasis", label: "Cost Basis", header: "Cost Basis", dbField: "costBasis", type: "number", description: "Historical cost/COGS; not a merchant catalogue field." }),
  internal({ key: "supplierName", label: "Supplier", header: "Supplier", dbField: "supplierName", type: "text", description: "Supplier reconciliation data; not catalogue-editable." }),
  internal({ key: "vendorSku", label: "Vendor SKU", header: "Vendor SKU", dbField: "vendorSku", type: "text", description: "Supplier reconciliation data; not catalogue-editable." }),
  { key: "stockQuantity", label: "Legacy Stock", header: "Legacy Stock", type: "number", authority: "legacy", classification: "inventory_transactional", scope: "catalogue", editable: false, importable: false, exportable: false, inventoryVisible: false, nullable: false, clearable: false, blankImportBehavior: "preserve", protected: true, description: "Legacy projection. Inventory changes must use the ledger." },
  { key: "currentStock", label: "Legacy Template Stock", header: "Legacy Template Stock", type: "number", authority: "legacy", classification: "inventory_transactional", scope: "catalogue", editable: false, importable: false, exportable: false, inventoryVisible: false, nullable: false, clearable: false, blankImportBehavior: "preserve", protected: true, description: "Legacy template projection. Inventory changes must use the ledger." },
];

export const merchantEditableCatalogueFields = inventoryFieldRegistry.filter(field => field.scope === "catalogue" && field.classification === "merchant_editable");
export const importableCatalogueFields = inventoryFieldRegistry.filter(field => field.scope === "catalogue" && field.importable && !field.protected);
export const exportableCatalogueFields = inventoryFieldRegistry.filter(field => field.scope === "catalogue" && field.exportable && !field.protected);
export const inventoryVisibleCatalogueFields = merchantEditableCatalogueFields.filter(field => field.inventoryVisible);
/** Compatibility export retained for existing inventory callers. */
export const importableInventoryFields = importableCatalogueFields;
