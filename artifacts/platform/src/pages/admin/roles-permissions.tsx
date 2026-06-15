import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { AlertTriangle, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

type RolePermission = { key: string; enabled: boolean; defaultEnabled: boolean; overridden: boolean };
type RoleRow = { role: string; editable: boolean; permissions: RolePermission[] };
type Payload = { roles: RoleRow[]; permissions: Record<string, string[]>; warnings: { admin: string } };

export default function AdminRolesPermissions() {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState<Payload | null>(null);
  const [selectedRole, setSelectedRole] = useState("csr");
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const selected = useMemo(() => data?.roles.find((r) => r.role === selectedRole), [data, selectedRole]);

  const load = useCallback(async () => {
    const token = await getToken();
    const res = await fetch("/api/admin/roles-permissions", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error("Failed to load role permissions");
    const json = await res.json() as Payload;
    setData(json);
    const role = json.roles.find((r) => r.role === selectedRole) ?? json.roles[0];
    setSelectedRole(role.role);
    setDraft(Object.fromEntries(role.permissions.map((p) => [p.key, p.enabled])));
  }, [getToken, selectedRole]);

  useEffect(() => { void load().catch((err) => toast({ title: "Unable to load permissions", description: String(err), variant: "destructive" })); }, [load, toast]);
  useEffect(() => { if (selected) setDraft(Object.fromEntries(selected.permissions.map((p) => [p.key, p.enabled]))); }, [selected]);

  async function save() {
    const token = await getToken();
    const res = await fetch(`/api/admin/roles-permissions/${selectedRole}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ permissions: draft }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
    toast({ title: "Permissions saved", description: `${selectedRole.replace(/_/g, " ")} permissions were updated.` });
    await load();
  }

  async function resetDefaults() {
    const token = await getToken();
    const res = await fetch(`/api/admin/roles-permissions/${selectedRole}/reset`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error((await res.json()).error ?? "Reset failed");
    toast({ title: "Defaults restored", description: `${selectedRole.replace(/_/g, " ")} now uses default permissions.` });
    await load();
  }

  if (!data || !selected) return <div className="text-sm text-muted-foreground">Loading roles and permissions…</div>;

  return (
    <div className="space-y-6" data-testid="page-roles-permissions">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Roles & Permissions</h1>
        <p className="text-sm text-muted-foreground mt-1">Edit tenant role permissions. Tenant admins cannot edit global_admin or platform permissions.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <Card>
          <CardHeader><CardTitle className="text-base">Roles</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {data.roles.map((role) => (
              <button key={role.role} type="button" onClick={() => setSelectedRole(role.role)} className={`w-full text-left px-3 py-2 rounded-md border ${selectedRole === role.role ? "border-primary bg-primary/10" : "border-border hover:bg-muted/50"}`} data-testid={`button-role-${role.role}`}>
                <div className="flex items-center justify-between"><span className="font-medium capitalize">{role.role.replace(/_/g, " ")}</span>{!role.editable && <Badge variant="secondary">Locked</Badge>}</div>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="capitalize">{selectedRole.replace(/_/g, " ")} permissions</CardTitle>
            <CardDescription>{selectedRole === "admin" ? data.warnings.admin : "Overrides are stored per tenant unless you are editing as global admin."}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {selectedRole === "admin" && <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"><AlertTriangle className="h-4 w-4 text-amber-500" /> Keep users.manage_roles and users.manage_permissions enabled for at least one tenant admin.</div>}
            {Object.entries(data.permissions).map(([group, permissions]) => (
              <div key={group} className="space-y-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{group}</h2>
                <div className="grid gap-2 md:grid-cols-2">
                  {permissions.map((permission) => {
                    const platform = permission.startsWith("platform.");
                    const disabled = !selected.editable || (selectedRole !== "global_admin" && platform);
                    return (
                      <label key={permission} className={`flex items-center gap-3 rounded-md border p-3 text-sm ${disabled ? "opacity-60" : "hover:bg-muted/40"}`}>
                        <Checkbox checked={draft[permission] ?? false} disabled={disabled} onCheckedChange={(value) => setDraft((prev) => ({ ...prev, [permission]: value === true }))} data-testid={`checkbox-${selectedRole}-${permission}`} />
                        <span className="flex-1 font-mono text-xs">{permission}</span>
                        {selected.permissions.find((p) => p.key === permission)?.overridden && <Badge variant="outline">Override</Badge>}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="flex gap-2 pt-2">
              <Button disabled={!selected.editable} onClick={() => void save().catch((err) => toast({ title: "Save failed", description: String(err), variant: "destructive" }))}><Save className="mr-2 h-4 w-4" /> Save</Button>
              <Button variant="outline" disabled={!selected.editable} onClick={() => void resetDefaults().catch((err) => toast({ title: "Reset failed", description: String(err), variant: "destructive" }))}><RotateCcw className="mr-2 h-4 w-4" /> Reset defaults</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
