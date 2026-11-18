import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  printer: { id: 1, tenantId: 1, routingScope: "general", locationId: null, connectionType: "bridge", bridgePrinterName: "Brightek_POS80", paperWidth: "80mm", printerClass: "thermal" },
  compose: vi.fn(async () => Buffer.from("%PDF-SAMPLE")),
}));
vi.mock("@workspace/db", () => ({
  printJobsTable: { idempotencyKey: "idempotencyKey" },
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => ({ values: (values: Record<string, unknown>) => {
      state.values = values;
      return { returning: async () => [{ id: 1, ...values }] };
    } }),
  },
}));
vi.mock("../print/printRouting", () => ({ resolveDocumentPrinter: async () => ({ ok: true, printer: state.printer, source: "configured", routeId: 1 }) }));
vi.mock("../print/receiptLogo", () => ({ composeLuciferReceiptPdf: state.compose, receiptPaperWidth: () => "80mm" }));
import { queueDocumentPrint } from "../print/documentJobs";

describe("logo document routing", () => {
  beforeEach(() => { state.compose.mockClear(); state.printer.bridgePrinterName = "Brightek_POS80"; });
  const input = () => ({
    tenantId: 1, locationId: null, documentType: "ORDER_RECEIPT" as const,
    jobType: "customer_receipt", idempotencyKey: "test-only", withLogo: true,
    render: { kind: "thermal-text" as const, text: async () => ({ text: "encoded", plainText: "SAMPLE", openCashDrawer: true }) },
  });
  it("stores the PDF for a branded Brightek receipt while retaining drawer intent", async () => {
    await queueDocumentPrint(input());
    expect(state.compose).toHaveBeenCalledWith("SAMPLE", "80mm");
    expect(state.values.renderFormat).toBe("pdf");
    expect(state.values.payloadJson).toMatchObject({ openCashDrawer: true, pdfBase64: Buffer.from("%PDF-SAMPLE").toString("base64") });
  });
  it("leaves other brands and other printers on their existing text path", async () => {
    await queueDocumentPrint({ ...input(), withLogo: false });
    expect(state.compose).not.toHaveBeenCalled();
    state.printer.bridgePrinterName = "Other_Printer";
    await queueDocumentPrint(input());
    expect(state.compose).not.toHaveBeenCalled();
    expect(state.values.renderFormat).toBe("text");
  });
});
