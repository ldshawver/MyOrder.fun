import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/react";

<<<<<<< HEAD
type Permission = { key?: string; permission: string; enabled: boolean; editable: boolean };
=======
type Permission = { permission: string; enabled: boolean; editable: boolean };
>>>>>>> e99c0cb (Checkpoint local branch changes before refresh)
type RoleBlock = { role: string; editable: boolean; permissions: Permission[] };
type Payload = { roles: RoleBlock[]; groups: Record<string, string[]>; tenantId: number | null };

export default function AdminRolesPermissions() {
  const { getToken } = useAuth();
  const [data, setData] = useState<Payload | null>(null);
  const [message, setMessage] = useState<string>("");
  const [saving, setSaving] = useState<string>("");

  const load = useCallback(async () => {
    const token = await getToken();
    const res = await fetch("/api/admin/roles-permissions", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error("Failed to load role permissions");
    setData(await res.json());
  }, [getToken]);

  useEffect(() => { load().catch((err) => setMessage(err instanceof Error ? err.message : "Failed to load")); }, [load]);

  const roles = useMemo(() => data?.roles ?? [], [data]);

  async function save(role: string) {
    if (!data) return;
    setSaving(role);
    const block = data.roles.find((r) => r.role === role);
<<<<<<< HEAD
    const permissions = Object.fromEntries(
      (block?.permissions ?? [])
        .map((permission) => [permission.permission || permission.key, permission.enabled] as const)
        .filter((entry): entry is readonly [string, boolean] => Boolean(entry[0])),
    );
=======
>>>>>>> e99c0cb (Checkpoint local branch changes before refresh)
    try {
      const token = await getToken();
      const res = await fetch(`/api/admin/roles-permissions/${role}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
<<<<<<< HEAD
        body: JSON.stringify({ permissions }),
=======
        body: JSON.stringify({ permissions: block?.permissions ?? [] }),
>>>>>>> e99c0cb (Checkpoint local branch changes before refresh)
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to save permissions");
      setMessage(`Saved ${role} permissions. Changes were audit logged.`);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving("");
    }
  }

  async function reset(role: string) {
    setSaving(role);
    try {
      const token = await getToken();
      const res = await fetch(`/api/admin/roles-permissions/${role}/reset`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to reset permissions");
      setMessage(`Reset ${role} to default permissions. Changes were audit logged.`);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to reset");
    } finally {
      setSaving("");
    }
  }

  function toggle(role: string, permission: string, enabled: boolean) {
<<<<<<< HEAD
    setData((prev) => prev && ({ ...prev, roles: prev.roles.map((r) => r.role !== role ? r : { ...r, permissions: r.permissions.map((p) => (p.permission || p.key) === permission ? { ...p, enabled } : p) }) }));
=======
    setData((prev) => prev && ({ ...prev, roles: prev.roles.map((r) => r.role !== role ? r : { ...r, permissions: r.permissions.map((p) => p.permission === permission ? { ...p, enabled } : p) }) }));
>>>>>>> e99c0cb (Checkpoint local branch changes before refresh)
  }

  if (!data) return <div className="p-6 text-sm text-muted-foreground">Loading roles and permissions… {message}</div>;

  return <div className="p-6 space-y-6" data-testid="roles-permissions-page">
    <div><h1 className="text-2xl font-bold">Roles & Permissions</h1><p className="text-sm text-muted-foreground">Edit tenant role permission overrides. Admin-level changes can affect access to users, reports, and settings.</p></div>
    {message && <div className="rounded border border-border p-3 text-sm">{message}</div>}
    {roles.map((role) => <section key={role.role} className="rounded-xl border border-border p-4 space-y-4" data-testid={`role-card-${role.role}`}>
      <div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold uppercase tracking-wide">{role.role}</h2>{role.role === "admin" && <p className="text-xs text-amber-500">Warning: editing admin permissions may affect tenant administration.</p>}{!role.editable && <p className="text-xs text-muted-foreground">Only global admins can edit this role.</p>}</div><div className="flex gap-2"><button className="rounded border px-3 py-1 text-sm disabled:opacity-50" disabled={!role.editable || saving === role.role} onClick={() => reset(role.role)}>Reset defaults</button><button className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50" disabled={!role.editable || saving === role.role} onClick={() => save(role.role)}>{saving === role.role ? "Saving…" : "Save"}</button></div></div>
<<<<<<< HEAD
      {Object.entries(data.groups).map(([group, permissions]) => <div key={group}><h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{group}</h3><div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">{permissions.map((permission) => { const item = role.permissions.find((p) => (p.permission || p.key) === permission); if (!item) return null; return <label key={permission} className="flex items-center gap-2 rounded border border-border/60 p-2 text-sm"><input data-testid={`permission-${role.role}-${permission}`} type="checkbox" checked={item.enabled} disabled={!item.editable} onChange={(e) => toggle(role.role, permission, e.target.checked)} /><span>{permission}</span></label>; })}</div></div>)}
=======
      {Object.entries(data.groups).map(([group, permissions]) => <div key={group}><h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{group}</h3><div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">{permissions.map((permission) => { const item = role.permissions.find((p) => p.permission === permission); if (!item) return null; return <label key={permission} className="flex items-center gap-2 rounded border border-border/60 p-2 text-sm"><input data-testid={`permission-${role.role}-${permission}`} type="checkbox" checked={item.enabled} disabled={!item.editable} onChange={(e) => toggle(role.role, permission, e.target.checked)} /><span>{permission}</span></label>; })}</div></div>)}
>>>>>>> e99c0cb (Checkpoint local branch changes before refresh)
    </section>)}
  </div>;
}
