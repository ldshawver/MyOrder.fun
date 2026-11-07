import { beforeEach, describe, expect, it, vi } from "vitest";

const updateSets: Array<Record<string, unknown>> = [];
const updateWheres: unknown[] = [];
const insertedAttempts: Array<Record<string, unknown>> = [];
const bridgeProfiles = vi.hoisted(() => [] as Array<{ id: number; tenantId: number; apiKey: string }>);
const printerRows = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
// Rows returned by the atomic "sending" claim; empty means another dispatcher won.
const claimRows = vi.hoisted(() => ({ rows: [{ id: 1 }] as Array<{ id: number }> }));

vi.mock("@workspace/db", () => {
  const update = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.set = vi.fn((values: Record<string, unknown>) => {
      updateSets.push(values);
      return chain;
    });
    chain.where = vi.fn((predicate: unknown) => (updateWheres.push(predicate), Object.assign(Promise.resolve([]), {
      returning: vi.fn(async () => claimRows.rows),
    })));
    return chain;
  });
  const insert = vi.fn(() => ({
    values: vi.fn((values: Record<string, unknown>) => {
      insertedAttempts.push(values);
      const row = { id: 900, retryCount: 0, maxRetries: 1, locationId: null, renderFormat: "text", status: "queued", ...values };
      return Object.assign(Promise.resolve([]), {
        returning: vi.fn(async () => [row]),
      });
    }),
  }));
  // Bridge profile lookup: evaluates the eq() predicates on id and tenantId.
  // A Brightek fallback lookup returns printerRows instead.
  const select = vi.fn(() => ({
    from: () => ({
      where: (predicates: Array<{ column: string; value: unknown }>) => ({
        limit: async () => {
          const list = Array.isArray(predicates) ? predicates : [predicates];
          const serialized = JSON.stringify(list);
          if (serialized.includes("Brightek_POS80") || serialized.includes("Brightek POS80")) return printerRows.rows;
          return bridgeProfiles
            .filter((row) => list.every((predicate) => {
              const column = predicate && typeof predicate === "object" && "column" in predicate ? predicate.column : undefined;
              const value = predicate && typeof predicate === "object" && "value" in predicate ? predicate.value : undefined;
              return (column === "bridgeProfileId" && row.id === value) || (column === "bridgeTenantId" && row.tenantId === value);
            }))
            .map((row) => ({ apiKey: row.apiKey }));
        },
      }),
    }),
  }));
  return {
    db: { update, insert, select },
    printBridgeProfilesTable: { id: "bridgeProfileId", tenantId: "bridgeTenantId", apiKey: "bridgeApiKey" },
    printPrintersTable: {
      id: "printerId", role: "role", isActive: "isActive", tenantId: "printerTenantId",
      bridgePrinterName: "bridgePrinterName", name: "printerName",
    },
    printJobsTable: { id: "jobId", idempotencyKey: "idempotencyKey", status: "status", tenantId: "jobTenantId", lastAttemptAt: "lastAttemptAt" },
    printJobAttemptsTable: {},
    printSettingsTable: {},
    adminSettingsTable: {},
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((column, value) => ({ column, value })),
  and: vi.fn((...values) => values),
  inArray: vi.fn((column, values) => ({ column, values })),
  lt: vi.fn((column, value) => ({ column, lt: value })),
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

import { dispatchReceiptJob, failStaleSendingJobs, STALE_SENDING_MS } from "../printService";

describe("print job status integrity", () => {
  beforeEach(() => {
    updateSets.length = 0;
    updateWheres.length = 0;
    insertedAttempts.length = 0;
    process.env.PRINT_BRIDGE_API_KEY = "central-secret";
    bridgeProfiles.length = 0;
    printerRows.rows = [];
    claimRows.rows = [{ id: 1 }];
    vi.restoreAllMocks();
  });

  it("claims only queued or retrying jobs of the job's tenant", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await dispatchReceiptJob({ id: 43, tenantId: 1, locationId: null, retryCount: 0, maxRetries: 5, renderedText: "TEST", renderFormat: "text", payloadJson: {} } as never,
      { id: 1, tenantId: 1, locationId: null, routingScope: "general", isActive: true, connectionType: "bridge", bridgeUrl: "http://mac.test:3100", bridgePrinterName: "Brightek_POS80" } as never);
    expect(updateSets[0]).toMatchObject({ status: "sending" });
    expect(updateWheres[0]).toEqual([
      { column: "jobTenantId", value: 1 },
      { column: "jobId", value: 43 },
      { column: "status", values: ["queued", "retrying"] },
    ]);
    expect(updateSets.at(-1)).toMatchObject({ status: "printed" });
  });

  it("fails jobs stranded in sending instead of resending them", async () => {
    claimRows.rows = [{ id: 7 }];
    const now = new Date("2026-09-29T12:00:00.000Z");
    expect(await failStaleSendingJobs(now)).toBe(1);
    expect(updateSets.at(-1)).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("may have printed") });
    expect(updateWheres.at(-1)).toEqual([
      { column: "status", value: "sending" },
      { column: "lastAttemptAt", lt: new Date(now.getTime() - STALE_SENDING_MS) },
    ]);
    // Never back to a dispatchable state.
    expect(updateSets.some((update) => update.status === "queued" || update.status === "retrying")).toBe(false);
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
    expect(insertedAttempts.some((row) => String(row.idempotencyKey ?? "").startsWith("reroute:"))).toBe(false);
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
    expect(insertedAttempts.some((row) => String(row.idempotencyKey ?? "").startsWith("reroute:"))).toBe(false);
  });

  it("reroutes a failed location slip to Brightek_POS80 with the source printer on the first line", async () => {
    const bodies: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(String(init?.body ?? ""));
      throw new Error("connect ECONNREFUSED 100.121.53.58:3100");
    });
    printerRows.rows = [{
      id: 1,
      tenantId: 1,
      locationId: null,
      routingScope: "general",
      isActive: true,
      name: "Brightek POS80",
      bridgePrinterName: "Brightek_POS80",
      connectionType: "bridge",
      bridgeUrl: "http://mac.test:3100",
      bridgeProfileId: null,
      apiKey: null,
      timeoutMs: 8000,
      copies: 1,
    }];

    await dispatchReceiptJob({
      id: 139,
      tenantId: 1,
      locationId: 4,
      shiftId: null,
      orderId: 77,
      printerId: 11,
      operatorUserId: null,
      jobType: "customer_receipt",
      status: "queued",
      idempotencyKey: "order_receipt:1:77",
      renderFormat: "text",
      payloadJson: { documentType: "ORDER_RECEIPT" },
      renderedText: "ORDER 77",
      retryCount: 0,
      maxRetries: 5,
    } as never, {
      id: 11,
      tenantId: 1,
      locationId: 4,
      routingScope: "location",
      isActive: true,
      name: "Box 2 RPP02N",
      bridgePrinterName: "RPP02N",
      connectionType: "pi_bridge",
      bridgeUrl: "http://100.121.53.58:3100",
      apiKey: null,
      timeoutMs: 8000,
      copies: 1,
    } as never);

    const rerouted = insertedAttempts.filter((row) => String(row.idempotencyKey ?? "").startsWith("reroute:"));
    expect(rerouted).toHaveLength(1);
    expect(rerouted[0]).toMatchObject({
      tenantId: 1,
      locationId: null,
      orderId: 77,
      printerId: 1,
      jobType: "customer_receipt",
      status: "queued",
      idempotencyKey: "reroute:order_receipt:1:77",
      renderedText: "******** Rerouted from RPP02N  ********\nORDER 77",
      payloadJson: {
        documentType: "ORDER_RECEIPT",
        reroutedFrom: "RPP02N",
        rerouteOfJobId: 139,
        fallbackPrinter: "Brightek_POS80",
      },
    });
    expect(updateSets).toContainEqual(expect.objectContaining({
      status: "failed",
      errorMessage: expect.stringContaining("rerouted to Brightek_POS80"),
    }));
    const rerouteFailure = updateSets.findIndex((update) => String(update.errorMessage ?? "").includes("rerouted to Brightek_POS80"));
    expect(rerouteFailure).toBeGreaterThanOrEqual(0);
    expect(updateSets.slice(0, rerouteFailure).some((update) => update.status === "retrying")).toBe(false);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("ORDER 77");
    expect(bodies[0]).not.toContain("Rerouted from");
    expect(bodies[1]).toContain("******** Rerouted from RPP02N  ********");
    expect(bodies[1]).toContain("Brightek_POS80");
  });

  it("keeps retrying the routed printer when no Brightek_POS80 is registered", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"));
    await dispatchReceiptJob({
      id: 140,
      tenantId: 1,
      locationId: 4,
      retryCount: 0,
      maxRetries: 5,
      jobType: "expo_ticket",
      renderFormat: "text",
      renderedText: "EXPO",
      idempotencyKey: "expo_ticket:1:77",
      payloadJson: {},
    } as never, {
      id: 11,
      tenantId: 1,
      locationId: 4,
      routingScope: "location",
      isActive: true,
      name: "Box 2 RPP02N",
      bridgePrinterName: "RPP02N",
      connectionType: "pi_bridge",
      bridgeUrl: "http://box.test:3100",
      timeoutMs: 8000,
      copies: 1,
      apiKey: null,
    } as never);
    expect(updateSets.at(-1)).toMatchObject({ status: "retrying" });
    expect(insertedAttempts.some((row) => String(row.idempotencyKey ?? "").startsWith("reroute:"))).toBe(false);
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
