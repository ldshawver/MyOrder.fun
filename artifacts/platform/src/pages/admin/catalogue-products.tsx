import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseVariantAxes, generateVariantCombinations } from "@/lib/variantCombinations";
import { useGetCurrentUser } from "@workspace/api-client-react";

type SpecialComponentRow = { catalogItemId: number; productName: string; label: string; quantity: string };
type Option = { id: number; catalogItemId: number; label: string; optionValues: Record<string, string>; sku: string | null; barcode?: string | null; price: string; compareAtPrice?: string | null; employeePrice?: string | null; active: boolean; isAvailable: boolean; inventoryItemId: number | null; baseUnit: string | null; consumptionQuantity: string; complianceHold: boolean; complianceReason: string | null; inventoryStatus: "ready" | "missing_identity" | "missing_balance"; balanceRowCount: number; stockOnHand: string | null; reservedQuantity: string | null; availableQuantity: string | null; orderable: boolean; components?: SpecialComponentRow[]; specialOrderable?: boolean; specialAvailableQuantity?: string | null };
type Product = { id: number; name: string; inventoryModel: "SHARED" | "SEPARATE_VARIANTS"; locationEvaluation: "PER_LOCATION" | "COMBINED_LOCATIONS"; options: Option[] };
type Location = { locationId: number; name: string; quantityOnHand: string; par: string; reorderPoint: string; preferredReorderQuantity: string; moq: string };
type Recommendation = { inventoryItemId: number; productName: string; baseUnit: string; recommendations: Array<{ locationId: number; locationName: string; internalTransfers: Array<{ fromLocationId: number; quantity: string }>; externalPurchaseQuantity: string }> };
type InventoryPreview = { product: { id: number; name: string; inventoryModel: string; locationEvaluation: string }; target: { inventoryItemId?: number; create?: { name: string; baseUnit: string } }; targetUnit: string;
  variants: Array<{ optionId: number; label: string; optionValues: Record<string,string>; inventoryItemId: number; catalogItemId: number; inventoryCatalogItemId: number; baseUnit: string; consumptionQuantity: string; sourceUnitQuantityInTargetUnit: string; proposedConsumption: string; price: string; sku: string | null; barcode: string | null }>;
  reservations: Array<{ reservationId: number; catalogItemId: number; locationId: number; locationName: string; status: string; quantity: string; expiresAt: string; orderId: number; orderStatus: string }>;
  historyBridges: Array<{ inventoryItemId: number; locationId: number; locationName: string; ledgerQuantity: string; physicalQuantity: string; bridgeQuantityDelta: string }>;
  costs: Array<{ inventoryItemId: number; catalogItemId: number; baseUnit: string; onHand: string; costStatus: string; averageUnitCost: string | null; inventoryValue: string | null; reliable: boolean; convertedUnitCost: string | null }>;
  legacyHistory: Array<{ catalogItemId: number; locationId: number | null; transactionCount: number; netQuantityChange: string }>;
  locations: Array<{ locationId: number; locationName: string; sourceBalances: Array<{ catalogItemId: number; locationId: number; quantity: string; ledgerQuantity: string; movementCount: number; balancePresent: boolean;
    optionId: number | null; label: string | null; inventoryItemId: number | null; baseUnit: string | null; sourceUnitQuantityInTargetUnit: string; proposedSharedQuantity: string }>; proposedSharedBalance: string }>;
  orderHistory: Array<{ optionId: number; orderLineCount: number }>; committed: Array<{ optionId: number; label: string; orderId: number; status: string; committedConsumption: string; orderLineCount: number }>;
  issues: string[]; costRequired: boolean; fingerprint: string };
type ProductForm = { name: string; category: string; price: string; sku: string; firstOptionLabel: string;
  inventoryModel: Product["inventoryModel"]; locationEvaluation: Product["locationEvaluation"]; baseUnit: string; consumptionQuantity: string };
const defaultProduct: ProductForm = { name: "", category: "", price: "0.00", sku: "", firstOptionLabel: "Standard",
  inventoryModel: "SEPARATE_VARIANTS", locationEvaluation: "PER_LOCATION",
  baseUnit: "each", consumptionQuantity: "1.000000" };
const defaultOption = { label: "", optionValuesText: "", sku: "", barcode: "", price: "0.00", compareAtPrice: "", employeePrice: "", consumptionQuantity: "1.000000" };
const defaultCreationVariant = { label: "Standard", optionValuesText: "", sku: "", barcode: "", price: "0.00", compareAtPrice: "", employeePrice: "", consumptionQuantity: "1.000000", isAvailable: true };

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
  const [value, setValue] = useState({ label: option.label, optionValuesText: Object.entries(option.optionValues ?? {}).map(([k, v]) => `${k}=${v}`).join("; "), sku: option.sku ?? "", barcode: option.barcode ?? "", price: option.price, compareAtPrice: option.compareAtPrice ?? "", employeePrice: option.employeePrice ?? "", consumptionQuantity: option.consumptionQuantity, isAvailable: option.isAvailable });
  useEffect(() => { setValue({ label: option.label, optionValuesText: Object.entries(option.optionValues ?? {}).map(([k, v]) => `${k}=${v}`).join("; "), sku: option.sku ?? "", barcode: option.barcode ?? "", price: option.price, compareAtPrice: option.compareAtPrice ?? "", employeePrice: option.employeePrice ?? "", consumptionQuantity: option.consumptionQuantity, isAvailable: option.isAvailable }); }, [option]);
  return <div className="grid gap-2 md:grid-cols-4 text-sm">
    <label>Option<Input value={value.label} onChange={event => setValue({ ...value, label: event.target.value })} /></label>
    <label>Options<Input placeholder="Color=Red; Size=Medium" value={value.optionValuesText} onChange={event => setValue({ ...value, optionValuesText: event.target.value })} /></label>
    <label>SKU<Input value={value.sku} onChange={event => setValue({ ...value, sku: event.target.value })} /></label>
    <label>Barcode<Input value={value.barcode} onChange={event => setValue({ ...value, barcode: event.target.value })} /></label>
    <label>Price<Input value={value.price} onChange={event => setValue({ ...value, price: event.target.value })} /></label>
    <label>Compare-at price<Input value={value.compareAtPrice} onChange={event => setValue({ ...value, compareAtPrice: event.target.value })} /></label>
    <label>Employee price ($)<Input value={value.employeePrice} onChange={event => setValue({ ...value, employeePrice: event.target.value })} />
      <span className="block text-xs text-muted-foreground">Current employees pay this amount instead of 20% off. Leave blank for the 20% employee discount.</span></label>
    <label>Consumption ({option.baseUnit ?? "unit not configured"})<Input value={value.consumptionQuantity} onChange={event => setValue({ ...value, consumptionQuantity: event.target.value })} /></label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={value.isAvailable} onChange={event => setValue({ ...value, isAvailable: event.target.checked })} /> Sellable</label>
    <div className="flex flex-col gap-1 justify-end"><Button size="sm" onClick={() => save({ ...value, compareAtPrice: value.compareAtPrice || null, employeePrice: value.employeePrice || null, optionValues: parseOptionValues(value.optionValuesText), active: option.active })}>Save option</Button>
      <Button size="sm" variant="outline" onClick={() => save({ active: !option.active })}>
        {option.active ? "Remove variant (keep history)" : "Enable variant"}
      </Button>
      {option.inventoryItemId == null
        ? <span className="text-destructive">Missing inventory identity — ordering blocked</span>
        : <button type="button" className="underline" onClick={() => selectItem(option.inventoryItemId!)}>Inventory item #{option.inventoryItemId}</button>}
      <span className={option.components?.length ? "text-muted-foreground" : option.inventoryStatus === "ready" ? "text-muted-foreground" : "text-destructive"}>
        {option.components?.length
          ? "Special: the sale price is this option. Stock comes from the component list."
          : option.inventoryStatus === "missing_balance" ? "No active sellable balance — ordering blocked"
          : option.inventoryStatus === "missing_identity" ? "Inventory setup incomplete"
            : `On hand ${option.stockOnHand}; reserved ${option.reservedQuantity}; available ${option.availableQuantity}`}
      </span></div>
  </div>;
}

function SpecialComponentEditor({ option, choices, save }: {
  option: Option;
  choices: Array<{ catalogItemId: number; name: string; label: string }>;
  save: (components: Array<{ catalogItemId: number; quantity: string }>) => void;
}) {
  const [rows, setRows] = useState<Array<{ catalogItemId: number; quantity: string }>>((option.components ?? []).map(component => ({ catalogItemId: component.catalogItemId, quantity: component.quantity })));
  const [catalogItemId, setCatalogItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  useEffect(() => { setRows((option.components ?? []).map(component => ({ catalogItemId: component.catalogItemId, quantity: component.quantity }))); }, [option]);
  const used = new Set(rows.map(row => row.catalogItemId));
  const available = choices.filter(choice => choice.catalogItemId !== option.catalogItemId && !used.has(choice.catalogItemId));
  const labelFor = (id: number) => {
    const saved = option.components?.find(component => component.catalogItemId === id);
    const choice = choices.find(candidate => candidate.catalogItemId === id);
    if (choice) return `${choice.name}${choice.label === "Standard" ? "" : ` — ${choice.label}`}`;
    if (saved) return `${saved.productName}${saved.label === "Standard" ? "" : ` — ${saved.label}`}`;
    return `Catalog item #${id}`;
  };
  return <div className="rounded border p-3 space-y-2" aria-label={`Special components for option ${option.id}`}>
    <strong className="text-sm">Special components</strong>
    <p className="text-xs text-muted-foreground">The customer pays this option's price once. Each listed product is deducted from its own inventory. This special is not sold from its own stock count. Save an empty list to sell the option by itself again.</p>
    {rows.length === 0 && <p className="text-xs">No components. This option sells from its own inventory.</p>}
    {rows.map(row => <div key={row.catalogItemId} className="flex flex-wrap items-end gap-2">
      <span className="min-w-40 flex-1 text-sm">{labelFor(row.catalogItemId)}</span>
      <label className="w-28 text-xs">Quantity<Input value={row.quantity} onChange={event => setRows(current => current.map(candidate => candidate.catalogItemId === row.catalogItemId ? { ...candidate, quantity: event.target.value } : candidate))} /></label>
      <Button type="button" size="sm" variant="outline" onClick={() => setRows(current => current.filter(candidate => candidate.catalogItemId !== row.catalogItemId))}>Remove</Button>
    </div>)}
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-48 flex-1 text-xs">Add product
        <select className="block w-full rounded border bg-background p-2 text-sm" value={catalogItemId} onChange={event => setCatalogItemId(event.target.value)} aria-label={`Add component to option ${option.id}`}>
          <option value="">Select a product</option>
          {available.map(choice => <option key={choice.catalogItemId} value={choice.catalogItemId}>{choice.name}{choice.label === "Standard" ? "" : ` — ${choice.label}`}</option>)}
        </select>
      </label>
      <label className="w-28 text-xs">Quantity<Input value={quantity} onChange={event => setQuantity(event.target.value)} /></label>
      <Button type="button" size="sm" disabled={!catalogItemId} onClick={() => { setRows(current => [...current, { catalogItemId: Number(catalogItemId), quantity: quantity.trim() || "1" }]); setCatalogItemId(""); setQuantity("1"); }}>Add</Button>
    </div>
    <Button type="button" size="sm" onClick={() => save(rows)}>Save component list</Button>
    {option.components?.length ? <p className="text-xs text-muted-foreground">{option.specialOrderable ? `Can sell ${option.specialAvailableQuantity ?? "0"} from component stock.` : "A component is short or unavailable, so this special cannot be sold."}</p> : null}
  </div>;
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
  const [useExplicitVariantConversions, setUseExplicitVariantConversions] = useState(false);
  const [variantConversions, setVariantConversions] = useState<Record<number, { sourceUnitQuantityInTargetUnit: string; targetConsumptionQuantity: string }>>({});
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
    setUseExplicitVariantConversions(false); setVariantConversions({});
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
  const reconciliationVariantConversions = () => useExplicitVariantConversions && selected
    ? selected.options.filter(option => option.active).map(option => ({ optionId: option.id,
      sourceUnitQuantityInTargetUnit: variantConversions[option.id]?.sourceUnitQuantityInTargetUnit ?? "",
      targetConsumptionQuantity: variantConversions[option.id]?.targetConsumptionQuantity ?? "" }))
    : [];
  async function loadReconciliationPreview() {
    if (!selected) return;
    setBusy(true); setMessage(""); setPreview(null); setConfirmReconciliation(false);
    try {
      const data = await request(`/api/admin/catalogue/products/${selected.id}/inventory-reconciliation/preview`, {
        method: "POST", body: JSON.stringify({ target: reconciliationTarget(), variantConversions: reconciliationVariantConversions() }),
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
        method: "POST", body: JSON.stringify({ target: reconciliationTarget(), variantConversions: reconciliationVariantConversions(), previewFingerprint: preview.fingerprint,
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
      <p className="text-sm text-muted-foreground">Set physical quantities by location. Replenishment suggestions do not place purchases. Lucifer Cruz website listings and WooCommerce items are not listed here and are not counted as their own stock.</p></header>
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
          <label>Employee price ($)<Input value={variant.employeePrice} onChange={event => setCreationVariants(current => current.map((v,i)=>i===index?{...v,employeePrice:event.target.value}:v))} /></label>
          <label>Consumption ({create.baseUnit})<Input value={variant.consumptionQuantity} onChange={event => setCreationVariants(current => current.map((v,i)=>i===index?{...v,consumptionQuantity:event.target.value}:v))} /></label>
          <label className="flex items-center gap-2 self-end"><input type="checkbox" checked={variant.isAvailable} onChange={event => setCreationVariants(current => current.map((v,i)=>i===index?{...v,isAvailable:event.target.checked}:v))} />Sellable</label>
          {creationVariants.length > 1 && <Button type="button" variant="outline" className="self-end" onClick={() => setCreationVariants(current => current.filter((_,i)=>i!==index))}>Remove variant</Button>}
        </div>)}
      </div>
      <Button disabled={busy} onClick={() => void perform(async () => {
        const variants = creationVariants.map(variant => ({ label: variant.label, optionValues: parseOptionValues(variant.optionValuesText),
          sku: variant.sku || null, barcode: variant.barcode || null, price: variant.price,
          compareAtPrice: variant.compareAtPrice || null, employeePrice: variant.employeePrice || null, consumptionQuantity: variant.consumptionQuantity, isAvailable: variant.isAvailable }));
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
          <p className="text-xs text-muted-foreground">Changing an active inventory model uses one audited conversion. Existing on-hand counts are preserved and any old ledger gap is bridged automatically.</p>
          {selected.inventoryModel === "SEPARATE_VARIANTS" && inventoryModelDraft === "SHARED" && <div className="rounded border p-3 space-y-3" aria-label="Inventory reconciliation">
            <h3 className="font-semibold">Change to shared inventory</h3>
            <p className="text-sm text-muted-foreground">Choose the shared unit and each variant's amount. The conversion preserves current stock by location and records any required history bridge automatically.</p>
            <div className="grid gap-2 md:grid-cols-3">
              <label>Shared inventory item<select className="block w-full rounded border bg-background p-2" value={createSharedItem ? "create" : reconcileTarget} onChange={event => {
                setCreateSharedItem(event.target.value === "create"); if (event.target.value !== "create") setReconcileTarget(event.target.value); setPreview(null);
              }}>
                {Array.from(new Set(selected.options.filter(o => o.active && o.inventoryItemId != null).map(o => o.inventoryItemId as number))).map(itemId => <option key={itemId} value={itemId}>Use inventory item #{itemId}</option>)}
                <option value="create">Create a new shared item</option>
              </select></label>
              {createSharedItem && <><label>New shared item name<Input value={sharedItemName} onChange={event => { setSharedItemName(event.target.value); setPreview(null); }} /></label>
                <label>Shared base unit<Input value={sharedBaseUnit} onChange={event => { setSharedBaseUnit(event.target.value); setPreview(null);
                  if (event.target.value.trim().toLowerCase() !== firstActiveOption?.baseUnit?.trim().toLowerCase()) setUseExplicitVariantConversions(true);
                }} /></label></>}
            </div>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={useExplicitVariantConversions} onChange={event => { setUseExplicitVariantConversions(event.target.checked); setPreview(null); }} />
              Explicitly convert each source inventory unit into the new shared unit. Use this when existing balances count packages but the shared item is measured by weight.</label>
            {useExplicitVariantConversions && <div className="space-y-2 rounded border p-2" aria-label="Explicit variant inventory conversions">
              <p className="text-xs text-muted-foreground">These are separate facts: the first converts each currently counted source package into shared stock; the second controls what one customer sale consumes. Values are never inferred from labels or package counts.</p>
              {selected.options.filter(option => option.active).map(option => { const conversion = variantConversions[option.id] ?? { sourceUnitQuantityInTargetUnit: "", targetConsumptionQuantity: "" }; return <div key={option.id} className="grid gap-2 md:grid-cols-3">
                <strong className="text-sm self-end">{option.label} · option #{option.id}</strong>
                <label>One source {option.baseUnit ?? "unit"} equals ({sharedBaseUnit || "shared unit"})<Input inputMode="decimal" aria-label={`Source conversion option ${option.id}`} value={conversion.sourceUnitQuantityInTargetUnit} onChange={event => { setPreview(null); setVariantConversions(current => ({ ...current, [option.id]: { ...conversion, sourceUnitQuantityInTargetUnit: event.target.value } })); }} /></label>
                <label>One sale consumes ({sharedBaseUnit || "shared unit"})<Input inputMode="decimal" aria-label={`Target consumption option ${option.id}`} value={conversion.targetConsumptionQuantity} onChange={event => { setPreview(null); setVariantConversions(current => ({ ...current, [option.id]: { ...conversion, targetConsumptionQuantity: event.target.value } })); }} /></label>
              </div>; })}
            </div>}
            <Button disabled={busy || (!createSharedItem && !reconcileTarget) || (createSharedItem && (!sharedItemName.trim() || !sharedBaseUnit.trim()))
              || (useExplicitVariantConversions && selected.options.filter(option => option.active).some(option => !variantConversions[option.id]?.sourceUnitQuantityInTargetUnit || !variantConversions[option.id]?.targetConsumptionQuantity))}
              onClick={() => void loadReconciliationPreview()}>Reconcile inventory · preview</Button>
            {preview && <div className="space-y-3 rounded bg-muted/30 p-3 text-sm">
              <h4 className="font-medium">Preview · proposed base unit: {preview.targetUnit}</h4>
              <p>Product #{preview.product.id} · location evaluation remains <strong>{preview.product.locationEvaluation}</strong>.</p>
              <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th>Variant / option ID</th><th>Inventory item ID</th><th>Catalog item ID</th><th>Source-unit conversion</th><th>Sale consumption</th><th>Retail price</th></tr></thead><tbody>
                {preview.variants.map(v => <tr key={v.optionId} className="border-t"><td>{v.label} · #{v.optionId}</td><td>#{v.inventoryItemId}</td><td>#{v.catalogItemId}</td><td>1 {v.baseUnit} → {v.sourceUnitQuantityInTargetUnit} {preview.targetUnit}</td><td>{v.consumptionQuantity} {v.baseUnit} → {v.proposedConsumption} {preview.targetUnit}</td><td>{v.price}</td></tr>)}
              </tbody></table></div>
              {preview.locations.map(location => <div key={location.locationId} className="rounded border p-2">
                <strong>{location.locationName} · proposed shared balance {location.proposedSharedBalance} {preview.targetUnit}</strong>
                <ul>{location.sourceBalances.map(b => <li key={b.catalogItemId}>{b.label ?? `Catalog item #${b.catalogItemId}`} · option #{b.optionId ?? "unknown"}, inventory item #{b.inventoryItemId ?? "unknown"}: source count {b.quantity} {b.baseUnit ?? "unit"} × {b.sourceUnitQuantityInTargetUnit} {preview.targetUnit} per {b.baseUnit ?? "unit"} = {b.proposedSharedQuantity} {preview.targetUnit}; ledger {b.ledgerQuantity}; movements {b.movementCount}; balance row {b.balancePresent ? "present" : "missing (shown as zero)"}</li>)}</ul>
              </div>)}
              <div><strong>Valuation</strong><ul>{preview.costs.map(cost => <li key={cost.inventoryItemId}>Inventory item #{cost.inventoryItemId}: {cost.onHand} {cost.baseUnit}; {cost.reliable ? `recorded ${cost.averageUnitCost} per ${cost.baseUnit} (${cost.convertedUnitCost} per ${preview.targetUnit}), inventory value ${cost.inventoryValue}` : `cost ${cost.costStatus}; documented cost required`}</li>)}</ul>
                {preview.costRequired && <p>A positive documented unit cost in the shared base unit is required. Retail prices are not inventory cost.</p>}</div>
              {preview.legacyHistory.length > 0 && <div><strong>Legacy inventory history</strong><ul>{preview.legacyHistory.map((row,index) => <li key={`${row.catalogItemId}:${row.locationId}:${index}`}>Catalog item #{row.catalogItemId}, location #{row.locationId ?? "unknown"}: {row.transactionCount} historical transactions; net recorded change {row.netQuantityChange}.</li>)}</ul></div>}
              <div><strong>Reservations and committed stock</strong>{preview.reservations.length ? <><ul>{preview.reservations.map(r => <li key={r.reservationId}>Reservation #{r.reservationId}: {r.status} {r.quantity} at {r.locationName} (location #{r.locationId}), order #{r.orderId} ({r.orderStatus}). Complete fulfillment or cancel/void the order through the normal order workflow so its reservation resolves; do not release it manually.</li>)}</ul></> : <p>No active reservations.</p>}
                {preview.committed.length > 0 && <ul>{preview.committed.map((row,index) => <li key={`${row.optionId}:${row.orderId}:${index}`}>{row.status} order #{row.orderId}, {row.label}: {row.committedConsumption} committed consumption</li>)}</ul>}
                <p>Historical order lines retained: {preview.orderHistory.reduce((sum,row) => sum + row.orderLineCount, 0)}.</p></div>
              {preview.historyBridges.length > 0 && <div className="rounded border border-amber-500/40 p-2"><strong>Automatic history cleanup</strong><p>{preview.historyBridges.length} old ledger gap{preview.historyBridges.length === 1 ? "" : "s"} will be bridged inside this conversion. Current on-hand quantities will not be changed.</p></div>}
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
          {selected.options.map(option => <div key={option.id} className="space-y-2 border-b py-3">
            <OptionEditor option={option} selectItem={setSelectedItemId}
              save={value => void perform(async () => {
                const patch = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "optionValuesText"));
                await request(`/api/admin/catalogue/options/${option.id}`, { method: "PATCH", body: JSON.stringify(patch) });
              })} />
            <SpecialComponentEditor option={option} choices={products.flatMap(product => product.options.filter(candidate => candidate.active).map(candidate => ({ catalogItemId: candidate.catalogItemId, name: product.name, label: candidate.label })))}
              save={components => void perform(async () => {
                await request(`/api/admin/catalogue/options/${option.id}/components`, { method: "PUT", body: JSON.stringify({ components }) });
              }, "Special components saved.")} />
          </div>)}
          <div className="grid gap-2 rounded border p-3 md:grid-cols-[1fr_auto]">
            <label>Generate option combinations<Input placeholder="Color=Red,Blue; Size=S,M" value={combinationText} onChange={event => setCombinationText(event.target.value)} /></label>
            <Button className="self-end" disabled={busy || !combinationText.trim()} onClick={() => void perform(async () => {
              const combinations = generateVariantCombinations(parseVariantAxes(combinationText));
              for (const optionValues of combinations) {
                const label = Object.entries(optionValues).map(([key, value]) => `${key}: ${value}`).join(" / ");
                await request(`/api/admin/catalogue/products/${selected.id}/options`, { method: "POST", body: JSON.stringify({
                  label, optionValues, sku: null, barcode: null, price: newOption.price,
                  compareAtPrice: newOption.compareAtPrice || null, employeePrice: newOption.employeePrice || null, consumptionQuantity: newOption.consumptionQuantity,
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
            <label>Employee price ($)<Input value={newOption.employeePrice} onChange={event => setNewOption({ ...newOption, employeePrice: event.target.value })} /></label>
            <label>Consumption ({selected.options[0]?.baseUnit ?? "unit"})<Input value={newOption.consumptionQuantity} onChange={event => setNewOption({ ...newOption, consumptionQuantity: event.target.value })} /></label>
          </div>
          <Button disabled={busy} onClick={() => void perform(async () => {
            const { optionValuesText, compareAtPrice, employeePrice, ...variant } = newOption;
            await request(`/api/admin/catalogue/products/${selected.id}/options`, { method: "POST", body: JSON.stringify({ ...variant, optionValues: parseOptionValues(optionValuesText), compareAtPrice: compareAtPrice || null, employeePrice: employeePrice || null }) });
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
