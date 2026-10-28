import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseVariantAxes, generateVariantCombinations } from "@/lib/variantCombinations";
import { useGetCurrentUser } from "@workspace/api-client-react";

type Option = { id: number; catalogItemId: number; label: string; optionValues: Record<string, string>; sku: string | null; barcode?: string | null; price: string; compareAtPrice?: string | null; active: boolean; isAvailable: boolean; inventoryItemId: number | null; baseUnit: string | null; consumptionQuantity: string; complianceHold: boolean; complianceReason: string | null; inventoryStatus: "ready" | "missing_identity" | "missing_balance"; balanceRowCount: number; stockOnHand: string | null; reservedQuantity: string | null; availableQuantity: string | null; orderable: boolean };
type Product = { id: number; name: string; inventoryModel: "SHARED" | "SEPARATE_VARIANTS"; locationEvaluation: "PER_LOCATION" | "COMBINED_LOCATIONS"; options: Option[] };
type Location = { locationId: number; name: string; quantityOnHand: string; par: string; reorderPoint: string; preferredReorderQuantity: string; moq: string };
type Recommendation = { inventoryItemId: number; productName: string; baseUnit: string; recommendations: Array<{ locationId: number; locationName: string; internalTransfers: Array<{ fromLocationId: number; quantity: string }>; externalPurchaseQuantity: string }> };
type InventoryPreview = { product: { id: number; name: string; inventoryModel: string; locationEvaluation: string }; target: { inventoryItemId?: number; create?: { name: string; baseUnit: string } }; targetUnit: string;
  variants: Array<{ optionId: number; label: string; optionValues: Record<string,string>; inventoryItemId: number; catalogItemId: number; inventoryCatalogItemId: number; baseUnit: string; consumptionQuantity: string; proposedConsumption: string; price: string; sku: string | null; barcode: string | null }>;
  reservations: Array<{ reservationId: number; catalogItemId: number; locationId: number; locationName: string; status: string; quantity: string; expiresAt: string; orderId: number; orderStatus: string }>;
  costs: Array<{ inventoryItemId: number; catalogItemId: number; baseUnit: string; onHand: string; costStatus: string; averageUnitCost: string | null; inventoryValue: string | null; reliable: boolean; convertedUnitCost: string | null }>;
  legacyHistory: Array<{ catalogItemId: number; locationId: number | null; transactionCount: number; netQuantityChange: string }>;
  locations: Array<{ locationId: number; locationName: string; sourceBalances: Array<{ catalogItemId: number; locationId: number; quantity: string; ledgerQuantity: string; movementCount: number }>; proposedSharedBalance: string }>;
  orderHistory: Array<{ optionId: number; orderLineCount: number }>; committed: Array<{ optionId: number; label: string; orderId: number; status: string; committedConsumption: string; orderLineCount: number }>;
  issues: string[]; costRequired: boolean; fingerprint: string };
type HistoryDiscrepancy = { inventoryItemId: number; catalogItemId: number; itemName: string; baseUnit: string; locationId: number; locationName: string;
  storedPhysicalQuantity: string; ledgerQuantity: string; bridgeQuantityDelta: string; costStatus: string };
type HistoryEvidence = { inventoryItemId: number; locationId: number; verifiedPhysicalQuantity: string; documentedUnitCost: string | null; physicalCountNote: string; costBasisNote: string };
type HistoryCorrection = HistoryEvidence & { catalogItemId: number; locationName: string; ledgerQuantity: string; bridgeQuantityDelta: string };
type HistoryRepairPreview = { blockers: string[]; blockingReservations: Array<{ reservationId: number; orderId: number; inventoryItemId: number; locationId: number; locationName: string; status: string; quantity: string; orderStatus: string }>; blockingOrders: Array<{ orderId: number; orderItemId: number; inventoryItemId: number; status: string; quantity: string }>; corrections: HistoryCorrection[]; unresolvedCosts: Array<{ inventoryItemId: number; catalogItemId: number; reason: string }>; fingerprint: string };

type ProductForm = { name: string; category: string; price: string; sku: string; firstOptionLabel: string;
  inventoryModel: Product["inventoryModel"]; locationEvaluation: Product["locationEvaluation"]; baseUnit: string; consumptionQuantity: string };
const defaultProduct: ProductForm = { name: "", category: "", price: "0.00", sku: "", firstOptionLabel: "Standard",
  inventoryModel: "SEPARATE_VARIANTS", locationEvaluation: "PER_LOCATION",
  baseUnit: "each", consumptionQuantity: "1.000000" };
const defaultOption = { label: "", optionValuesText: "", sku: "", barcode: "", price: "0.00", compareAtPrice: "", consumptionQuantity: "1.000000" };
const defaultCreationVariant = { label: "Standard", optionValuesText: "", sku: "", barcode: "", price: "0.00", compareAtPrice: "", consumptionQuantity: "1.000000", isAvailable: true };

function parseOptionValues(text: string): Record<string, string> {
  if (!text.trim()) return {};
  const entries = text.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf("=");
    if (separator < 1) throw new Error("Enter option values as Color=Red; Size=Medium");
    return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()] as const;
  });
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!key || !value || Object.hasOwn(result, key)) throw new Error("Option names and values must be non-empty and unique");
    result[key] = value;
  }
  return result;
}

function OptionEditor({ option, save, selectItem }: { option: Option; save: (value: Record<string, unknown>) => void; selectItem: (id: number) => void }) {
  const [value, setValue] = useState({ label: option.label, optionValuesText: Object.entries(option.optionValues ?? {}).map(([k, v]) => `${k}=${v}`).join("; "), sku: option.sku ?? "", barcode: option.barcode ?? "", price: option.price, compareAtPrice: option.compareAtPrice ?? "", consumptionQuantity: option.consumptionQuantity, isAvailable: option.isAvailable });
  useEffect(() => { setValue({ label: option.label, optionValuesText: Object.entries(option.optionValues ?? {}).map(([k, v]) => `${k}=${v}`).join("; "), sku: option.sku ?? "", barcode: option.barcode ?? "", price: option.price, compareAtPrice: option.compareAtPrice ?? "", consumptionQuantity: option.consumptionQuantity, isAvailable: option.isAvailable }); }, [option]);
  return <div className="grid gap-2 border-b py-3 md:grid-cols-4 text-sm">
    <label>Option<Input value={value.label} onChange={event => setValue({ ...value, label: event.target.value })} /></label>
    <label>Options<Input placeholder="Color=Red; Size=Medium" value={value.optionValuesText} onChange={event => setValue({ ...value, optionValuesText: event.target.value })} /></label>
    <label>SKU<Input value={value.sku} onChange={event => setValue({ ...value, sku: event.target.value })} /></label>
    <label>Barcode<Input value={value.barcode} onChange={event => setValue({ ...value, barcode: event.target.value })} /></label>
    <label>Price<Input value={value.price} onChange={event => setValue({ ...value, price: event.target.value })} /></label>
    <label>Compare-at price<Input value={value.compareAtPrice} onChange={event => setValue({ ...value, compareAtPrice: event.target.value })} /></label>
    <label>Consumption ({option.baseUnit ?? "unit not configured"})<Input value={value.consumptionQuantity} onChange={event => setValue({ ...value, consumptionQuantity: event.target.value })} /></label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={value.isAvailable} onChange={event => setValue({ ...value, isAvailable: event.target.checked })} /> Sellable</label>
    <div className="flex flex-col gap-1 justify-end"><Button size="sm" onClick={() => save({ ...value, compareAtPrice: value.compareAtPrice || null, optionValues: parseOptionValues(value.optionValuesText), active: option.active })}>Save option</Button>
      <Button size="sm" variant="outline" onClick={() => save({ active: !option.active })}>
        {option.active ? "Remove variant (keep history)" : "Enable variant"}
      </Button>
      {option.inventoryItemId == null
        ? <span className="text-destructive">Missing inventory identity — ordering blocked</span>
        : <button type="button" className="underline" onClick={() => selectItem(option.inventoryItemId!)}>Inventory item #{option.inventoryItemId}</button>}
      <span className={option.inventoryStatus === "ready" ? "text-muted-foreground" : "text-destructive"}>
        {option.inventoryStatus === "missing_balance" ? "No active sellable balance — ordering blocked"
          : option.inventoryStatus === "missing_identity" ? "Inventory setup incomplete"
            : `On hand ${option.stockOnHand}; reserved ${option.reservedQuantity}; available ${option.availableQuantity}`}
      </span></div>
  </div>;
}

function GuidedHistoryRepair({ productId, request, onApplied }: { productId: number; request: (path: string, init?: RequestInit) => Promise<unknown>; onApplied: () => Promise<void> }) {
  const [discrepancies, setDiscrepancies] = useState<HistoryDiscrepancy[]>([]);
  const [evidence, setEvidence] = useState<Record<string, { quantity: string; unitCost: string; countNote: string; costNote: string }>>({});
  const [preview, setPreview] = useState<HistoryRepairPreview | null>(null);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = (row: { inventoryItemId: number; locationId: number }) => `${row.inventoryItemId}:${row.locationId}`;
  const load = useCallback(async () => {
    setError(""); setPreview(null); setConfirmed({});
    try {
      const result = await request(`/api/admin/catalogue/products/${productId}/inventory-history-repair`) as { discrepancies: HistoryDiscrepancy[] };
      const found = result.discrepancies ?? [];
      setDiscrepancies(found);
      setEvidence(Object.fromEntries(found.map(row => [key(row), { quantity: "", unitCost: "", countNote: "", costNote: "" }])));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load history discrepancies"); }
  }, [productId, request]);
  useEffect(() => { void load(); }, [load]);
  const payloadEvidence = (): HistoryEvidence[] => discrepancies.map(row => {
    const value = evidence[key(row)];
    return { inventoryItemId: row.inventoryItemId, locationId: row.locationId, verifiedPhysicalQuantity: value?.quantity ?? "",
      documentedUnitCost: value?.unitCost ? value.unitCost : null, physicalCountNote: value?.countNote ?? "", costBasisNote: value?.costNote ?? "" };
  });
  async function createPreview() {
    setBusy(true); setError(""); setPreview(null); setConfirmed({});
    try {
      const result = await request(`/api/admin/catalogue/products/${productId}/inventory-history-repair/preview`, {
        method: "POST", body: JSON.stringify({ evidence: payloadEvidence() }),
      }) as HistoryRepairPreview;
      setPreview(result); setIdempotencyKey(crypto.randomUUID());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not preview history repair"); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const confirmedCorrections = preview.corrections.map(row => ({ inventoryItemId: row.inventoryItemId, locationId: row.locationId,
        verifiedPhysicalQuantity: row.verifiedPhysicalQuantity, bridgeQuantityDelta: row.bridgeQuantityDelta, documentedUnitCost: row.documentedUnitCost }));
      await request(`/api/admin/catalogue/products/${productId}/inventory-history-repair/apply`, { method: "POST", body: JSON.stringify({
        evidence: payloadEvidence(), previewFingerprint: preview.fingerprint, confirmedCorrections, idempotencyKey, reason,
      }) });
      await load(); await onApplied();
    } catch (cause) {
      setPreview(null); setConfirmed({});
      setError(`${cause instanceof Error ? cause.message : "History repair was not saved"} Refresh the preview after the blocking conditions are resolved.`);
    }
    finally { setBusy(false); }
  }
  if (!discrepancies.length && !error) return <section className="rounded border border-emerald-500/30 p-3"><h3 className="font-semibold">Inventory history</h3><p className="text-sm text-muted-foreground">Every active variant balance reconciles with its append-only ledger.</p></section>;
  return <section className="rounded border border-amber-500/40 p-3 space-y-3" aria-label="Guided inventory history repair">
    <div><h3 className="font-semibold">Guided inventory-history repair</h3><p className="text-sm text-muted-foreground">This appends an audited history bridge. It never edits balances or prior ledger entries. Physically count each location; do not copy the stored quantity unless the count independently verifies it.</p></div>
    {error && <div role="alert" className="rounded border border-red-500 p-2 text-sm">{error}</div>}
    {discrepancies.map(row => { const value = evidence[key(row)] ?? { quantity: "", unitCost: "", countNote: "", costNote: "" }; return <div key={key(row)} className="rounded border p-3 space-y-2">
      <p className="font-medium">{row.itemName} · inventory #{row.inventoryItemId} · {row.locationName}</p>
      <p className="text-xs">Stored balance {row.storedPhysicalQuantity} {row.baseUnit}; ledger {row.ledgerQuantity}; proposed bridge after verification {row.bridgeQuantityDelta}.</p>
      <p className="text-xs font-medium text-amber-600">Required physical count to use this repair: {row.storedPhysicalQuantity}. If the actual count differs, use the normal audited adjustment flow first and refresh.</p>
      <div className="grid gap-2 md:grid-cols-2"><label>Verified physical count<Input aria-label={`Verified count ${key(row)}`} value={value.quantity} onChange={event => { setPreview(null); setConfirmed({}); setEvidence(current => ({ ...current, [key(row)]: { ...value, quantity: event.target.value } })); }} /></label>
        <label>Physical-count evidence<Input aria-label={`Count evidence ${key(row)}`} value={value.countNote} onChange={event => { setPreview(null); setConfirmed({}); setEvidence(current => ({ ...current, [key(row)]: { ...value, countNote: event.target.value } })); }} placeholder="Count sheet, witness, date, or reference" /></label>
        <label>Documented unit cost (optional)<Input aria-label={`Documented cost ${key(row)}`} value={value.unitCost} onChange={event => { setPreview(null); setConfirmed({}); setEvidence(current => ({ ...current, [key(row)]: { ...value, unitCost: event.target.value } })); }} /></label>
        <label>Cost evidence or why unknown<Input aria-label={`Cost evidence ${key(row)}`} value={value.costNote} onChange={event => { setPreview(null); setConfirmed({}); setEvidence(current => ({ ...current, [key(row)]: { ...value, costNote: event.target.value } })); }} placeholder="Invoice/reference, or explain why cost remains unknown" /></label></div>
    </div>; })}
    <Button disabled={busy || !discrepancies.length} onClick={() => void createPreview()}>{busy ? "Working…" : "Preview exact ledger entries"}</Button>
    {preview && <div className="space-y-3 rounded bg-muted/30 p-3"><h4 className="font-medium">Reviewed preview</h4>
      {preview.blockers.length > 0 && <div role="alert"><strong>Blocking issues</strong><ul>{preview.blockers.map(item => <li key={item}>{item}</li>)}</ul>
        {preview.blockingReservations.length > 0 && <div className="mt-2"><strong>Reservations to resolve through the order workflow</strong><ul>{preview.blockingReservations.map(row => <li key={row.reservationId}>Reservation #{row.reservationId}, order #{row.orderId}: {row.status} {row.quantity} at {row.locationName} (location #{row.locationId}); order is {row.orderStatus}. Complete fulfillment or cancel/void the order through its normal workflow so its reservation resolves; do not release it manually.</li>)}</ul></div>}
        {preview.blockingOrders.length > 0 && <div className="mt-2"><strong>Open committed order lines</strong><ul>{preview.blockingOrders.map(row => <li key={row.orderItemId}>Order #{row.orderId}, line #{row.orderItemId}: {row.status}, inventory item #{row.inventoryItemId}, quantity {row.quantity}. Complete fulfillment or cancel/void the order through its normal workflow.</li>)}</ul></div>}
      </div>}
      {preview.corrections.map(row => <label key={key(row)} className="block rounded border p-2 text-sm"><span className="flex items-start gap-2"><input type="checkbox" checked={Boolean(confirmed[key(row)])} onChange={event => setConfirmed(current => ({ ...current, [key(row)]: event.target.checked }))} />
        <span>Confirm inventory #{row.inventoryItemId}, {row.locationName}: append {row.bridgeQuantityDelta}; ledger {row.ledgerQuantity} → {row.verifiedPhysicalQuantity}; unit cost {row.documentedUnitCost ?? "unknown"}. Evidence: {row.physicalCountNote}; cost source/status: {row.costBasisNote}.</span></span></label>)}
      {preview.unresolvedCosts.length > 0 && <p className="text-sm font-medium text-amber-600">Quantity history can be repaired, but valuation remains unknown for inventory item(s) {preview.unresolvedCosts.map(row => `#${row.inventoryItemId}`).join(", ")}.</p>}
      <label>Repair reason<Input aria-label="Inventory history repair reason" value={reason} onChange={event => setReason(event.target.value)} /></label>
      <Button disabled={busy || preview.blockers.length > 0 || reason.trim().length < 10 || preview.corrections.some(row => !confirmed[key(row)])} onClick={() => void apply()}>Apply confirmed append-only repair</Button>
    </div>}
  </section>;
}

export default function AdminCatalogueProducts() {
  const { getToken } = useAuth();
  const { data: currentUser } = useGetCurrentUser();
  const isGlobalAdmin = currentUser?.role === "global_admin";
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [create, setCreate] = useState(defaultProduct);
  const [creationVariants, setCreationVariants] = useState([defaultCreationVariant]);
  const [newOption, setNewOption] = useState(defaultOption);
  const [combinationText, setCombinationText] = useState("");
  const [editName, setEditName] = useState("");
  const [editBaseUnit, setEditBaseUnit] = useState("");
  const [message, setMessage] = useState("");
  const [complianceReason, setComplianceReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [inventoryModelDraft, setInventoryModelDraft] = useState<Product["inventoryModel"]>("SEPARATE_VARIANTS");
  const [reconcileTarget, setReconcileTarget] = useState<string>("");
  const [createSharedItem, setCreateSharedItem] = useState(false);
  const [sharedItemName, setSharedItemName] = useState("");
  const [sharedBaseUnit, setSharedBaseUnit] = useState("each");
  const [reconcileReason, setReconcileReason] = useState("");
  const [manualUnitCost, setManualUnitCost] = useState("");
  const [costBasisNote, setCostBasisNote] = useState("");
  const [preview, setPreview] = useState<InventoryPreview | null>(null);
  const [confirmReconciliation, setConfirmReconciliation] = useState(false);
  const selected = products.find(product => product.id === selectedId);
  const selectedIdValue = selected?.id;
  const selectedName = selected?.name ?? "";
  const selectedInventoryModel = selected?.inventoryModel;
  const firstActiveOption = selected?.options.find(option => option.active);
  const selectedItemBaseUnit = selected?.options.find(option => option.inventoryItemId === selectedItemId)?.baseUnit ?? "";
  useEffect(() => { setEditName(selectedName); setInventoryModelDraft(selectedInventoryModel ?? "SEPARATE_VARIANTS");
    setPreview(null); setConfirmReconciliation(false); setReconcileTarget(String(firstActiveOption?.inventoryItemId ?? ""));
    setSharedBaseUnit(firstActiveOption?.baseUnit ?? "each"); setSharedItemName(selectedName ? `${selectedName} shared inventory` : "");
  }, [selectedIdValue, selectedName, selectedInventoryModel, firstActiveOption?.inventoryItemId, firstActiveOption?.baseUnit]);
  useEffect(() => { setEditBaseUnit(selectedItemBaseUnit); }, [selectedItemBaseUnit]);

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const token = await getToken();
    const headers = new Headers(init?.headers);
    headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(path, { ...init, headers });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
  }, [getToken]);
  const refresh = useCallback(async () => {
    const [catalogue, recs] = await Promise.all([
      request("/api/admin/catalogue/products") as Promise<{ products: Product[] }>,
      request("/api/admin/catalogue/recommendations") as Promise<{ items: Recommendation[] }>,
    ]);
    setProducts(catalogue.products);
    setRecommendations(recs.items);
  }, [request]);
  useEffect(() => { void refresh().catch(error => setMessage(error.message)); }, [refresh]);
  useEffect(() => {
    const catalogItemId = Number(new URLSearchParams(window.location.search).get("catalogItemId"));
    if (!Number.isSafeInteger(catalogItemId) || catalogItemId <= 0) return;
    const product = products.find(candidate => candidate.options.some(option => option.catalogItemId === catalogItemId));
    const option = product?.options.find(candidate => candidate.catalogItemId === catalogItemId);
    if (product && option) { setSelectedId(product.id); setSelectedItemId(option.inventoryItemId); }
  }, [products]);
  useEffect(() => {
    if (!selectedItemId) { setLocations([]); return; }
    void (request(`/api/admin/catalogue/inventory/${selectedItemId}/locations`) as Promise<{ locations: Location[] }>)
      .then(result => setLocations(result.locations)).catch(error => setMessage(error.message));
  }, [request, selectedItemId]);

  async function perform(action: () => Promise<void>, successMessage = "Saved") {
    setBusy(true); setMessage("");
    try { await action(); await refresh(); setMessage(successMessage); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Save failed"); }
    finally { setBusy(false); }
  }
  const reconciliationTarget = () => createSharedItem
    ? { create: { name: sharedItemName.trim(), baseUnit: sharedBaseUnit.trim() } }
    : { inventoryItemId: Number(reconcileTarget) };
  async function loadReconciliationPreview() {
    if (!selected) return;
    setBusy(true); setMessage(""); setPreview(null); setConfirmReconciliation(false);
    try {
      const data = await request(`/api/admin/catalogue/products/${selected.id}/inventory-reconciliation/preview`, {
        method: "POST", body: JSON.stringify({ target: reconciliationTarget() }),
      }) as InventoryPreview;
      setPreview(data);
      setMessage(data.issues.length ? "Preview loaded with blocking issues. Resolve them before reconciliation." : "Preview ready. Review every balance and valuation before confirming.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not load inventory preview"); }
    finally { setBusy(false); }
  }
  async function applyInventoryReconciliation() {
    if (!selected || !preview || !confirmReconciliation || preview.issues.length || !reconcileReason.trim()) return;
    setBusy(true); setMessage("");
    try {
      const result = await request(`/api/admin/catalogue/products/${selected.id}/inventory-reconciliation/apply`, {
        method: "POST", body: JSON.stringify({ target: reconciliationTarget(), previewFingerprint: preview.fingerprint,
          confirmPreview: true, idempotencyKey: crypto.randomUUID(), reason: reconcileReason.trim(),
          ...(manualUnitCost ? { manualUnitCost, costBasisNote } : {}) }),
      }) as { reconciliationId: string; targetInventoryItemId: number };
      await refresh(); setInventoryModelDraft("SHARED"); setPreview(null); setConfirmReconciliation(false);
      setMessage(`Inventory reconciled successfully. Shared inventory item #${result.targetInventoryItemId}; audit record ${result.reconciliationId}.`);
    } catch (error) {
      setMessage(error instanceof Error ? `Reconciliation was not saved: ${error.message}` : "Reconciliation was not saved.");
    } finally { setBusy(false); }
  }
  const updateLocation = (locationId: number, key: keyof Location, value: string) =>
    setLocations(current => current.map(location => location.locationId === locationId ? { ...location, [key]: value } : location));

  return <div className="space-y-6 max-w-6xl mx-auto p-4" data-testid="catalogue-products-admin">
    <header><h1 className="text-2xl font-bold">Products, options and reorder</h1>
      <p className="text-sm text-muted-foreground">Set physical quantities by location. Replenishment suggestions do not place purchases.</p></header>
    {message && <div role="status" className="rounded-lg border p-3 text-sm">{message}</div>}
    <section className="rounded-xl border p-4 space-y-3">
      <h2 className="font-semibold">Create product</h2>
      <div className="grid gap-2 md:grid-cols-4">
        <label>Name<Input value={create.name} onChange={event => setCreate({ ...create, name: event.target.value })} /></label>
        <label>Category<Input value={create.category} onChange={event => setCreate({ ...create, category: event.target.value })} /></label>
        <label>Base unit<Input value={create.baseUnit} onChange={event => setCreate({ ...create, baseUnit: event.target.value })} /></label>
        <label>Inventory model<select className="block w-full rounded border bg-background p-2" value={create.inventoryModel} onChange={event => setCreate({ ...create, inventoryModel: event.target.value as typeof create.inventoryModel })}>
          <option>SEPARATE_VARIANTS</option><option>SHARED</option></select></label>
        <label>Location evaluation<select className="block w-full rounded border bg-background p-2" value={create.locationEvaluation} onChange={event => setCreate({ ...create, locationEvaluation: event.target.value as typeof create.locationEvaluation })}>
          <option>PER_LOCATION</option><option>COMBINED_LOCATIONS</option></select></label>
      </div>
      <div className="space-y-2 rounded border p-3">
        <div className="flex items-center justify-between"><h3 className="font-medium">Variants and quantity consumption</h3>
          <Button type="button" variant="outline" disabled={busy || creationVariants.length >= 100} onClick={() => setCreationVariants(current => [...current, { ...defaultCreationVariant, label: `Variant ${current.length + 1}` }])}>Add variant</Button></div>
        <p className="text-xs text-muted-foreground">Each variant keeps its own price, SKU, barcode, option values and quantity consumed. Shared variants use one inventory item from creation.</p>
        {creationVariants.map((variant, index) => <div key={index} className="grid gap-2 border-t py-2 md:grid-cols-4">
          <label>Variant label<Input value={variant.label} onChange={event => setCreationVariants(current => current.map((v,i)=>i===index?{...v,label:event.target.value}:v))} /></label>
          <label>Option values<Input placeholder="Size=Large; Color=Black" value={variant.optionValuesText} onChange={event => setCreationVariants(current => current.map((v,i)=>i===index?{...v,optionValuesText:event.target.value}:v))} /></label>
          <label>SKU<Input value={variant.sku} onChange={event => setCreationVariants(current => current.map((v,i)=>i===index?{...v,sku:event.target.value}:v))} /></label>
          <label>Barcode<Input value={variant.barcode} onChange={event => setCreationVariants(current => current.map((v,i)=>i===index?{...v,barcode:event.target.value}:v))} /></label>
          <label>Price<Input value={variant.price} onChange={event => setCreationVariants(current => current.map((v,i)=>i===index?{...v,price:event.target.value}:v))} /></label>
          <label>Compare-at price<Input value={variant.compareAtPrice} onChange={event => setCreationVariants(current => current.map((v,i)=>i===index?{...v,compareAtPrice:event.target.value}:v))} /></label>
          <label>Consumption ({create.baseUnit})<Input value={variant.consumptionQuantity} onChange={event => setCreationVariants(current => current.map((v,i)=>i===index?{...v,consumptionQuantity:event.target.value}:v))} /></label>
          <label className="flex items-center gap-2 self-end"><input type="checkbox" checked={variant.isAvailable} onChange={event => setCreationVariants(current => current.map((v,i)=>i===index?{...v,isAvailable:event.target.checked}:v))} />Sellable</label>
          {creationVariants.length > 1 && <Button type="button" variant="outline" className="self-end" onClick={() => setCreationVariants(current => current.filter((_,i)=>i!==index))}>Remove variant</Button>}
        </div>)}
      </div>
      <Button disabled={busy} onClick={() => void perform(async () => {
        const variants = creationVariants.map(variant => ({ label: variant.label, optionValues: parseOptionValues(variant.optionValuesText),
          sku: variant.sku || null, barcode: variant.barcode || null, price: variant.price,
          compareAtPrice: variant.compareAtPrice || null, consumptionQuantity: variant.consumptionQuantity, isAvailable: variant.isAvailable }));
        const result = await request("/api/admin/catalogue/products", { method: "POST", body: JSON.stringify({
          name: create.name, category: create.category || undefined, inventoryModel: create.inventoryModel,
          locationEvaluation: create.locationEvaluation, baseUnit: create.baseUnit, variants,
        }) }) as { productId: number };
        setSelectedId(result.productId); setCreate(defaultProduct); setCreationVariants([defaultCreationVariant]);
      }, "Product and variants created successfully.")}>Create product</Button>
    </section>
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <aside className="rounded-xl border p-3 space-y-1"><h2 className="font-semibold mb-2">Products</h2>
        {products.map(product => <button key={product.id} type="button" onClick={() => { setSelectedId(product.id); setSelectedItemId(product.options[0]?.inventoryItemId ?? null); }}
          className={`block w-full rounded p-2 text-left text-sm ${product.id === selectedId ? "bg-primary/15" : "hover:bg-muted"}`}>
          {product.name}<span className="block text-xs text-muted-foreground">{product.options.length} option{product.options.length === 1 ? "" : "s"}</span>
        </button>)}</aside>
      {selected && <main className="space-y-5">
        {selected.inventoryModel === "SEPARATE_VARIANTS" && <GuidedHistoryRepair productId={selected.id} request={request} onApplied={refresh} />}
        <section className="rounded-xl border p-4 space-y-3">
          <h2 className="font-semibold">{selected.name}</h2>
          <div className="flex gap-2"><label className="flex-1">Product name<Input value={editName} onChange={event => setEditName(event.target.value)} /></label>
            <Button className="self-end" disabled={busy} onClick={() => void perform(async () => {
              await request(`/api/admin/catalogue/products/${selected.id}`, { method: "PATCH", body: JSON.stringify({ name: editName }) });
            })}>Save name</Button></div>
          <div className="grid gap-2 md:grid-cols-2">
            <label>Inventory model<select className="block w-full rounded border bg-background p-2" value={inventoryModelDraft}
              onChange={event => {
                setInventoryModelDraft(event.target.value as Product["inventoryModel"]); setPreview(null); setConfirmReconciliation(false);
              }}>
              <option>SEPARATE_VARIANTS</option><option>SHARED</option></select>
              <Button className="mt-2" size="sm" disabled={busy || inventoryModelDraft === selected.inventoryModel}
                onClick={() => void perform(async () => {
                  await request(`/api/admin/catalogue/products/${selected.id}`, { method: "PATCH", body: JSON.stringify({ inventoryModel: inventoryModelDraft }) });
                }, "Inventory model saved.")}>Save inventory model</Button></label>
            <label>Location evaluation<select className="block w-full rounded border bg-background p-2" value={selected.locationEvaluation}
              onChange={event => void perform(async () => { await request(`/api/admin/catalogue/products/${selected.id}`, { method: "PATCH", body: JSON.stringify({ locationEvaluation: event.target.value }) }); })}>
              <option>PER_LOCATION</option><option>COMBINED_LOCATIONS</option></select></label>
          </div>
          <p className="text-xs text-muted-foreground">Changing an active inventory model with balances, reservations, orders or movements requires controlled reconciliation.</p>
          {selected.inventoryModel === "SEPARATE_VARIANTS" && inventoryModelDraft === "SHARED" && <div className="rounded border p-3 space-y-3" aria-label="Inventory reconciliation">
            <h3 className="font-semibold">Reconcile inventory</h3>
            <p className="text-sm text-muted-foreground">Selecting Shared does not change stock. Review a server-generated preview and confirm the audited reconciliation before variants are linked.</p>
            <div className="grid gap-2 md:grid-cols-3">
              <label>Shared inventory item<select className="block w-full rounded border bg-background p-2" value={createSharedItem ? "create" : reconcileTarget} onChange={event => {
                setCreateSharedItem(event.target.value === "create"); if (event.target.value !== "create") setReconcileTarget(event.target.value); setPreview(null);
              }}>
                {Array.from(new Set(selected.options.filter(o => o.active && o.inventoryItemId != null).map(o => o.inventoryItemId as number))).map(itemId => <option key={itemId} value={itemId}>Use inventory item #{itemId}</option>)}
                <option value="create">Create a new shared item</option>
              </select></label>
              {createSharedItem && <><label>New shared item name<Input value={sharedItemName} onChange={event => { setSharedItemName(event.target.value); setPreview(null); }} /></label>
                <label>Shared base unit<Input value={sharedBaseUnit} onChange={event => { setSharedBaseUnit(event.target.value); setPreview(null); }} /></label></>}
            </div>
            <Button disabled={busy || (!createSharedItem && !reconcileTarget) || (createSharedItem && (!sharedItemName.trim() || !sharedBaseUnit.trim()))} onClick={() => void loadReconciliationPreview()}>Reconcile inventory · preview</Button>
            {preview && <div className="space-y-3 rounded bg-muted/30 p-3 text-sm">
              <h4 className="font-medium">Preview · proposed base unit: {preview.targetUnit}</h4>
              <p>Product #{preview.product.id} · location evaluation remains <strong>{preview.product.locationEvaluation}</strong>.</p>
              <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th>Variant / option ID</th><th>Inventory item ID</th><th>Catalog item ID</th><th>Base unit → shared</th><th>Consumption</th><th>Retail price</th></tr></thead><tbody>
                {preview.variants.map(v => <tr key={v.optionId} className="border-t"><td>{v.label} · #{v.optionId}</td><td>#{v.inventoryItemId}</td><td>#{v.catalogItemId}</td><td>{v.baseUnit} → {preview.targetUnit}</td><td>{v.consumptionQuantity} → {v.proposedConsumption} {preview.targetUnit}</td><td>{v.price}</td></tr>)}
              </tbody></table></div>
              {preview.locations.map(location => <div key={location.locationId} className="rounded border p-2">
                <strong>{location.locationName} · proposed shared balance {location.proposedSharedBalance} {preview.targetUnit}</strong>
                <ul>{location.sourceBalances.map(b => { const v = preview.variants.find(row => row.inventoryCatalogItemId === b.catalogItemId); return <li key={b.catalogItemId}>Inventory item #{v?.inventoryItemId} / catalog item #{b.catalogItemId}: on hand {b.quantity}; ledger {b.ledgerQuantity}; movements {b.movementCount}</li>; })}</ul>
              </div>)}
              <div><strong>Valuation</strong><ul>{preview.costs.map(cost => <li key={cost.inventoryItemId}>Inventory item #{cost.inventoryItemId}: {cost.onHand} {cost.baseUnit}; {cost.reliable ? `recorded ${cost.averageUnitCost} per ${cost.baseUnit} (${cost.convertedUnitCost} per ${preview.targetUnit}), inventory value ${cost.inventoryValue}` : `cost ${cost.costStatus}; documented cost required`}</li>)}</ul>
                {preview.costRequired && <p>A positive documented unit cost in the shared base unit is required. Retail prices are not inventory cost.</p>}</div>
              {preview.legacyHistory.length > 0 && <div><strong>Legacy inventory history</strong><ul>{preview.legacyHistory.map((row,index) => <li key={`${row.catalogItemId}:${row.locationId}:${index}`}>Catalog item #{row.catalogItemId}, location #{row.locationId ?? "unknown"}: {row.transactionCount} historical transactions; net recorded change {row.netQuantityChange}.</li>)}</ul></div>}
              <div><strong>Reservations and committed stock</strong>{preview.reservations.length ? <><ul>{preview.reservations.map(r => <li key={r.reservationId}>Reservation #{r.reservationId}: {r.status} {r.quantity} at {r.locationName} (location #{r.locationId}), order #{r.orderId} ({r.orderStatus}). Complete fulfillment or cancel/void the order through the normal order workflow so its reservation resolves; do not release it manually.</li>)}</ul></> : <p>No active reservations.</p>}
                {preview.committed.length > 0 && <ul>{preview.committed.map((row,index) => <li key={`${row.optionId}:${row.orderId}:${index}`}>{row.status} order #{row.orderId}, {row.label}: {row.committedConsumption} committed consumption</li>)}</ul>}
                <p>Historical order lines retained: {preview.orderHistory.reduce((sum,row) => sum + row.orderLineCount, 0)}.</p></div>
              {preview.issues.length > 0 && <div role="alert" className="rounded border border-red-500 p-2"><strong>Blocking issues</strong><ul>{preview.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
              <label>Reconciliation reason<Input value={reconcileReason} onChange={event => setReconcileReason(event.target.value)} maxLength={500} /></label>
              {preview.costRequired && <div className="grid gap-2 md:grid-cols-2"><label>Verified positive unit cost · {preview.targetUnit}<Input inputMode="decimal" value={manualUnitCost} onChange={event => setManualUnitCost(event.target.value)} /></label><label>Cost source / documentation note<Input value={costBasisNote} onChange={event => setCostBasisNote(event.target.value)} maxLength={500} /></label></div>}
              <label className="flex items-start gap-2"><input type="checkbox" checked={confirmReconciliation} onChange={event => setConfirmReconciliation(event.target.checked)} />I reviewed the inventory balances, conversions, reservations, valuation, and discrepancies, and authorize this reconciliation.</label>
              <Button disabled={busy || preview.issues.length > 0 || !confirmReconciliation || reconcileReason.trim().length < 10 || (preview.costRequired && (!manualUnitCost || costBasisNote.trim().length < 8))} onClick={() => void applyInventoryReconciliation()}>Confirm and reconcile inventory</Button>
            </div>}
          </div>}
        </section>
        <section className={`rounded-xl border p-4 space-y-3 ${selected.options.some(option => option.complianceHold) ? "border-orange-500/60 bg-orange-500/5" : ""}`} aria-label="Catalogue item compliance hold">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold">Compliance Hold</h2>
              {selected.options.some(option => option.complianceHold) ? <p className="text-sm text-orange-300">COMPLIANCE HOLD · {selected.options.find(option => option.complianceHold)?.complianceReason || "Reason recorded"}</p> : <p className="text-sm text-muted-foreground">No compliance hold is active on this item or its variants.</p>}
            </div>
            {isGlobalAdmin && <Button variant={selected.options.some(option => option.complianceHold) ? "destructive" : "outline"}
              disabled={busy || !complianceReason.trim() || selected.options.length === 0}
              onClick={() => void perform(async () => {
                const held = selected.options.some(option => option.complianceHold);
                const target = selected.options.find(option => held ? option.complianceHold : true)!;
                await request(`/api/admin/product-master/${target.catalogItemId}/lifecycle`, { method: "PATCH", body: JSON.stringify({ complianceHold: !held, reason: complianceReason.trim() }) });
                setComplianceReason("");
              })}>{selected.options.some(option => option.complianceHold) ? "Release hold" : "Place hold"}</Button>}
          </div>
          {isGlobalAdmin && <label className="block max-w-xl text-sm">{selected.options.some(option => option.complianceHold) ? "Release / audit reason" : "Required hold reason"}<Input value={complianceReason} onChange={event => setComplianceReason(event.target.value)} maxLength={500} placeholder="Enter the reason for this compliance action" aria-label="Compliance action reason" /></label>}
          {!isGlobalAdmin && selected.options.some(option => option.complianceHold) && <p className="text-xs text-muted-foreground">Only a Global Admin can change compliance hold status.</p>}
        </section>
        <section className="rounded-xl border p-4 space-y-3"><h2 className="font-semibold">Options / variants</h2>
          {selected.options.length === 0 && <p className="text-sm text-destructive">No variants or inventory identity are configured. Ordering is blocked until setup is repaired.</p>}
          {selected.options.map(option => <OptionEditor key={option.id} option={option} selectItem={setSelectedItemId}
            save={value => void perform(async () => {
              const patch = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "optionValuesText"));
              await request(`/api/admin/catalogue/options/${option.id}`, { method: "PATCH", body: JSON.stringify(patch) });
            })} />)}
          <div className="grid gap-2 rounded border p-3 md:grid-cols-[1fr_auto]">
            <label>Generate option combinations<Input placeholder="Color=Red,Blue; Size=S,M" value={combinationText} onChange={event => setCombinationText(event.target.value)} /></label>
            <Button className="self-end" disabled={busy || !combinationText.trim()} onClick={() => void perform(async () => {
              const combinations = generateVariantCombinations(parseVariantAxes(combinationText));
              for (const optionValues of combinations) {
                const label = Object.entries(optionValues).map(([key, value]) => `${key}: ${value}`).join(" / ");
                await request(`/api/admin/catalogue/products/${selected.id}/options`, { method: "POST", body: JSON.stringify({
                  label, optionValues, sku: null, barcode: null, price: newOption.price,
                  compareAtPrice: newOption.compareAtPrice || null, consumptionQuantity: newOption.consumptionQuantity,
                }) });
              }
              setCombinationText("");
            })}>Generate variants</Button>
            <p className="text-xs text-muted-foreground md:col-span-2">Creates each purchasable combination with its own stable variant and inventory identity. Set SKU, barcode and price per variant below.</p>
          </div>
          <div className="grid gap-2 md:grid-cols-4">
            <label>Variant label<Input value={newOption.label} onChange={event => setNewOption({ ...newOption, label: event.target.value })} /></label>
            <label>Options<Input placeholder="Color=Red; Size=Medium" value={newOption.optionValuesText} onChange={event => setNewOption({ ...newOption, optionValuesText: event.target.value })} /></label>
            <label>SKU<Input value={newOption.sku} onChange={event => setNewOption({ ...newOption, sku: event.target.value })} /></label>
            <label>Barcode<Input value={newOption.barcode} onChange={event => setNewOption({ ...newOption, barcode: event.target.value })} /></label>
            <label>Price<Input value={newOption.price} onChange={event => setNewOption({ ...newOption, price: event.target.value })} /></label>
            <label>Compare-at price<Input value={newOption.compareAtPrice} onChange={event => setNewOption({ ...newOption, compareAtPrice: event.target.value })} /></label>
            <label>Consumption ({selected.options[0]?.baseUnit ?? "unit"})<Input value={newOption.consumptionQuantity} onChange={event => setNewOption({ ...newOption, consumptionQuantity: event.target.value })} /></label>
          </div>
          <Button disabled={busy} onClick={() => void perform(async () => {
            const { optionValuesText, compareAtPrice, ...variant } = newOption;
            await request(`/api/admin/catalogue/products/${selected.id}/options`, { method: "POST", body: JSON.stringify({ ...variant, optionValues: parseOptionValues(optionValuesText), compareAtPrice: compareAtPrice || null }) });
            setNewOption(defaultOption);
          })}>Add option</Button>
        </section>
        {selectedItemId && <section className="rounded-xl border p-4 space-y-3"><h2 className="font-semibold">Inventory item #{selectedItemId} by location</h2>
          <div className="flex gap-2"><label>Base unit<Input value={editBaseUnit} onChange={event => setEditBaseUnit(event.target.value)} /></label>
            <Button className="self-end" disabled={busy} onClick={() => void perform(async () => {
              await request(`/api/admin/catalogue/inventory/${selectedItemId}`, { method: "PATCH", body: JSON.stringify({ baseUnit: editBaseUnit }) });
            })}>Save unit</Button></div>
          {locations.map(location => <div key={location.locationId} className="grid gap-2 border-b py-3 md:grid-cols-6">
            <strong className="text-sm">{location.name}</strong>
            {(["quantityOnHand", "par", "reorderPoint", "preferredReorderQuantity", "moq"] as const).map(key =>
              <label key={key} className="text-xs">{{ quantityOnHand: "On hand", par: "PAR", reorderPoint: "Reorder point", preferredReorderQuantity: "Preferred order", moq: "MOQ" }[key]}
                <Input value={location[key]} onChange={event => updateLocation(location.locationId, key, event.target.value)} /></label>)}
            <div className="md:col-span-6"><Button size="sm" disabled={busy} onClick={() => void perform(async () => {
              await request(`/api/admin/catalogue/inventory/${selectedItemId}/locations/${location.locationId}/policy`, { method: "PUT", body: JSON.stringify({ par: location.par, reorderPoint: location.reorderPoint, preferredReorderQuantity: location.preferredReorderQuantity, moq: location.moq }) });
              await request(`/api/admin/catalogue/inventory/${selectedItemId}/locations/${location.locationId}/balance`, { method: "PUT", body: JSON.stringify({ quantityOnHand: location.quantityOnHand }) });
            })}>Save location</Button></div>
          </div>)}
        </section>}
      </main>}
    </div>
    <section className="rounded-xl border p-4 space-y-3"><h2 className="font-semibold">Replenishment recommendations</h2>
      <p className="text-xs text-muted-foreground">Suggestions only. No inventory transfer or purchase has been created.</p>
      {recommendations.flatMap(item => item.recommendations.filter(rec => rec.internalTransfers.length || rec.externalPurchaseQuantity !== "0.000000")
        .map(rec => <div key={`${item.inventoryItemId}-${rec.locationId}`} className="border-b py-2 text-sm space-y-1">
          <strong>{item.productName}</strong> · {rec.locationName} · inventory item #{item.inventoryItemId}
          {rec.internalTransfers.map(transfer => <div key={transfer.fromLocationId}>
            Suggested internal transfer: {item.recommendations.find(source => source.locationId === transfer.fromLocationId)?.locationName ?? `location #${transfer.fromLocationId}`} → {rec.locationName} · {transfer.quantity} {item.baseUnit}
          </div>)}
          {rec.externalPurchaseQuantity !== "0.000000" && <div>
            Suggested external purchase: {rec.externalPurchaseQuantity} {item.baseUnit}
          </div>}
        </div>))}
    </section>
  </div>;
}
