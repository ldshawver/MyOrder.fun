/**
 * documentTypes.ts — the printable document types MyOrder supports, the
 * printer class each one needs, and how existing print_jobs.job_output
 * values map onto them. Routes (print_routes.job_type) store the document
 * type code, e.g. "ORDER_RECEIPT".
 */

export const PRINTER_CLASSES = ["thermal", "full_page"] as const;
export type PrinterClass = (typeof PRINTER_CLASSES)[number];

/** Thermal roll widths MyOrder supports. */
export const THERMAL_WIDTHS = ["50mm", "80mm"] as const;
export type ThermalWidth = (typeof THERMAL_WIDTHS)[number];
/** Stored paper width for full-page printers. */
export const FULL_PAGE_SIZE = "letter";

export const PRINT_DOCUMENT_TYPES = [
  "ORDER_RECEIPT", "CLOCK_IN", "CLOCK_OUT", "INVENTORY_STOCK_LIST", "DEPOSIT", "EXPO", "WORK", "REPORT",
] as const;
export type PrintDocumentType = (typeof PRINT_DOCUMENT_TYPES)[number];

export interface DocumentTypeInfo {
  readonly label: string;
  readonly printerClass: PrinterClass;
  /** print_jobs.job_output values that belong to this document type. */
  readonly jobTypes: readonly string[];
  readonly description: string;
}

export const DOCUMENT_TYPES: Readonly<Record<PrintDocumentType, DocumentTypeInfo>> = {
  ORDER_RECEIPT: {
    label: "Order receipt", printerClass: "thermal",
    jobTypes: ["customer_receipt", "receipt", "receipt_template_test"],
    description: "Customer receipt for an order",
  },
  CLOCK_IN: { label: "Clock in", printerClass: "thermal", jobTypes: ["shift_clock_in"], description: "Slip when a shift starts" },
  CLOCK_OUT: { label: "Clock out", printerClass: "thermal", jobTypes: ["shift_clock_out"], description: "Slip when a shift ends" },
  DEPOSIT: { label: "Deposit", printerClass: "thermal", jobTypes: ["shift_deposit"], description: "Cash deposit slip at shift end" },
  EXPO: { label: "Expo ticket", printerClass: "thermal", jobTypes: ["expo_ticket"], description: "Order ticket for the pass/expo station" },
  WORK: { label: "Work ticket", printerClass: "thermal", jobTypes: ["order_ticket"], description: "Preparation/fulfillment ticket for an order" },
  INVENTORY_STOCK_LIST: {
    label: "Inventory stock list", printerClass: "full_page",
    jobTypes: ["shift_beginning_inventory", "shift_ending_inventory", "shift_restock", "inventory_stock_list"],
    description: "Full-page stock, count and restock lists",
  },
  REPORT: {
    label: "Report", printerClass: "full_page",
    jobTypes: ["shift_sales", "shift_commission", "report"],
    description: "Full-page shift and business reports",
  },
};

export function isPrintDocumentType(value: unknown): value is PrintDocumentType {
  return typeof value === "string" && (PRINT_DOCUMENT_TYPES as readonly string[]).includes(value);
}

export function documentTypeForJob(jobType: string): PrintDocumentType | null {
  for (const type of PRINT_DOCUMENT_TYPES) {
    if (DOCUMENT_TYPES[type].jobTypes.includes(jobType)) return type;
  }
  return null;
}

/** The class a stored printer row belongs to; legacy rows are thermal. */
export function printerClassOf(printer: { printerClass?: string | null }): PrinterClass {
  return printer.printerClass === "full_page" ? "full_page" : "thermal";
}

/**
 * Characters per line for a thermal roll. "58mm" is the legacy spelling of
 * the narrow roll and prints like 50mm.
 */
export function thermalColumns(paperWidth: string | null | undefined): number {
  return paperWidth === "50mm" || paperWidth === "58mm" ? 32 : 48;
}
