import { beforeEach, describe, expect, it, vi } from "vitest";

const updateSets: Array<Record<string, unknown>> = [];
const insertedAttempts: Array<Record<string, unknown>> = [];

vi.mock("@workspace/db", () => {
  const update = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.set = vi.fn((values: Record<string, unknown>) => {
      updateSets.push(values);
      return chain;
    });
    chain.where = vi.fn(() => Promise.resolve([]));
    return chain;
  });
  const insert = vi.fn(() => ({
    values: vi.fn((values: Record<string, unknown>) => {
      insertedAttempts.push(values);
      return Promise.resolve([]);
    }),
  }));
  return {
    db: { update, insert, select: vi.fn() },
    printPrintersTable: { id: "printerId", role: "role", isActive: "isActive" },
    printJobsTable: { id: "jobId", idempotencyKey: "idempotencyKey" },
    printJobAttemptsTable: {},
    printSettingsTable: {},
    adminSettingsTable: {},
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((column, value) => ({ column, value })),
  and: vi.fn((...values) => values),
  inArray: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("../logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock("../printRouter", () => ({
  selectActiveOperator: vi.fn(),
  resolveReceiptPrinters: vi.fn(),
  resolveLabelPrinter: vi.fn(),
}));

vi.mock("../receiptRenderer", () => ({
  decodeStoredReceiptText: (value: string) => value,
  renderKitchenTicket: vi.fn(),
  renderCustomerReceipt: vi.fn(),
}));

vi.mock("../print/index", () => ({ charWidth: vi.fn(), getLogo: vi.fn() }));
vi.mock("../print/templates/thankYouLabel.js", () => ({ generateThankYouLabel: vi.fn() }));

import { dispatchReceiptJob } from "../printService";

describe("print job status integrity", () => {
  beforeEach(() => {
    updateSets.length = 0;
    insertedAttempts.length = 0;
    process.env.PRINT_BRIDGE_API_KEY = "central-secret";
    vi.restoreAllMocks();
  });

  it("does not mark a job printed when the bridge returns HTTP 200 with success=false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ success: false, error: "CUPS rejected unknown queue" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    await dispatchReceiptJob({
      id: 77,
      tenantId: 1,
      locationId: null,
      shiftId: null,
      orderId: null,
      printerId: 12,
      operatorUserId: 5,
      jobType: "receipt",
      status: "queued",
      idempotencyKey: "test-job-77",
      renderFormat: "text",
      payloadJson: {},
      renderedText: "TEST",
      renderedImagePath: null,
      templateId: null,
      templateVersion: null,
      printedVia: null,
      errorMessage: null,
      retryCount: 0,
      maxRetries: 1,
      lastAttemptAt: null,
      printedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, {
      id: 12,
      tenantId: 1,
      locationId: null,
      routingScope: "general",
      name: "Mac receipt",
      role: "receipt",
      connectionType: "mac_bridge",
      bridgeProfileId: 1,
      directIp: null,
      directPort: 9100,
      bridgeUrl: "http://bridge.test",
      bridgePrinterName: "Brightek_POS80",
      apiKey: null,
      isActive: true,
      timeoutMs: 8000,
      copies: 1,
      paperWidth: "80mm",
      supportsCut: true,
      supportsCashDrawer: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(updateSets.some((update) => update.status === "printed")).toBe(false);
    expect(updateSets.at(-1)).toMatchObject({
      status: "failed",
      errorMessage: "CUPS rejected unknown queue",
    });
    expect(insertedAttempts[0]).toMatchObject({ success: false });
  });

  it("rejects an empty queue before contacting the bridge or CUPS default", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await dispatchReceiptJob({
      id: 78,
      tenantId: 1,
      locationId: null,
      retryCount: 0,
      maxRetries: 1,
      renderedText: "TEST",
      renderFormat: "text",
      payloadJson: {},
    } as never, {
      id: 13,
      tenantId: 1,
      locationId: null,
      routingScope: "general",
      isActive: true,
      name: "",
      bridgePrinterName: "",
      connectionType: "mac_bridge",
      bridgeUrl: "http://bridge.test",
      timeoutMs: 8000,
      copies: 1,
      apiKey: null,
    } as never);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updateSets.some((update) => update.status === "printed")).toBe(false);
    expect(updateSets.at(-1)?.status).toBe("failed");
    expect(String(updateSets.at(-1)?.errorMessage)).toContain("system-default CUPS fallback");
  });

  it("submits ordinary rendered labels as non-raw PNG without borrowing sticker media", async () => {
    let requestBody: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    const { dispatchLabelJob } = await import("../printService");
    await dispatchLabelJob({
      id: 79,
      tenantId: 1,
      locationId: null,
      retryCount: 0,
      maxRetries: 1,
      renderedText: "MYORDER DEV LABEL TEST",
      renderFormat: "png",
      payloadJson: { imageData: Buffer.from("png-test").toString("base64") },
    } as never, {
      id: 14,
      tenantId: 1,
      locationId: null,
      routingScope: "general",
      isActive: true,
      name: "Mac label",
      bridgePrinterName: "Label_Themal_Printer",
      connectionType: "mac_bridge",
      bridgeUrl: "http://bridge.test",
      timeoutMs: 8000,
      copies: 1,
      apiKey: null,
    } as never);

    expect(requestBody).toMatchObject({
      printerName: "Label_Themal_Printer",
      format: "png",
      raw: false,
    });
    expect(requestBody).not.toHaveProperty("media");
    expect(requestBody.imageBase64).toBeTruthy();
    expect(requestBody).not.toHaveProperty("payloadBase64");
  });

  it("fails closed before bridge submission when job and printer locations differ", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await dispatchReceiptJob({ id: 90, tenantId: 1, locationId: 1, retryCount: 0, maxRetries: 1, renderedText: "TEST", renderFormat: "text", payloadJson: {} } as never,
      { id: 91, tenantId: 1, locationId: 2, routingScope: "location", isActive: true, connectionType: "pi_bridge", bridgeUrl: "http://box-2.test", bridgePrinterName: "Beeprt_USB" } as never);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updateSets.at(-1)).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("tenant/location") });
    expect(insertedAttempts).toHaveLength(0);
  });
});
