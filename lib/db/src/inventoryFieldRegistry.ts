export type InventoryFieldType = "text" | "number" | "boolean" | "url";
export type InventoryFieldAuthority = "product" | "inventory_balance" | "legacy";

export type InventoryFieldDefinition = {
  key: string;
  label: string;
  type: InventoryFieldType;
  authority: InventoryFieldAuthority;
  scope: "catalogue" | "non_catalog" | "location";
  editable: boolean;
  importable: boolean;
  exportable: boolean;
  clearable: boolean;
  protected?: boolean;
  aliases?: string[];
};

export const inventoryFieldRegistry: readonly InventoryFieldDefinition[] = [
  { key: "name", label: "Name", type: "text", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: false },
  { key: "category", label: "Category", type: "text", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: false },
  { key: "description", label: "Description", type: "text", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: true },
  { key: "price", label: "Price", type: "number", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: false },
  { key: "regularPrice", label: "Regular Price", type: "number", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: true },
  { key: "sku", label: "SKU", type: "text", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: true },
  { key: "imageUrl", label: "Image", type: "url", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: true },
  { key: "customerSafeName", label: "Customer Safe Name", type: "text", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: true },
  { key: "customerSafeDescription", label: "Customer Safe Description", type: "text", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: true },
  { key: "supplierName", label: "Supplier", type: "text", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: true },
  { key: "vendorSku", label: "Vendor SKU", type: "text", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: true },
  { key: "costBasis", label: "Cost", type: "number", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: true },
  { key: "isAvailable", label: "Available", type: "boolean", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: false },
  { key: "isTaxable", label: "Taxable", type: "boolean", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: false },
  { key: "parLevel", label: "PAR", type: "number", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: false, aliases: ["par", "par_level"] },
  { key: "moq", label: "Minimum Order Quantity", type: "number", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: false, aliases: ["minimum_order_quantity"] },
  { key: "preferredReorderQuantity", label: "Preferred Reorder Quantity", type: "number", authority: "product", scope: "catalogue", editable: true, importable: true, exportable: true, clearable: false, aliases: ["reorder_quantity"] },
  { key: "stockQuantity", label: "Legacy Stock", type: "number", authority: "legacy", scope: "catalogue", editable: false, importable: false, exportable: false, clearable: false, protected: true },
  { key: "currentStock", label: "Legacy Template Stock", type: "number", authority: "legacy", scope: "catalogue", editable: false, importable: false, exportable: false, clearable: false, protected: true },
];

export const importableInventoryFields = inventoryFieldRegistry.filter((field) => field.importable && !field.protected);
