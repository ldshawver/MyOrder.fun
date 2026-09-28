/**
 * Document catalogue, thermal document builders, and the full-page PDF renderer.
 */
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { inflateSync } from "node:zlib";
import {
  DOCUMENT_TYPES,
  PRINT_DOCUMENT_TYPES,
  documentTypeForJob,
  printerClassOf,
  thermalColumns,
} from "../print/documentTypes";
import {
  buildClockSlip,
  buildDepositSlip,
  buildExpoTicket,
  buildShiftInventoryReport,
  buildShiftSalesReport,
  buildStockList,
  buildWorkTicket,
  displayPersonName,
  restockQuantity,
  sampleDocument,
  SAMPLE_SHIFT_CONTEXT,
  SAMPLE_SHIFT_INVENTORY,
} from "../print/documents";
import { pdfSafeText, renderReportPdf, type ReportDocument } from "../print/pdfReport";
import { fitReceiptLines, type ReceiptLine } from "../print/receiptTemplateRenderer";
import { encodeReceiptEscPos, encodeReceiptPlain } from "../print/receiptEncoders";
import { SAMPLE_RECEIPT_DATA } from "../print/receiptData";

const plain = (lines: ReceiptLine[], columns = 48) => encodeReceiptPlain(fitReceiptLines(lines, columns));

/** Decompresses every PDF stream so drawn text can be searched. */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const parts: string[] = [raw];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let match = re.exec(raw); match; match = re.exec(raw)) {
    try { parts.push(inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1")); } catch { /* uncompressed */ }
  }
  return parts.join("\n");
}
/** Text drawn by pdf-lib is hex-encoded: <48656C6C6F>. */
const hex = (text: string) => `<${Buffer.from(text, "latin1").toString("hex").toUpperCase()}>`;

describe("document catalogue", () => {
  it("covers the eight required document types with the right printer class", () => {
    expect(PRINT_DOCUMENT_TYPES).toEqual(["ORDER_RECEIPT", "CLOCK_IN", "CLOCK_OUT", "INVENTORY_STOCK_LIST", "DEPOSIT", "EXPO", "WORK", "REPORT"]);
    const fullPage = PRINT_DOCUMENT_TYPES.filter((type) => DOCUMENT_TYPES[type].printerClass === "full_page");
    expect(fullPage).toEqual(["INVENTORY_STOCK_LIST", "REPORT"]);
  });

  it("maps existing job types onto document types instead of duplicating them", () => {
    expect(documentTypeForJob("customer_receipt")).toBe("ORDER_RECEIPT");
    expect(documentTypeForJob("receipt")).toBe("ORDER_RECEIPT");
    expect(documentTypeForJob("expo_ticket")).toBe("EXPO");
    expect(documentTypeForJob("order_ticket")).toBe("WORK");
    expect(documentTypeForJob("shift_deposit")).toBe("DEPOSIT");
    expect(documentTypeForJob("shift_restock")).toBe("INVENTORY_STOCK_LIST");
    expect(documentTypeForJob("shift_ending_inventory")).toBe("INVENTORY_STOCK_LIST");
    expect(documentTypeForJob("shift_sales")).toBe("REPORT");
    expect(documentTypeForJob("shift_commission")).toBe("REPORT");
    expect(documentTypeForJob("thank_you_sticker")).toBeNull();
  });

  it("supports exactly 50mm and 80mm thermal widths (58mm legacy = narrow)", () => {
    expect(thermalColumns("50mm")).toBe(32);
    expect(thermalColumns("58mm")).toBe(32);
    expect(thermalColumns("80mm")).toBe(48);
    expect(printerClassOf({ printerClass: "full_page" })).toBe("full_page");
    expect(printerClassOf({ printerClass: null })).toBe("thermal");
  });
});

describe("thermal documents", () => {
  const clock = { businessName: "Shop", locationName: "CSR Sales Box 2", employeeName: "Casey J.", at: "2026-09-28T10:05:00.000Z", timezone: "America/Los_Angeles", shiftRef: "42" };

  it("clock slips show employee (first name + initial), time, location and shift only", () => {
    const text = plain(buildClockSlip({ ...clock, event: "in" }));
    expect(text).toContain("CLOCK IN");
    expect(text).toMatch(/Employee\s+Casey J\./);
    expect(text).toMatch(/Location\s+CSR Sales Box 2/);
    expect(text).toMatch(/Shift\s+#42/);
    expect(text).toContain("Sep 28, 2026");
    expect(plain(buildClockSlip({ ...clock, event: "out" }))).toContain("CLOCK OUT");
    expect(displayPersonName("Casey", "Jones")).toBe("Casey J.");
    expect(displayPersonName(null, null)).toBe("Staff");
  });

  it("deposit slips separate server-expected cash from the employee's reported count", () => {
    const text = plain(buildDepositSlip({
      businessName: "Shop", locationName: null, employeeName: "Casey J.", shiftRef: "42", timezone: "UTC",
      clockedInAt: "2026-09-28T08:00:00.000Z", clockedOutAt: "2026-09-28T16:00:00.000Z",
      cashBankStartCents: 10000, cashSalesCents: 4500, expectedCashCents: 14500, countedCashCents: 14450, varianceCents: -50,
      paymentTotals: [{ label: "Cash", cents: 4500 }],
    }));
    expect(text).toMatch(/Expected cash\s+\$145\.00/);
    expect(text).toMatch(/Counted cash \(reported\)\s+\$144\.50/);
    expect(text).toMatch(/Variance\s+-\$0\.50/);
    expect(text).toContain("Verified by:");
  });

  it("expo tickets carry order number, fulfilment and items but no prices", () => {
    const text = plain(buildExpoTicket(SAMPLE_RECEIPT_DATA));
    expect(text).toContain("#SAMPLE-0001");
    expect(text).toContain("2 x Sample Product");
    expect(text).toContain("Sample Option");
    expect(text).not.toMatch(/\$\d/);
  });

  it("work tickets list items with check boxes and no prices or customer", () => {
    const text = plain(buildWorkTicket(SAMPLE_RECEIPT_DATA));
    expect(text).toContain("[ ] 2 x Sample Product");
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toContain("Sample C.");
  });

  it("fits every thermal document to 50mm and 80mm and emits only safe commands", () => {
    for (const type of ["CLOCK_IN", "CLOCK_OUT", "DEPOSIT", "EXPO", "WORK"] as const) {
      const sample = sampleDocument(type);
      if (sample.kind !== "thermal") throw new Error("expected thermal");
      for (const columns of [32, 48]) {
        const lines = fitReceiptLines(sample.lines, columns);
        const text = encodeReceiptPlain(lines);
        // Large (double width) lines use half the columns.
        expect(text.split("\n").every((line) => line.length <= columns)).toBe(true);
        expect(encodeReceiptEscPos(lines).endsWith("\x1bd\x03\x1dVA\x00")).toBe(true);
      }
    }
  });
});

describe("full-page documents", () => {
  const ctx = SAMPLE_SHIFT_CONTEXT;

  it("computes restock quantities from PAR and the counted end", () => {
    expect(restockQuantity({ section: null, name: "a", unit: "#", start: 10, sold: 3, counted: 7, par: 12, flagged: false })).toBe(5);
    expect(restockQuantity({ section: null, name: "a", unit: "#", start: 10, sold: 3, counted: 13, par: 12, flagged: false })).toBe(0);
    expect(restockQuantity({ section: null, name: "a", unit: "#", start: 10, sold: 3, counted: null, par: 12, flagged: false })).toBe(0);
    const report = buildShiftInventoryReport(ctx, "restock", SAMPLE_SHIFT_INVENTORY);
    expect(report.sections[0]!.rows).toEqual([expect.objectContaining({ name: "Sample Item A", restock: "+5" }), expect.objectContaining({ name: "Sample Item B", restock: "+1" })]);
  });

  it("ending inventory shows expected vs counted and flags", () => {
    const report = buildShiftInventoryReport(ctx, "ending", SAMPLE_SHIFT_INVENTORY);
    expect(report.sections[0]!.rows[1]).toMatchObject({ name: "! Sample Item B", expected: "20.5", counted: "19", difference: "-1.5" });
    expect(report.summary).toContainEqual({ label: "Flagged", value: "1" });
  });

  it("stock lists show on-hand, PAR and reorder quantity", () => {
    const report = buildStockList({ businessName: "Shop", locationName: "Box 2", generatedAt: ctx.generatedAt, timezone: "UTC", generatedBy: null, rows: [
      { name: "A", sku: "SKU-A", option: null, unit: "#", quantity: 3, par: 10 },
      { name: "B", sku: null, option: "Blue", unit: "g", quantity: 12, par: 10 },
    ] });
    expect(report.sections[0]!.rows).toEqual([
      expect.objectContaining({ name: "A", sku: "SKU-A", quantity: "3", par: "10", reorder: "+7" }),
      expect.objectContaining({ name: "B", option: "Blue", reorder: "" }),
    ]);
    expect(report.summary).toContainEqual({ label: "Below PAR", value: "1" });
  });

  it("sales reports never list customers", () => {
    const report = buildShiftSalesReport(ctx, { orderCount: 2, totalRevenueCents: 5000, paymentTotals: [{ label: "Cash", cents: 5000 }], items: [{ name: "A", quantity: 2, revenueCents: 5000 }], commissionCents: 250 });
    expect(JSON.stringify(report)).not.toMatch(/customer/i);
    expect(report.summary).toContainEqual({ label: "Commission", value: "$2.50" });
  });

  it("renders US Letter PDFs with page numbers and repeated table headers", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ name: `Item ${i + 1}`, sku: `SKU-${i}`, option: null, unit: "#", quantity: i, par: 50 }));
    const report = buildStockList({ businessName: "Shop", locationName: "Box 2", generatedAt: ctx.generatedAt, timezone: "UTC", generatedBy: "Luke S", rows });
    const bytes = await renderReportPdf(report);
    const pdf = await PDFDocument.load(bytes);
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    const { width, height } = pdf.getPage(0).getSize();
    expect([width, height]).toEqual([612, 792]);
    const text = pdfText(bytes);
    expect(text).toContain(hex(`Page ${pdf.getPageCount()} of ${pdf.getPageCount()}`));
    // Column headers are drawn once per page.
    expect(text.split(hex("On hand")).length - 1).toBe(pdf.getPageCount());
    expect(text).toContain(hex("Item 120"));
  }, 20_000);

  it("is reproducible: the same document gives identical bytes", async () => {
    const sample = sampleDocument("REPORT");
    if (sample.kind !== "report") throw new Error("expected report");
    const a = await renderReportPdf(sample.report);
    const b = await renderReportPdf(sample.report);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("strips control characters and non-WinAnsi text safely", async () => {
    expect(pdfSafeText("A\x1b@B‮C… 中")).toBe("A @B C... ?");
    const doc: ReportDocument = { title: "T\x1b", businessName: "B", generatedAt: ctx.generatedAt, timezone: "UTC", sections: [{ columns: [{ key: "a", label: "A" }], rows: [{ a: "x\x00y\u{1F600}" }] }] };
    await expect(renderReportPdf(doc)).resolves.toBeInstanceOf(Uint8Array);
  });
});
