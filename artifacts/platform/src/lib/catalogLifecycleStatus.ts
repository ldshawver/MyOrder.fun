export type CatalogLifecycleStatus = "customer_visible" | "unavailable_hidden" | "compliance_hold" | "archived";

export const CATALOG_LIFECYCLE_LABEL: Record<CatalogLifecycleStatus, string> = {
  customer_visible: "Customer Visible",
  unavailable_hidden: "Unavailable / Hidden",
  compliance_hold: "Compliance Hold",
  archived: "Archived",
};
