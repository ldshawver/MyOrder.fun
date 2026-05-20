import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MapPin, Wifi } from "lucide-react";

type PickupOption = { id: string; label: string; locationName: string; address: string };
type PrinterConfig = { onsiteMode: string; ssid: string; passwordSet: boolean; raspberryPiBluetooth: boolean; password?: string };

export default function CsrSettings() {
  const { getToken } = useAuth();
  const { data: user } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const canEdit = user?.role === "admin" || user?.role === "supervisor";
  const [pickupOptions, setPickupOptions] = useState<PickupOption[]>([]);
  const [printerConfig, setPrinterConfig] = useState<PrinterConfig>({ onsiteMode: "auto", ssid: "", passwordSet: false, raspberryPiBluetooth: true });
  const [selectedPickup, setSelectedPickup] = useState("");
  const [selectedLocationName, setSelectedLocationName] = useState("");
  const [selectedAddress, setSelectedAddress] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = await getToken();
    const res = await fetch("/api/admin/csr-settings", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Failed to load CSR settings");
    setPickupOptions(Array.isArray(data.pickupInstructionOptions) ? data.pickupInstructionOptions : []);
    setPrinterConfig(data.printerNetworkConfig ?? { onsiteMode: "auto", ssid: "", passwordSet: false, raspberryPiBluetooth: true });
  }, [getToken]);

  useEffect(() => { load().catch(err => setMessage(err.message)); }, [load]);

  function updatePickup(index: number, patch: Partial<PickupOption>) {
    setPickupOptions(prev => prev.map((option, i) => i === index ? { ...option, ...patch } : option));
  }

  async function save() {
    setMessage(null);
    const token = await getToken();
    const res = await fetch("/api/admin/csr-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ pickupInstructionOptions: pickupOptions, printerNetworkConfig: printerConfig }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Failed to save CSR settings");
    setMessage("Settings saved.");
    await load();
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="border-b border-border/50 pb-5">
        <h1 className="text-3xl font-bold tracking-tight">CSR Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Pickup instructions, onsite/remote printer network settings, and Raspberry Pi handoff details.</p>
      </div>

      <Card className="rounded-sm border-border/50">
        <CardHeader className="bg-muted/10 border-b border-border/50 flex flex-row items-center gap-2">
          <MapPin size={16} />
          <CardTitle className="text-sm uppercase tracking-wider">Pickup Instructions</CardTitle>
        </CardHeader>
        <CardContent className="pt-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Selection</Label>
              <select className="mt-1 h-9 w-full rounded-sm bg-background border border-input px-3 text-sm" value={selectedPickup} onChange={(e) => setSelectedPickup(e.target.value)}>
                <option value="">Choose pickup type</option>
                {pickupOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Location Name</Label>
              <Input value={selectedLocationName} onChange={(e) => setSelectedLocationName(e.target.value)} className="mt-1 rounded-sm" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Address</Label>
              <Input value={selectedAddress} onChange={(e) => setSelectedAddress(e.target.value)} className="mt-1 rounded-sm" />
            </div>
          </div>

          {canEdit && (
            <div className="border-t border-border/50 pt-4 space-y-3">
              {pickupOptions.map((option, index) => (
                <div key={option.id} className="grid grid-cols-1 md:grid-cols-4 gap-2">
                  <Input value={option.label} onChange={(e) => updatePickup(index, { label: e.target.value })} placeholder="Label" className="rounded-sm" />
                  <Input value={option.locationName} onChange={(e) => updatePickup(index, { locationName: e.target.value })} placeholder="Default location" className="rounded-sm" />
                  <Input value={option.address} onChange={(e) => updatePickup(index, { address: e.target.value })} placeholder="Default address" className="rounded-sm" />
                  <Button variant="outline" className="rounded-sm" onClick={() => setPickupOptions(prev => prev.filter((_, i) => i !== index))}>Delete</Button>
                </div>
              ))}
              <Button variant="outline" className="rounded-sm" onClick={() => setPickupOptions(prev => [...prev, { id: `pickup-${Date.now()}`, label: "New pickup", locationName: "", address: "" }])}>Add Pickup Option</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-sm border-border/50">
        <CardHeader className="bg-muted/10 border-b border-border/50 flex flex-row items-center gap-2">
          <Wifi size={16} />
          <CardTitle className="text-sm uppercase tracking-wider">Printer Network</CardTitle>
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
            Remote printing requires the CSR session to set the SSID/password so the Raspberry Pi can join the same network. Bluetooth provisioning support is tracked here for the Pi bridge workflow.
          </div>
          {canEdit && <Button onClick={() => save().catch(err => setMessage(err.message))} className="rounded-sm">Save CSR Settings</Button>}
          {message && <div className="md:col-span-3 text-sm text-muted-foreground">{message}</div>}
        </CardContent>
      </Card>
    </div>
  );
}
