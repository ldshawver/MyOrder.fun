import { beforeEach, describe, expect, it, vi } from "vitest";

const updateSets: Array<Record<string, unknown>> = [];
const insertedAttempts: Array<Record<string, unknown>> = [];
const bridgeProfiles = vi.hoisted(() => [] as Array<{ id: number; tenantId: number; apiKey: string }>);
// Rows returned by the atomic "sending" claim; empty means another dispatcher won.
const claimRows = vi.hoisted(() => ({ rows: [{ id: 1 }] as Array<{ id: number }> }));

vi.mock("@workspace/db", () => {
  const update = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.set = vi.fn((values: Record<string, unknown>) => {
      updateSets.push(values);
      return chain;
    });
    chain.where = vi.fn(() => Object.assign(Promise.resolve([]), {
      returning: vi.fn(async () => claimRows.rows),
    }));
    return chain;
  });
  const insert = vi.fn(() => ({
    values: vi.fn((values: Record<string, unknown>) => {
      insertedAttempts.push(values);
      return Promise.resolve([]);
    }),
  }));
  // Bridge profile lookup: evaluates the eq() predicates on id and tenantId.
  const select = vi.fn(() => ({
    from: () => ({
      where: (predicates: Array<{ column: string; value: unknown }>) => ({
        limit: async () => bridgeProfiles
          .filter((row) => predicates.every(({ column, value }) =>
            (column === "bridgeProfileId" && row.id === value) ||
            (column === "bridgeTenantId" && row.tenantId === value)))
          .map((row) => ({ apiKey: row.apiKey })),
      }),
    }),
  }));
  return {
    db: { update, insert, select },
    printBridgeProfilesTable: { id: "bridgeProfileId", tenantId: "bridgeTenantId", apiKey: "bridgeApiKey" },
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
    bridgeProfiles.length = 0;
    claimRows.rows = [{ id: 1 }];
    vi.restoreAllMocks();
  });

  it("sends a job at most once when the worker and the request race for it", async () => {
    // The request's inline dispatch already claimed the job; the worker loses.
    claimRows.rows = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await dispatchReceiptJob({ id: 43, tenantId: 1, locationId: null, retryCount: 0, maxRetries: 5, renderedText: "TEST", renderFormat: "text", payloadJson: {} } as never,
      { id: 1, tenantId: 1, locationId: null, routingScope: "general", isActive: true, connectionType: "bridge", bridgeUrl: "http://mac.test:3100", bridgePrinterName: "Brightek_POS80" } as never);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(insertedAttempts).toHaveLength(0);
    expect(updateSets.some((update) => update.status === "printed" || update.status === "failed")).toBe(false);
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

  describe("bridge credential per bridge profile", () => {
    const PI_KEY = "pi-bridge-key-0123456789abcdef0123456789abcdef";
    const job = { id: 95, tenantId: 1, locationId: null, retryCount: 0, maxRetries: 1, renderedText: "TEST", renderFormat: "text", payloadJson: {} } as never;
    const printer = (extra: Record<string, unknown> = {}) => ({
      id: 96, tenantId: 1, locationId: null, routingScope: "general", isActive: true, name: "Pi receipt",
      bridgePrinterName: "Pi_Receipt", connectionType: "bridge", bridgeProfileId: 7,
      bridgeUrl: "http://pi.test:3100", timeoutMs: 8000, copies: 1, apiKey: null, ...extra,
    }) as never;
    const sentKey = async (p: never) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
      await dispatchReceiptJob(job, p);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      return (fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>)["x-api-key"];
    };

    it("sends the printer's own bridge profile key", async () => {
      bridgeProfiles.push({ id: 7, tenantId: 1, apiKey: PI_KEY });
      expect(await sentKey(printer())).toBe(PI_KEY);
    });

    it("falls back to the central key when the bridge profile key is empty", async () => {
      bridgeProfiles.push({ id: 7, tenantId: 1, apiKey: "" });
      expect(await sentKey(printer())).toBe("central-secret");
    });

    it("never uses another tenant's bridge profile key", async () => {
      bridgeProfiles.push({ id: 7, tenantId: 2, apiKey: PI_KEY });
      expect(await sentKey(printer())).toBe("central-secret");
    });

    it("keeps a legacy per-printer key ahead of the profile key", async () => {
      bridgeProfiles.push({ id: 7, tenantId: 1, apiKey: PI_KEY });
      expect(await sentKey(printer({ apiKey: "legacy-printer-key" }))).toBe("legacy-printer-key");
    });

    it("uses the central key for printers without a bridge profile", async () => {
      expect(await sentKey(printer({ bridgeProfileId: null }))).toBe("central-secret");
    });
  });
});
