import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { useParams } from "wouter";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ClipboardList, MapPin, Settings, Store, Truck, Wifi } from "lucide-react";
import { normalizeNotificationRole } from "@/hooks/usePushNotifications";

type SectionKey = "pickup" | "location" | "wifi" | "shift";
type PickupOption = { id: string; label: string; instructions: string };
type ShiftLocation = { id: string; label: string; address: string; pickupInstructionId: string; deliveryOptionId: string };
type DeliveryOption = { id: string; label: string; instructions: string; separatePaymentRequired: boolean };
type PrinterConfig = { onsiteMode: string; ssid: string; passwordSet: boolean; raspberryPiBluetooth: boolean; password?: string };

const DEFAULT_PRINTER_CONFIG: PrinterConfig = { onsiteMode: "auto", ssid: "", passwordSet: false, raspberryPiBluetooth: true };
const sections: Array<{ key: SectionKey; label: string; icon: typeof MapPin }> = [
  { key: "pickup", label: "Pickup Instructions", icon: ClipboardList },
  { key: "location", label: "Shift Location", icon: Store },
  { key: "wifi", label: "WIFI", icon: Wifi },
  { key: "shift", label: "Shift Settings", icon: Settings },
];

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}`;
}

export default function CsrSettings() {
  const { section } = useParams<{ section?: string }>();
  const activeSection = sections.some(s => s.key === section) ? section as SectionKey : "pickup";
  const { getToken } = useAuth();
  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const userRole = normalizeNotificationRole(user?.role);
  const canEdit = userRole === "global_admin" || userRole === "admin";

  const [pickupOptions, setPickupOptions] = useState<PickupOption[]>([]);
  const [shiftLocations, setShiftLocations] = useState<ShiftLocation[]>([]);
  const [deliveryOptions, setDeliveryOptions] = useState<DeliveryOption[]>([]);
  const [printerConfig, setPrinterConfig] = useState<PrinterConfig>(DEFAULT_PRINTER_CONFIG);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [selectedPickupId, setSelectedPickupId] = useState("");
  const [selectedDeliveryId, setSelectedDeliveryId] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const selectedLocation = useMemo(
    () => shiftLocations.find(location => location.id === selectedLocationId),
    [selectedLocationId, shiftLocations],
  );
  const selectedPickup = useMemo(
    () => pickupOptions.find(option => option.id === selectedPickupId),
    [pickupOptions, selectedPickupId],
  );
  const selectedDelivery = useMemo(
    () => deliveryOptions.find(option => option.id === selectedDeliveryId),
    [deliveryOptions, selectedDeliveryId],
  );

  const load = useCallback(async () => {
    const token = await getToken();
    const res = await fetch("/api/admin/csr-settings", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Failed to load CSR settings");

    const nextPickups = Array.isArray(data.pickupInstructionOptions) ? data.pickupInstructionOptions : [];
    const nextLocations = Array.isArray(data.shiftLocationOptions) ? data.shiftLocationOptions : [];
    const nextDeliveryOptions = Array.isArray(data.deliveryOptions) ? data.deliveryOptions : [];
    setPickupOptions(nextPickups);
    setShiftLocations(nextLocations);
    setDeliveryOptions(nextDeliveryOptions);
    setPrinterConfig(data.printerNetworkConfig ?? DEFAULT_PRINTER_CONFIG);
    setSelectedPickupId(current => current || nextPickups[0]?.id || "");
    setSelectedLocationId(current => current || nextLocations[0]?.id || "");
    setSelectedDeliveryId(current => current || nextDeliveryOptions[0]?.id || "");
  }, [getToken]);

  useEffect(() => { load().catch(err => setMessage(err.message)); }, [load]);

  async function save() {
    setMessage(null);
    const token = await getToken();
    const res = await fetch("/api/admin/csr-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        pickupInstructionOptions: pickupOptions,
        shiftLocationOptions: shiftLocations,
        deliveryOptions,
        printerNetworkConfig: printerConfig,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Failed to save CSR settings");
    setMessage("Settings saved.");
    await load();
  }

  function saveFromClick() {
    save().catch(err => setMessage(err.message));
  }

  function updatePickup(id: string, patch: Partial<PickupOption>) {
    setPickupOptions(prev => prev.map(option => option.id === id ? { ...option, ...patch } : option));
  }

  function updateLocation(id: string, patch: Partial<ShiftLocation>) {
    setShiftLocations(prev => prev.map(location => location.id === id ? { ...location, ...patch } : location));
  }

  function updateDelivery(id: string, patch: Partial<DeliveryOption>) {
    setDeliveryOptions(prev => prev.map(option => option.id === id ? { ...option, ...patch } : option));
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="border-b border-border/50 pb-5">
        <h1 className="text-3xl font-bold tracking-tight">CSR Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Shift locations, customer pickup instructions, delivery options, and Raspberry Pi Wi-Fi setup.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {sections.map(({ key, label, icon: Icon }) => (
          <a
            key={key}
            href={`/csr-settings/${key}`}
            className={`inline-flex items-center gap-2 rounded-sm border px-3 py-2 text-xs font-semibold transition-colors ${
              activeSection === key ? "border-primary/40 bg-primary/10 text-primary" : "border-border/50 text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon size={14} />
            {label}
          </a>
        ))}
      </div>

      {activeSection === "pickup" && (
        <Card className="rounded-sm border-border/50">
          <CardHeader className="bg-muted/10 border-b border-border/50 flex flex-row items-center gap-2">
            <ClipboardList size={16} />
            <CardTitle className="text-sm uppercase tracking-wider">Pickup Instructions</CardTitle>
          </CardHeader>
          <CardContent className="pt-5 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Saved Option</Label>
                <select className="mt-1 h-9 w-full rounded-sm bg-background border border-input px-3 text-sm" value={selectedPickupId} onChange={(e) => setSelectedPickupId(e.target.value)}>
                  <option value="">Choose pickup instructions</option>
                  {pickupOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Label</Label>
                <Input disabled={!canEdit || !selectedPickup} value={selectedPickup?.label ?? ""} onChange={(e) => selectedPickup && updatePickup(selectedPickup.id, { label: e.target.value })} className="mt-1 rounded-sm" />
              </div>
              <div className="md:col-span-3">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Customer Instructions</Label>
                <textarea
                  disabled={!canEdit || !selectedPickup}
                  value={selectedPickup?.instructions ?? ""}
                  onChange={(e) => selectedPickup && updatePickup(selectedPickup.id, { instructions: e.target.value })}
                  className="mt-1 min-h-24 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm outline-none"
                  placeholder="Instructions shown to the customer when the order is ready."
                />
              </div>
            </div>
            {canEdit && (
              <div className="flex flex-wrap gap-2 border-t border-border/50 pt-4">
                <Button variant="outline" className="rounded-sm" onClick={() => {
                  const id = makeId("pickup");
                  setPickupOptions(prev => [...prev, { id, label: "New pickup instructions", instructions: "" }]);
                  setSelectedPickupId(id);
                }}>Add Instructions</Button>
                <Button variant="outline" className="rounded-sm" disabled={!selectedPickup} onClick={() => {
                  setPickupOptions(prev => prev.filter(option => option.id !== selectedPickupId));
                  setSelectedPickupId("");
                }}>Delete Selected</Button>
                <Button onClick={saveFromClick} className="rounded-sm">Save Pickup Instructions</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {activeSection === "location" && (
        <Card className="rounded-sm border-border/50">
          <CardHeader className="bg-muted/10 border-b border-border/50 flex flex-row items-center gap-2">
            <Store size={16} />
            <CardTitle className="text-sm uppercase tracking-wider">Shift Location</CardTitle>
          </CardHeader>
          <CardContent className="pt-5 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Preconfigured Location</Label>
                <select className="mt-1 h-9 w-full rounded-sm bg-background border border-input px-3 text-sm" value={selectedLocationId} onChange={(e) => setSelectedLocationId(e.target.value)}>
                  <option value="">Choose shift location</option>
                  {shiftLocations.map(location => <option key={location.id} value={location.id}>{location.label}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Location Name</Label>
                <Input disabled={!canEdit || !selectedLocation} value={selectedLocation?.label ?? ""} onChange={(e) => selectedLocation && updateLocation(selectedLocation.id, { label: e.target.value })} className="mt-1 rounded-sm" />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Address</Label>
                <Input disabled={!canEdit || !selectedLocation} value={selectedLocation?.address ?? ""} onChange={(e) => selectedLocation && updateLocation(selectedLocation.id, { address: e.target.value })} className="mt-1 rounded-sm" />
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Default Pickup Instructions</Label>
                <select disabled={!canEdit || !selectedLocation} className="mt-1 h-9 w-full rounded-sm bg-background border border-input px-3 text-sm" value={selectedLocation?.pickupInstructionId ?? ""} onChange={(e) => selectedLocation && updateLocation(selectedLocation.id, { pickupInstructionId: e.target.value })}>
                  <option value="">Choose instructions</option>
                  {pickupOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Default Delivery Option</Label>
                <select disabled={!canEdit || !selectedLocation} className="mt-1 h-9 w-full rounded-sm bg-background border border-input px-3 text-sm" value={selectedLocation?.deliveryOptionId ?? ""} onChange={(e) => selectedLocation && updateLocation(selectedLocation.id, { deliveryOptionId: e.target.value })}>
                  <option value="">Choose delivery option</option>
                  {deliveryOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </div>
            </div>
            {canEdit && (
              <div className="flex flex-wrap gap-2 border-t border-border/50 pt-4">
                <Button variant="outline" className="rounded-sm" onClick={() => {
                  const id = makeId("location");
                  setShiftLocations(prev => [...prev, { id, label: "New shift location", address: "", pickupInstructionId: pickupOptions[0]?.id ?? "", deliveryOptionId: deliveryOptions[0]?.id ?? "" }]);
                  setSelectedLocationId(id);
                }}>Add Location</Button>
                <Button variant="outline" className="rounded-sm" disabled={!selectedLocation} onClick={() => {
                  setShiftLocations(prev => prev.filter(location => location.id !== selectedLocationId));
                  setSelectedLocationId("");
                }}>Delete Selected</Button>
                <Button onClick={saveFromClick} className="rounded-sm">Save Locations</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {activeSection === "wifi" && (
        <Card className="rounded-sm border-border/50">
          <CardHeader className="bg-muted/10 border-b border-border/50 flex flex-row items-center gap-2">
            <Wifi size={16} />
            <CardTitle className="text-sm uppercase tracking-wider">Wi-Fi / Raspberry Pi</CardTitle>
          </CardHeader>
          <CardContent className="pt-5 grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Onsite Mode</Label>
              <select disabled={!canEdit} className="mt-1 h-9 w-full rounded-sm bg-background border border-input px-3 text-sm" value={printerConfig.onsiteMode} onChange={(e) => setPrinterConfig(prev => ({ ...prev, onsiteMode: e.target.value }))}>
                <option value="auto">Auto detect</option>
                <option value="onsite">Force onsite</option>
                <option value="remote">Force remote</option>
              </select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Shared SSID</Label>
              <Input disabled={!canEdit} value={printerConfig.ssid} onChange={(e) => setPrinterConfig(prev => ({ ...prev, ssid: e.target.value }))} className="mt-1 rounded-sm" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Wi-Fi Password</Label>
              <Input disabled={!canEdit} type="password" placeholder={printerConfig.passwordSet ? "Saved" : ""} onChange={(e) => setPrinterConfig(prev => ({ ...prev, password: e.target.value }))} className="mt-1 rounded-sm" />
            </div>
            <div className="md:col-span-3 text-xs text-muted-foreground">
              CSR Wi-Fi is tenant-wide. Auto detect uses this saved SSID plus the Tailscale printer bridge; browsers cannot scan every nearby Wi-Fi network directly, so enter the shared SSID here for CSR clock-in and Raspberry Pi printer routing.
            </div>
            {canEdit && <Button onClick={saveFromClick} className="rounded-sm">Save Wi-Fi Settings</Button>}
          </CardContent>
        </Card>
      )}

      {activeSection === "shift" && (
        <Card className="rounded-sm border-border/50">
          <CardHeader className="bg-muted/10 border-b border-border/50 flex flex-row items-center gap-2">
            <Truck size={16} />
            <CardTitle className="text-sm uppercase tracking-wider">Delivery Options</CardTitle>
          </CardHeader>
          <CardContent className="pt-5 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Saved Delivery Option</Label>
                <select className="mt-1 h-9 w-full rounded-sm bg-background border border-input px-3 text-sm" value={selectedDeliveryId} onChange={(e) => setSelectedDeliveryId(e.target.value)}>
                  <option value="">Choose delivery option</option>
                  {deliveryOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Label</Label>
                <Input disabled={!canEdit || !selectedDelivery} value={selectedDelivery?.label ?? ""} onChange={(e) => selectedDelivery && updateDelivery(selectedDelivery.id, { label: e.target.value })} className="mt-1 rounded-sm" />
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground pt-7">
                <input
                  disabled={!canEdit || !selectedDelivery}
                  type="checkbox"
                  checked={selectedDelivery?.separatePaymentRequired ?? false}
                  onChange={(e) => selectedDelivery && updateDelivery(selectedDelivery.id, { separatePaymentRequired: e.target.checked })}
                />
                Requires separate delivery payment
              </label>
              <div className="md:col-span-3">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Delivery Instructions</Label>
                <textarea
                  disabled={!canEdit || !selectedDelivery}
                  value={selectedDelivery?.instructions ?? ""}
                  onChange={(e) => selectedDelivery && updateDelivery(selectedDelivery.id, { instructions: e.target.value })}
                  className="mt-1 min-h-24 w-full rounded-sm border border-input bg-background px-3 py-2 text-sm outline-none"
                />
              </div>
            </div>
            {canEdit && (
              <div className="flex flex-wrap gap-2 border-t border-border/50 pt-4">
                <Button variant="outline" className="rounded-sm" onClick={() => {
                  const id = makeId("delivery");
                  setDeliveryOptions(prev => [...prev, { id, label: "New delivery option", instructions: "", separatePaymentRequired: false }]);
                  setSelectedDeliveryId(id);
                }}>Add Delivery Option</Button>
                <Button variant="outline" className="rounded-sm" disabled={!selectedDelivery} onClick={() => {
                  setDeliveryOptions(prev => prev.filter(option => option.id !== selectedDeliveryId));
                  setSelectedDeliveryId("");
                }}>Delete Selected</Button>
                <Button onClick={saveFromClick} className="rounded-sm">Save Shift Settings</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {message && <div className="text-sm text-muted-foreground">{message}</div>}
    </div>
  );
}
