import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Option = { id: number; label: string; sku: string | null; price: string; inventoryItemId: number; baseUnit: string; consumptionQuantity: string };
type Product = { id: number; name: string; inventoryModel: "SHARED" | "SEPARATE_VARIANTS"; locationEvaluation: "PER_LOCATION" | "COMBINED_LOCATIONS"; options: Option[] };
type Location = { locationId: number; name: string; quantityOnHand: string; par: string; reorderPoint: string; preferredReorderQuantity: string; moq: string };
type Recommendation = { inventoryItemId: number; productName: string; baseUnit: string; recommendations: Array<{ locationId: number; locationName: string; internalTransfers: Array<{ fromLocationId: number; quantity: string }>; externalPurchaseQuantity: string }> };

type ProductForm = { name: string; category: string; price: string; sku: string; firstOptionLabel: string;
  inventoryModel: Product["inventoryModel"]; locationEvaluation: Product["locationEvaluation"]; baseUnit: string; consumptionQuantity: string };
const defaultProduct: ProductForm = { name: "", category: "", price: "0.00", sku: "", firstOptionLabel: "Standard",
  inventoryModel: "SEPARATE_VARIANTS", locationEvaluation: "PER_LOCATION",
  baseUnit: "each", consumptionQuantity: "1.000000" };
const defaultOption = { label: "", sku: "", price: "0.00", consumptionQuantity: "1.000000" };

function OptionEditor({ option, save, selectItem }: { option: Option; save: (value: typeof defaultOption) => void; selectItem: (id: number) => void }) {
  const [value, setValue] = useState({ label: option.label, sku: option.sku ?? "", price: option.price, consumptionQuantity: option.consumptionQuantity });
  useEffect(() => { setValue({ label: option.label, sku: option.sku ?? "", price: option.price, consumptionQuantity: option.consumptionQuantity }); }, [option]);
  return <div className="grid gap-2 border-b py-3 md:grid-cols-5 text-sm">
    <label>Option<Input value={value.label} onChange={event => setValue({ ...value, label: event.target.value })} /></label>
    <label>SKU<Input value={value.sku} onChange={event => setValue({ ...value, sku: event.target.value })} /></label>
    <label>Price<Input value={value.price} onChange={event => setValue({ ...value, price: event.target.value })} /></label>
    <label>Consumption ({option.baseUnit})<Input value={value.consumptionQuantity} onChange={event => setValue({ ...value, consumptionQuantity: event.target.value })} /></label>
    <div className="flex flex-col gap-1 justify-end"><Button size="sm" onClick={() => save(value)}>Save option</Button>
      <button type="button" className="underline" onClick={() => selectItem(option.inventoryItemId)}>Inventory item #{option.inventoryItemId}</button></div>
  </div>;
}

export default function AdminCatalogueProducts() {
  const { getToken } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [create, setCreate] = useState(defaultProduct);
  const [newOption, setNewOption] = useState(defaultOption);
  const [editName, setEditName] = useState("");
  const [editBaseUnit, setEditBaseUnit] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = products.find(product => product.id === selectedId);
  useEffect(() => { setEditName(selected?.name ?? ""); }, [selected?.name]);
  useEffect(() => { setEditBaseUnit(selected?.options.find(option => option.inventoryItemId === selectedItemId)?.baseUnit ?? ""); }, [selected, selectedItemId]);

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
    if (!selectedItemId) { setLocations([]); return; }
    void (request(`/api/admin/catalogue/inventory/${selectedItemId}/locations`) as Promise<{ locations: Location[] }>)
      .then(result => setLocations(result.locations)).catch(error => setMessage(error.message));
  }, [request, selectedItemId]);

  async function perform(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); await refresh(); setMessage("Saved"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Save failed"); }
    finally { setBusy(false); }
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
        <label>First option<Input value={create.firstOptionLabel} onChange={event => setCreate({ ...create, firstOptionLabel: event.target.value })} /></label>
        <label>SKU<Input value={create.sku} onChange={event => setCreate({ ...create, sku: event.target.value })} /></label>
        <label>Price<Input value={create.price} onChange={event => setCreate({ ...create, price: event.target.value })} /></label>
        <label>Base unit<Input value={create.baseUnit} onChange={event => setCreate({ ...create, baseUnit: event.target.value })} /></label>
        <label>Consumption per option<Input value={create.consumptionQuantity} onChange={event => setCreate({ ...create, consumptionQuantity: event.target.value })} /></label>
        <label>Inventory model<select className="block w-full rounded border bg-background p-2" value={create.inventoryModel} onChange={event => setCreate({ ...create, inventoryModel: event.target.value as typeof create.inventoryModel })}>
          <option>SEPARATE_VARIANTS</option><option>SHARED</option></select></label>
        <label>Location evaluation<select className="block w-full rounded border bg-background p-2" value={create.locationEvaluation} onChange={event => setCreate({ ...create, locationEvaluation: event.target.value as typeof create.locationEvaluation })}>
          <option>PER_LOCATION</option><option>COMBINED_LOCATIONS</option></select></label>
      </div>
      <Button disabled={busy} onClick={() => void perform(async () => {
        const result = await request("/api/admin/catalogue/products", { method: "POST", body: JSON.stringify(create) }) as { productId: number };
        setSelectedId(result.productId); setCreate(defaultProduct);
      })}>Create product</Button>
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
            <label>Inventory model<select className="block w-full rounded border bg-background p-2" value={selected.inventoryModel}
              onChange={event => void perform(async () => { await request(`/api/admin/catalogue/products/${selected.id}`, { method: "PATCH", body: JSON.stringify({ inventoryModel: event.target.value }) }); })}>
              <option>SEPARATE_VARIANTS</option><option>SHARED</option></select></label>
            <label>Location evaluation<select className="block w-full rounded border bg-background p-2" value={selected.locationEvaluation}
              onChange={event => void perform(async () => { await request(`/api/admin/catalogue/products/${selected.id}`, { method: "PATCH", body: JSON.stringify({ locationEvaluation: event.target.value }) }); })}>
              <option>PER_LOCATION</option><option>COMBINED_LOCATIONS</option></select></label>
          </div>
          <p className="text-xs text-muted-foreground">Changing an active inventory model with balances, reservations, orders or movements requires controlled reconciliation.</p>
        </section>
        <section className="rounded-xl border p-4 space-y-3"><h2 className="font-semibold">Options / variants</h2>
          {selected.options.map(option => <OptionEditor key={option.id} option={option} selectItem={setSelectedItemId}
            save={value => void perform(async () => {
              await request(`/api/admin/catalogue/options/${option.id}`, { method: "PATCH", body: JSON.stringify(value) });
            })} />)}
          <div className="grid gap-2 md:grid-cols-4">
            <label>Option label<Input value={newOption.label} onChange={event => setNewOption({ ...newOption, label: event.target.value })} /></label>
            <label>SKU<Input value={newOption.sku} onChange={event => setNewOption({ ...newOption, sku: event.target.value })} /></label>
            <label>Price<Input value={newOption.price} onChange={event => setNewOption({ ...newOption, price: event.target.value })} /></label>
            <label>Consumption ({selected.options[0]?.baseUnit ?? "unit"})<Input value={newOption.consumptionQuantity} onChange={event => setNewOption({ ...newOption, consumptionQuantity: event.target.value })} /></label>
          </div>
          <Button disabled={busy} onClick={() => void perform(async () => {
            await request(`/api/admin/catalogue/products/${selected.id}/options`, { method: "POST", body: JSON.stringify(newOption) });
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
      {recommendations.flatMap(item => item.recommendations.filter(rec => rec.internalTransfers.length || Number(rec.externalPurchaseQuantity) > 0)
        .map(rec => <div key={`${item.inventoryItemId}-${rec.locationId}`} className="border-b py-2 text-sm">
          <strong>{item.productName}</strong> · {rec.locationName}: {rec.internalTransfers.map(transfer => `move ${transfer.quantity} ${item.baseUnit} from location #${transfer.fromLocationId}`).join(", ") || "no internal transfer"};
          {Number(rec.externalPurchaseQuantity) > 0 && ` purchase ${rec.externalPurchaseQuantity} ${item.baseUnit}`}
        </div>))}
    </section>
  </div>;
}
