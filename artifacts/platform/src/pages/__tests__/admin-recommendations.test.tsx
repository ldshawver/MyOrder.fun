// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getToken: vi.fn(async () => "test-token") }));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ getToken: auth.getToken }) }));
vi.mock("@workspace/api-client-react", () => ({ useGetCurrentUser: () => ({ data: { role: "global_admin" } }) }));
import AdminCatalogueProducts from "../admin/catalogue-products";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

it("shows Coffee Beans transfer and purchase as distinct suggestions without changing inventory", async () => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input);
    paths.push(path);
    expect(init?.method).toBeUndefined();
    const payload = path.endsWith("/products") ? { products: [] } : { items: [{
      inventoryItemId: 182, productName: "Coffee Beans", baseUnit: "g", recommendations: [
        { locationId: 1, locationName: "Backstock", internalTransfers: [{ fromLocationId: 2, quantity: "1000.000000" }],
          externalPurchaseQuantity: "2000.000000" },
        { locationId: 2, locationName: "Storefront", internalTransfers: [], externalPurchaseQuantity: "0.000000" },
      ],
    }] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(AdminCatalogueProducts)));
  await vi.waitFor(() => expect(host?.textContent).toContain("Suggested external purchase: 2000.000000 g"));
  expect(host.textContent).toContain("Suggested internal transfer: Storefront → Backstock · 1000.000000 g");
  expect(host.textContent).toContain("No inventory transfer or purchase has been created");
  expect(paths).toEqual(["/api/admin/catalogue/products", "/api/admin/catalogue/recommendations"]);
});

it("keeps variants, location inventory, and Global Admin compliance controls together on the selected catalogue item", async () => {
  let held = false;
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/admin/catalogue/products") return new Response(JSON.stringify({ products: [{
      id: 7, name: "Test Shirt", inventoryModel: "SEPARATE_VARIANTS", locationEvaluation: "PER_LOCATION",
      options: [
        { id: 9, catalogItemId: 70, label: "Black / Small", optionValues: { Color: "Black", Size: "Small" }, sku: "TS-BS", price: "12.00", compareAtPrice: null, active: true, isAvailable: true, inventoryItemId: 90, baseUnit: "each", consumptionQuantity: "1", complianceHold: held, complianceReason: held ? "Review required" : null, inventoryStatus: "ready", balanceRowCount: 1, stockOnHand: "4", reservedQuantity: "1", availableQuantity: "3", orderable: true },
        { id: 10, catalogItemId: 71, label: "Black / Large", optionValues: { Color: "Black", Size: "Large" }, sku: "TS-BL", price: "14.00", compareAtPrice: null, active: true, isAvailable: true, inventoryItemId: 91, baseUnit: "each", consumptionQuantity: "1", complianceHold: false, complianceReason: null, inventoryStatus: "missing_balance", balanceRowCount: 0, stockOnHand: null, reservedQuantity: null, availableQuantity: null, orderable: false },
      ],
    }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/admin/catalogue/recommendations") return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/admin/catalogue/inventory/90/locations") return new Response(JSON.stringify({ locations: [{ locationId: 2, name: "Main", quantityOnHand: "4", par: "0", reorderPoint: "0", preferredReorderQuantity: "0", moq: "0" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/admin/product-master/70/lifecycle" && init?.method === "PATCH") {
      held = JSON.parse(String(init.body)).complianceHold;
      return new Response(JSON.stringify({ item: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(AdminCatalogueProducts)));
  await vi.waitFor(() => expect(host?.textContent).toContain("Test Shirt"));
  await act(async () => host!.querySelector("aside button")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await vi.waitFor(() => expect(host?.textContent).toContain("Compliance Hold"));
  expect([...host!.querySelectorAll("input")].some(input => input.value === "Color=Black; Size=Small")).toBe(true);
  expect(host?.textContent).toContain("Inventory item #90 by location");
  expect(host?.textContent).toContain("Main");
  expect(host?.textContent).toContain("On hand 4; reserved 1; available 3");
  expect(host?.textContent).toContain("No active sellable balance — ordering blocked");
  const reason = host!.querySelector('input[aria-label="Compliance action reason"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(reason, "Review required");
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    reason.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const placeHold = [...host!.querySelectorAll("button")].find(button => button.textContent?.includes("Place hold"));
  expect(placeHold).toBeTruthy();
  await act(async () => placeHold!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/product-master/70/lifecycle", expect.objectContaining({ method: "PATCH" })));
  expect(JSON.parse(String(fetchMock.mock.calls.find(([path]) => path === "/api/admin/product-master/70/lifecycle")?.[1]?.body))).toEqual({ complianceHold: true, reason: "Review required" });
});

it("shows a clear reconciliation path when saving Shared is unsafe", async () => {
  const requests: Array<{ path: string; method?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input); requests.push({ path, method: init?.method });
    if (path === "/api/admin/catalogue/products") return new Response(JSON.stringify({ products: [{ id: 7, name: "Shirt", inventoryModel: "SEPARATE_VARIANTS", locationEvaluation: "PER_LOCATION", options: [
      { id: 9, catalogItemId: 70, label: "Small", optionValues: { Size: "S" }, sku: "S", price: "12.00", active: true, isAvailable: true, inventoryItemId: 90, baseUnit: "each", consumptionQuantity: "1", complianceHold: false, complianceReason: null },
      { id: 10, catalogItemId: 71, label: "Large", optionValues: { Size: "L" }, sku: "L", price: "14.00", active: true, isAvailable: true, inventoryItemId: 91, baseUnit: "each", consumptionQuantity: "1", complianceHold: false, complianceReason: null },
    ] }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/admin/catalogue/recommendations") return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path.startsWith("/api/admin/catalogue/inventory/") && path.endsWith("/locations")) return new Response(JSON.stringify({ locations: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/products/7") && init?.method === "PATCH") return new Response(JSON.stringify({ error: "This product already has inventory history. Review and use controlled reconciliation before switching to Shared variants." }), { status: 409, headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/inventory-reconciliation/preview")) return new Response(JSON.stringify({ product: { id: 7, name: "Shirt", inventoryModel: "SEPARATE_VARIANTS", locationEvaluation: "PER_LOCATION" },
      target: { inventoryItemId: 90 }, targetUnit: "each", variants: [], reservations: [], committed: [], costs: [], legacyHistory: [], locations: [], orderHistory: [], issues: [], costRequired: false, fingerprint: "a".repeat(64) }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(AdminCatalogueProducts)));
  await vi.waitFor(() => expect(host?.textContent).toContain("Shirt"));
  const productButton = [...host!.querySelectorAll("button")].find(button => button.textContent?.includes("Shirt"));
  await act(async () => productButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await vi.waitFor(() => expect(host?.textContent).toContain("Options / variants"));
  const inventoryModel = host!.querySelectorAll("select")[2] as HTMLSelectElement;
  await act(async () => { inventoryModel.value = "SHARED"; inventoryModel.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host?.textContent).toContain("Reconcile inventory");
  const saveModel = [...host!.querySelectorAll("button")].find(button => button.textContent?.includes("Save inventory model"));
  await act(async () => saveModel!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await vi.waitFor(() => expect(host?.textContent).toContain("already has inventory history"));
  expect(requests.some(request => request.method === "PATCH" && request.path.endsWith("/products/7"))).toBe(true);
  const previewButton = [...host!.querySelectorAll("button")].find(button => button.textContent?.includes("Reconcile inventory · preview"));
  expect(previewButton).toBeTruthy();
  await act(async () => previewButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await vi.waitFor(() => expect(host?.textContent).toContain("Preview · proposed base unit: each"));
  expect(requests.filter(request => request.method === "POST" && request.path.endsWith("/inventory-reconciliation/preview"))).toHaveLength(1);
});

it("saves an eligible Shared model and shows it after the settings reload", async () => {
  let inventoryModel: "SHARED" | "SEPARATE_VARIANTS" = "SEPARATE_VARIANTS";
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/admin/catalogue/products" && !init?.method) return new Response(JSON.stringify({ products: [{ id: 7, name: "Shirt", inventoryModel, locationEvaluation: "PER_LOCATION", options: [
      { id: 9, catalogItemId: 70, label: "Small", optionValues: { Size: "S" }, sku: "S", price: "12.00", active: true, isAvailable: true, inventoryItemId: 90, baseUnit: "each", consumptionQuantity: "1.000000", complianceHold: false, complianceReason: null },
      { id: 10, catalogItemId: 71, label: "Large", optionValues: { Size: "L" }, sku: "L", price: "17.50", active: true, isAvailable: true, inventoryItemId: inventoryModel === "SHARED" ? 90 : 91, baseUnit: "each", consumptionQuantity: "2.500000", complianceHold: false, complianceReason: null },
    ] }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/admin/catalogue/recommendations") return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path.startsWith("/api/admin/catalogue/inventory/") && path.endsWith("/locations")) return new Response(JSON.stringify({ locations: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/products/7") && init?.method === "PATCH") {
      inventoryModel = JSON.parse(String(init.body)).inventoryModel;
      return new Response(JSON.stringify({ product: { id: 7, inventoryModel } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 400, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(AdminCatalogueProducts)));
  await vi.waitFor(() => expect(host?.textContent).toContain("Shirt"));
  await act(async () => [...host!.querySelectorAll("button")].find(button => button.textContent?.includes("Shirt"))!.click());
  const select = host!.querySelectorAll("select")[2] as HTMLSelectElement;
  await act(async () => { select.value = "SHARED"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => [...host!.querySelectorAll("button")].find(button => button.textContent === "Save inventory model")!.click());
  await vi.waitFor(() => expect(host?.textContent).toContain("Inventory model saved."));
  expect((host!.querySelectorAll("select")[2] as HTMLSelectElement).value).toBe("SHARED");
  const inputValues = [...host!.querySelectorAll("input")].map(input => input.value);
  expect(inputValues).toContain("2.500000");
  expect(inputValues).toContain("17.50");
});

it("submits explicit package-to-gram conversions for a shared inventory preview", async () => {
  type PreviewBody = { target?: { create?: { name: string; baseUnit: string } }; variantConversions?: Array<{
    optionId: number; sourceUnitQuantityInTargetUnit: string; targetConsumptionQuantity: string }> };
  const requests: Array<{ path: string; body?: PreviewBody }> = [];
  const options = [
    [9, "Gram", "1"], [10, "Ball", "3.5"], [11, "Quarter", "7"], [12, "Half", "14"], [13, "Ounce", "28"],
  ].map(([id,label,consumption], index) => ({ id, catalogItemId: 70 + index, label, optionValues: { Size: label }, sku: null,
    price: "10.00", active: true, isAvailable: true, inventoryItemId: 90 + index, baseUnit: "each", consumptionQuantity: consumption,
    complianceHold: false, complianceReason: null, inventoryStatus: "ready", balanceRowCount: 1, stockOnHand: "11", reservedQuantity: "0", availableQuantity: "11", orderable: true }));
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input); const body = init?.body ? JSON.parse(String(init.body)) as PreviewBody : undefined; requests.push({ path, body });
    if (path === "/api/admin/catalogue/products") return new Response(JSON.stringify({ products: [{ id: 7, name: "Tina", inventoryModel: "SEPARATE_VARIANTS", locationEvaluation: "PER_LOCATION", options }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/admin/catalogue/recommendations") return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path.startsWith("/api/admin/catalogue/inventory/") && path.endsWith("/locations")) return new Response(JSON.stringify({ locations: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/inventory-history-repair")) return new Response(JSON.stringify({ discrepancies: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/inventory-reconciliation/preview")) return new Response(JSON.stringify({ product: { id: 7, name: "Tina", inventoryModel: "SEPARATE_VARIANTS", locationEvaluation: "PER_LOCATION" },
      target: body!.target, targetUnit: "g", variants: options.map((option, index) => ({ ...option, optionId: option.id, inventoryCatalogItemId: option.catalogItemId,
        sourceUnitQuantityInTargetUnit: ["1","3.5","7","14","28"][index], proposedConsumption: ["1","3.5","7","14","28"][index] })),
      reservations: [], committed: [], costs: [], legacyHistory: [], locations: [{ locationId: 1, locationName: "Store", sourceBalances: [], proposedSharedBalance: "154.000000" }],
      orderHistory: [], issues: [], costRequired: false, fingerprint: "a".repeat(64) }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(AdminCatalogueProducts)));
  await vi.waitFor(() => expect(host?.textContent).toContain("Tina"));
  await act(async () => [...host!.querySelectorAll("button")].find(button => button.textContent?.includes("Tina"))!.click());
  const modelSelect = host!.querySelectorAll("select")[2] as HTMLSelectElement;
  await act(async () => { modelSelect.value = "SHARED"; modelSelect.dispatchEvent(new Event("change", { bubbles: true })); });
  await vi.waitFor(() => expect(host?.textContent).toContain("Reconcile inventory"));
  const targetSelect = [...host!.querySelectorAll("select")].find(select => [...select.options].some(option => option.value === "create"))!;
  await act(async () => { targetSelect.value = "create"; targetSelect.dispatchEvent(new Event("change", { bubbles: true })); });
  const labelInput = (text: string) => [...host!.querySelectorAll("label")].find(label => label.textContent?.includes(text))!.querySelector("input")!;
  const setInput = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  await act(async () => {
    setInput(labelInput("New shared item name"), "Tina shared grams"); setInput(labelInput("Shared base unit"), "g");
  });
  if (!host!.querySelector("input[aria-label^='Source conversion option']")) {
    const explicit = [...host!.querySelectorAll("label")].find(label => label.textContent?.includes("Explicitly convert"))!.querySelector("input")!;
    await act(async () => explicit.click());
  }
  for (const [index, option] of options.entries()) {
    for (const [prefix, value] of [["Source conversion option", ["1","3.5","7","14","28"][index]], ["Target consumption option", ["1","3.5","7","14","28"][index]]] as const) {
      const input = host!.querySelector(`input[aria-label="${prefix} ${option.id}"]`) as HTMLInputElement;
      await act(async () => setInput(input, value));
    }
  }
  await act(async () => [...host!.querySelectorAll("button")].find(button => button.textContent?.includes("Reconcile inventory · preview"))!.click());
  await vi.waitFor(() => expect(host?.textContent).toContain("proposed shared balance 154.000000 g"));
  const preview = requests.find(request => request.path.endsWith("/inventory-reconciliation/preview"))!;
  expect(preview.body!.variantConversions).toEqual(options.map((option, index) => ({ optionId: option.id,
    sourceUnitQuantityInTargetUnit: ["1","3.5","7","14","28"][index], targetConsumptionQuantity: ["1","3.5","7","14","28"][index] })));
});

it("guides an explicit per-row append-only history repair and preserves unknown cost", async () => {
  let repaired = false;
  type GuidedBody = { evidence?: Array<{ costBasisNote?: string; documentedUnitCost?: string | null; physicalCountNote?: string }>;
    confirmedCorrections?: Array<Record<string, unknown>> };
  const requests: Array<{ path: string; method?: string; body?: GuidedBody }> = [];
  const product = { id: 7, name: "Tina", inventoryModel: "SEPARATE_VARIANTS", locationEvaluation: "PER_LOCATION", options: [
    { id: 9, catalogItemId: 417, label: "Ball Tina", optionValues: {}, sku: null, price: "12.00", active: true, isAvailable: true,
      inventoryItemId: 417, baseUnit: "each", consumptionQuantity: "3.5", complianceHold: false, complianceReason: null,
      inventoryStatus: "ready", balanceRowCount: 1, stockOnHand: "5", reservedQuantity: "0", availableQuantity: "5", orderable: true },
  ] };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input); const body = init?.body ? JSON.parse(String(init.body)) as GuidedBody : undefined; requests.push({ path, method: init?.method, body });
    if (path === "/api/admin/catalogue/products") return new Response(JSON.stringify({ products: [product] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/admin/catalogue/recommendations") return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/admin/catalogue/inventory/417/locations") return new Response(JSON.stringify({ locations: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/inventory-history-repair") && !init?.method) return new Response(JSON.stringify({ discrepancies: repaired ? [] : [{ inventoryItemId: 417, catalogItemId: 417, itemName: "Ball Tina", baseUnit: "each", locationId: 3, locationName: "CSR Sales Box 1", storedPhysicalQuantity: "5.000000", ledgerQuantity: "1.000000", bridgeQuantityDelta: "4.000000", costStatus: "unknown_baseline" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/inventory-history-repair/preview")) return new Response(JSON.stringify({ blockers: [], fingerprint: "a".repeat(64), verifiedAt: "2026-10-30T18:05:12.000Z",
      serverChecks: { reservations: { status: "clear", count: 0, message: "No active reservations block this history repair." }, openOrders: { status: "clear", count: 0, message: "No open order lines block this history repair." },
        costEvidence: { status: "unknown_explained", documentedCount: 0, unresolvedCount: 1, message: "1 inventory item(s) have an explained unknown cost; quantity history may be bridged but valuation will remain unknown." },
        freshness: { status: "current_at_generation", checkedAt: "2026-10-30T18:05:12.000Z", message: "Current when generated. Apply rechecks balances, ledger history, reservations, open orders, and valuation under a database lock; refresh after any inventory or order activity." } },
      recordedCostEvidence: [{ inventoryItemId: 417, catalogItemId: 417, status: "missing", receiptCount: 0, referencedReceiptCount: 0, recordedUnitCost: null,
        message: "No item-specific receipt cost is recorded; leave documented cost blank unless the source is first recorded through the authorized receipt workflow." }],
      unresolvedCosts: [{ inventoryItemId: 417, catalogItemId: 417, reason: body!.evidence![0].costBasisNote }], corrections: [{ ...body!.evidence![0], catalogItemId: 417, locationName: "CSR Sales Box 1", ledgerQuantity: "1.000000", bridgeQuantityDelta: "4.000000" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path.endsWith("/inventory-history-repair/apply")) { repaired = true; return new Response(JSON.stringify({ repairId: "00000000-0000-4000-8000-000000000001", movementIds: [99], idempotent: false }), { status: 201, headers: { "Content-Type": "application/json" } }); }
    return new Response(JSON.stringify({ error: "Unexpected request" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(AdminCatalogueProducts)));
  await vi.waitFor(() => expect(host?.textContent).toContain("Tina"));
  await act(async () => [...host!.querySelectorAll("button")].find(button => button.textContent?.includes("Tina"))!.click());
  await vi.waitFor(() => expect(host?.textContent).toContain("Required physical count to use this repair: 5.000000"));
  const enter = async (label: string, value: string) => { const input = host!.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement; await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
  }); };
  await enter("Verified count 417:3", "5");
  await enter("Count evidence 417:3", "Witnessed count sheet 2026-10-26");
  await enter("Cost evidence 417:3", "Historical invoice unavailable");
  await act(async () => [...host!.querySelectorAll("button")].find(button => button.textContent === "Preview exact ledger entries")!.click());
  await vi.waitFor(() => expect(host?.textContent).toContain("append 4.000000"));
  expect(host?.textContent).toContain("unit cost unknown");
  expect(host?.textContent).toContain("No active reservations block this history repair.");
  expect(host?.textContent).toContain("No open order lines block this history repair.");
  expect(host?.textContent).toContain("No item-specific receipt cost is recorded");
  expect(host?.textContent).toContain("Apply is disabled because:");
  expect(host?.textContent).toContain("Enter a repair reason of at least 10 characters");
  expect(host?.textContent).toContain("Confirm inventory #417 at CSR Sales Box 1");
  const confirm = host!.querySelector('section[aria-label="Guided inventory history repair"] input[type="checkbox"]') as HTMLInputElement;
  await act(async () => confirm.click());
  await enter("Inventory history repair reason", "Repair witnessed opening history");
  expect(host?.textContent).toContain("All Apply prerequisites are complete.");
  await act(async () => [...host!.querySelectorAll("button")].find(button => button.textContent === "Apply confirmed append-only repair")!.click());
  await vi.waitFor(() => expect(host?.textContent).toContain("Every active variant balance reconciles"));
  const apply = requests.find(request => request.path.endsWith("/inventory-history-repair/apply"));
  expect(apply?.body?.confirmedCorrections).toEqual([{ inventoryItemId: 417, locationId: 3, verifiedPhysicalQuantity: "5", bridgeQuantityDelta: "4.000000", documentedUnitCost: null }]);
  expect(apply?.body?.evidence?.[0]).toMatchObject({ documentedUnitCost: null, physicalCountNote: "Witnessed count sheet 2026-10-26", costBasisNote: "Historical invoice unavailable" });
});
