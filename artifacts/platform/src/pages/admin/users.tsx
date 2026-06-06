import { useState } from "react";
import { useListUsers, useUpdateUserRole, getListUsersQueryKey, useUpdateUserStatus, useGetCurrentUser, useSetUserApproval } from "@workspace/api-client-react";
import type { UserProfileStatus, UpdateUserRoleBodyRole, SetUserApprovalBodyRole } from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Mail, CheckCircle2, XCircle, ShieldAlert } from "lucide-react";

type StatusFilter = "all" | "pending" | "approved" | "rejected" | "deactivated";
type PageTab = "users" | "waitlist";
type RoleFilter = "all" | "global_admin" | "admin" | "customer_service_rep" | "user";

const APPROVAL_ROLES: { value: SetUserApprovalBodyRole; label: string }[] = [
  { value: "user", label: "User" },
  { value: "customer_service_rep", label: "Customer Service Rep" },
  { value: "admin", label: "Admin" },
  { value: "global_admin" as SetUserApprovalBodyRole, label: "Global Admin" },
];

const ROLE_TABS: { id: RoleFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "global_admin", label: "Global Admin" },
  { id: "admin", label: "Admin" },
  { id: "customer_service_rep", label: "CSR" },
  { id: "user", label: "User" },
];

function normalizeRole(role: string | undefined): RoleFilter {
  const normalized = role?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "global_admin") return "global_admin";
  if (normalized === "admin" || normalized === "supervisor") return "admin";
  if (normalized === "customer_service_rep" || normalized === "customer_service_representative" || normalized === "customer_service" || normalized === "customer_service_specialist" || normalized === "customer_success" || normalized === "service_rep" || normalized === "csr" || normalized === "qsr" || normalized === "business_sitter" || normalized === "sales_rep" || normalized === "lab_tech" || normalized === "lab_technician") {
    return "customer_service_rep";
  }
  return "user";
}

function StatusBadge({ status }: { status?: UserProfileStatus }) {
  const s = status ?? "pending";
  const colorMap: Record<UserProfileStatus, string> = {
    pending: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    approved: "bg-green-500/10 text-green-500 border-green-500/20",
    rejected: "bg-red-500/10 text-red-500 border-red-500/20",
    deactivated: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  };
  return (
    <Badge
      variant="outline"
      className={`uppercase text-[9px] tracking-widest px-2 py-0.5 rounded-sm ${colorMap[s]}`}
      data-testid={`badge-status-${s}`}
    >
      {s}
    </Badge>
  );
}

type WaitlistEntry = {
  id: string;
  emailAddress: string;
  createdAt: number;
  status: string;
  firstName?: string | null;
  lastName?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
};

function splitDisplayName(name: string | null | undefined): { firstName?: string; lastName?: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  return { firstName: parts[0], lastName: parts.length > 1 ? parts.slice(1).join(" ") : undefined };
}

function waitlistDisplayName(entry: WaitlistEntry): string {
  const fullName = `${entry.firstName ?? ""} ${entry.lastName ?? ""}`.trim();
  return fullName || entry.contactName?.trim() || "Name not provided";
}

// ─── Waitlist tab ────────────────────────────────────────────────────────────
// Lists Clerk waitlist entries. Each row has an inline role picker and a
// single "Approve as <role>" button — one click sends the Clerk invite AND
// pre-creates an approved users row with the picked role. Admin-only: the
// underlying API requires admin, so supervisors get a dedicated banner
// instead of a silently-empty table.
function WaitlistTab({ currentRole, currentUserLoaded }: { currentRole: string | undefined; currentUserLoaded: boolean }) {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();
  const isAdmin = currentRole === "admin" || currentRole === "global_admin";
  const [search, setSearch] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ id: string; msg: string; ok: boolean } | null>(null);
  const [roleById, setRoleById] = useState<Record<string, SetUserApprovalBodyRole>>({});

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["clerkWaitlist", search],
    queryFn: async () => {
      const token = await getToken();
      const url = search
        ? `/api/admin/users/waitlist?q=${encodeURIComponent(search)}`
        : `/api/admin/users/waitlist`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("Failed to fetch waitlist");
      return res.json() as Promise<{ entries: WaitlistEntry[]; total: number }>;
    },
    enabled: isAdmin,
  });

  // Don't flash the "Admin access required" banner to admins while their
  // own profile is still loading — wait for currentUser before deciding.
  if (!currentUserLoaded) {
    return (
      <div className="bg-card border border-border/50 rounded-sm p-8 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest">
        Loading…
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div
        className="bg-card border border-amber-500/30 rounded-sm p-8 flex items-start gap-4"
        data-testid="banner-waitlist-admin-required"
      >
        <ShieldAlert className="text-amber-500 shrink-0 mt-0.5" size={20} />
        <div>
          <h3 className="font-semibold text-sm uppercase tracking-wider text-amber-500 mb-1">
            Admin access required
          </h3>
          <p className="text-sm text-muted-foreground">
            Inviting Clerk waitlist entries is restricted to admins. Ask an admin
            to invite new users from the waitlist, or have your role upgraded.
          </p>
        </div>
      </div>
    );
  }

  function getRole(id: string): SetUserApprovalBodyRole {
    return roleById[id] ?? "user";
  }

  async function handleApprove(entry: WaitlistEntry) {
    const role = getRole(entry.id);
    setActionLoading(entry.id);
    setActionMsg(null);
    try {
      const token = await getToken();
      const derived = splitDisplayName(entry.contactName);
      const firstName = entry.firstName || derived.firstName;
      const lastName = entry.lastName || derived.lastName;
      const res = await fetch(`/api/admin/users/waitlist/${entry.id}/invite`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        // Always send the email we already have — the server uses it as a
        // fallback when Clerk's waitlist API is unavailable (Restricted mode).
        body: JSON.stringify({ role, email: entry.emailAddress, firstName, lastName }),
      });
      const body = await res.json() as { status?: string; error?: string; clerkInviteFailed?: boolean };
      if (!res.ok) throw new Error(body.error ?? "Invite failed");
      if (body.clerkInviteFailed) {
        // Clerk invite email couldn't be sent (user may have already signed up),
        // but the DB row was approved — show a warning, not an error.
        setActionMsg({ id: entry.id, msg: `Approved as ${role} in database. No invite email sent — if they already have an account, they can sign in now.`, ok: true });
      } else {
        setActionMsg({ id: entry.id, msg: `Invited as ${role}.`, ok: true });
      }
      refetch();
      queryClient.invalidateQueries({ queryKey: ["listUsers"] });
    } catch (e) {
      setActionMsg({ id: entry.id, msg: (e as Error).message, ok: false });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReject(id: string) {
    setActionLoading(id);
    setActionMsg(null);
    try {
      const token = await getToken();
      const res = await fetch(`/api/admin/users/waitlist/${id}/reject`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      const body = await res.json() as { status?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Reject failed");
      setActionMsg({ id, msg: "Entry rejected.", ok: true });
      refetch();
    } catch (e) {
      setActionMsg({ id, msg: (e as Error).message, ok: false });
    } finally {
      setActionLoading(null);
    }
  }

  const entries = data?.entries ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by email…"
            className="pl-8 h-8 text-xs rounded-sm bg-background border-border/50"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <span className="text-xs text-muted-foreground font-mono">
          {data ? `${data.total} total` : ""}
        </span>
      </div>

      <div className="bg-card border border-border/50 rounded-sm shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/10">
            <TableRow className="border-border/50">
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Email</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Status</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Submitted</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Role</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-28 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest">
                  Loading waitlist…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={5} className="h-28 text-center text-red-500 font-mono text-xs uppercase tracking-widest">
                  Failed to load waitlist.
                </TableCell>
              </TableRow>
            ) : entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-28 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest border-dashed">
                  No waitlist entries.
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => {
                const role = getRole(entry.id);
                return (
                  <TableRow key={entry.id} className="border-border/30 hover:bg-muted/20 transition-colors" data-testid={`row-waitlist-${entry.id}`}>
                    <TableCell className="text-sm text-primary/90">
                      <div className="flex items-start gap-2">
                        <Mail size={12} className="text-muted-foreground shrink-0 mt-1" />
                        <div className="min-w-0">
                          <div className="font-medium text-foreground truncate">{waitlistDisplayName(entry)}</div>
                          <div className="font-mono text-xs text-muted-foreground truncate">{entry.emailAddress}</div>
                          {entry.contactPhone && (
                            <div className="font-mono text-[10px] text-muted-foreground truncate">{entry.contactPhone}</div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`uppercase text-[9px] tracking-widest px-2 py-0.5 rounded-sm ${
                          entry.status === "pending"
                            ? "bg-amber-500/10 text-amber-500 border-amber-500/20"
                            : entry.status === "invited"
                            ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                            : "bg-red-500/10 text-red-400 border-red-500/20"
                        }`}
                      >
                        {entry.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {new Date(entry.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={role}
                        onValueChange={(v) => setRoleById((m) => ({ ...m, [entry.id]: v as SetUserApprovalBodyRole }))}
                        disabled={entry.status === "rejected"}
                      >
                        <SelectTrigger
                          className="w-[180px] h-8 rounded-sm text-xs font-mono uppercase tracking-wider bg-background border-border/50"
                          data-testid={`select-waitlist-role-${entry.id}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="rounded-sm">
                          {APPROVAL_ROLES.map((r) => (
                            <SelectItem key={r.value} value={r.value} className="text-xs font-mono uppercase tracking-wider">
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 flex-wrap">
                        {entry.status !== "rejected" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[10px] uppercase tracking-widest rounded-sm border-green-500/40 text-green-600 hover:bg-green-500/10 hover:text-green-600 gap-1"
                            onClick={() => handleApprove(entry)}
                            disabled={actionLoading === entry.id}
                            data-testid={`btn-waitlist-approve-${entry.id}`}
                          >
                            <CheckCircle2 size={11} />
                            {actionLoading === entry.id
                              ? "Inviting…"
                              : entry.status === "invited"
                                ? `Re-invite as ${role}`
                                : `Approve as ${role}`}
                          </Button>
                        )}
                        {entry.status !== "rejected" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[10px] uppercase tracking-widest rounded-sm border-red-500/40 text-red-600 hover:bg-red-500/10 hover:text-red-600 gap-1"
                            onClick={() => handleReject(entry.id)}
                            disabled={actionLoading === entry.id}
                            data-testid={`btn-waitlist-reject-${entry.id}`}
                          >
                            <XCircle size={11} />
                            Reject
                          </Button>
                        )}
                        {actionMsg?.id === entry.id && (
                          <span className={`text-[10px] font-mono ${actionMsg.ok ? "text-green-500" : "text-red-500"}`}>
                            {actionMsg.msg}
                          </span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export default function AdminUsers() {
  const queryClient = useQueryClient();
  const [pageTab, setPageTab] = useState<PageTab>("users");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");

  const { data: currentUser, isSuccess: currentUserLoaded } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const { data, isLoading, isError, error } = useListUsers(
    {},
    { query: { queryKey: ["listUsers"] } },
  );
  const usersErrorMsg = (() => {
    if (!isError) return null;
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 401) return "Not signed in — please reload.";
    if (status === 403) return "Your account doesn't have permission to view the user list. (In the dev preview the local DB has no admin record — check myorder.fun instead.)";
    if (status === 500) return "Server error loading users. Check VPS logs.";
    return "Failed to load users. Check API connection.";
  })();

  const updateRoleMutation = useUpdateUserRole();
  const updateStatusMutation = useUpdateUserStatus();
  // Single-call combined approval — sets status='approved' AND role in one
  // PATCH /api/admin/users/:id/approval. Used for the inline "Approve as
  // <role>" action on pending rows.
  const approvalMutation = useSetUserApproval();

  // Per-row in-flight role selection for pending users; the row's persisted
  // role only changes once the admin clicks "Approve as <role>".
  const [pendingRoleById, setPendingRoleById] = useState<Record<number, SetUserApprovalBodyRole>>({});

  const handleRoleChange = (id: number, newRole: string) => {
    if (["global_admin", "admin", "customer_service_rep", "user"].includes(newRole)) {
      updateRoleMutation.mutate(
        { id, data: { role: newRole as UpdateUserRoleBodyRole } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          },
        },
      );
    }
  };

  const handleStatusChange = (id: number, newStatus: UserProfileStatus) => {
    updateStatusMutation.mutate(
      { id, data: { status: newStatus } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        },
      },
    );
  };

  const handleApproveWithRole = (id: number, role: SetUserApprovalBodyRole) => {
    approvalMutation.mutate(
      { id, data: { approve: true, role } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        },
      },
    );
  };

  const allUsers = data?.users ?? [];
  // Treat retired role values as their replacements for historical rows.
  const matchesRoleTab = (userRole: string | undefined, tab: RoleFilter): boolean => {
    if (tab === "all") return true;
    const r = normalizeRole(userRole);
    if (tab === "customer_service_rep") {
      return r === "customer_service_rep";
    }
    return r === tab;
  };

  const byRole = allUsers.filter((u) => matchesRoleTab(u.role, roleFilter));
  const filtered =
    statusFilter === "all"
      ? byRole
      : byRole.filter((u) => (u.status ?? "pending") === statusFilter);

  const counts = {
    all:         byRole.length,
    approved:    byRole.filter((u) => (u.status ?? "pending") === "approved").length,
    pending:     byRole.filter((u) => (u.status ?? "pending") === "pending").length,
    rejected:    byRole.filter((u) => (u.status ?? "pending") === "rejected").length,
    deactivated: byRole.filter((u) => (u.status ?? "pending") === "deactivated").length,
  };
  const roleCounts: Record<RoleFilter, number> = {
    all: allUsers.length,
    global_admin: allUsers.filter((u) => matchesRoleTab(u.role, "global_admin")).length,
    admin: allUsers.filter((u) => matchesRoleTab(u.role, "admin")).length,
    customer_service_rep: allUsers.filter((u) => matchesRoleTab(u.role, "customer_service_rep")).length,
    user: allUsers.filter((u) => matchesRoleTab(u.role, "user")).length,
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="border-b border-border/50 pb-6">
        <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-title">
          User Management
        </h1>
        <p className="text-muted-foreground" data-testid="text-subtitle">
          Manage roles and access. Invite Clerk waitlist applicants.
        </p>
      </div>

      {/* Page tabs — Platform Users (everyone with a DB row) + Waitlist
          (Clerk-only entries that haven't signed up yet). Pending users are
          visible in Platform Users via the "pending" status filter. */}
      <div className="flex items-center gap-1 border-b border-border/40 pb-0">
        {([
          { id: "users" as PageTab, label: "Platform Users", count: allUsers.length },
          { id: "waitlist" as PageTab, label: "Waitlist", count: null },
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setPageTab(tab.id)}
            className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-colors border-b-2 -mb-px ${
              pageTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            data-testid={`tab-page-${tab.id}`}
          >
            {tab.label}
            {tab.count != null && <span className="ml-1.5 opacity-60">({tab.count})</span>}
          </button>
        ))}
      </div>

      {pageTab === "waitlist" ? (
        <WaitlistTab currentRole={currentUser?.role} currentUserLoaded={currentUserLoaded} />
      ) : (
        <>
          {/* Role sub-tabs */}
          <div className="flex items-center gap-1 border-b border-border/30 pb-0">
            {ROLE_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setRoleFilter(t.id)}
                className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors border-b-2 -mb-px ${
                  roleFilter === t.id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`tab-role-${t.id}`}
              >
                {t.label}
                <span className="ml-1.5 opacity-60">({roleCounts[t.id]})</span>
              </button>
            ))}
          </div>

          {/* Status filter tabs */}
          <div className="flex items-center gap-2 flex-wrap">
            {(["all", "approved", "pending", "rejected", "deactivated"] as StatusFilter[]).map((s) => (
              <Button
                key={s}
                variant={statusFilter === s ? "default" : "outline"}
                size="sm"
                className="rounded-sm text-xs uppercase tracking-wider font-mono h-7 px-3"
                onClick={() => setStatusFilter(s)}
                data-testid={`filter-status-${s}`}
              >
                {s}
                <span className="ml-1.5 opacity-60">({counts[s]})</span>
              </Button>
            ))}
          </div>

          <div className="bg-card border border-border/50 rounded-sm shadow-sm overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/10">
                <TableRow className="border-border/50">
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">User</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">Email</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">Phone</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">Role</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">Status</TableHead>
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest">
                      Loading directory...
                    </TableCell>
                  </TableRow>
                ) : isError ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-red-400/80 text-xs leading-relaxed px-8">
                      {usersErrorMsg}
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest border-dashed">
                      No {statusFilter === "all" ? "" : statusFilter} users found.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((user) => {
                    const status = (user.status ?? "pending") as UserProfileStatus;
                    const isPending = status === "pending";
                    const draftRole: SetUserApprovalBodyRole =
                      pendingRoleById[user.id] ?? (user.role as SetUserApprovalBodyRole) ?? "user";
                    return (
                      <TableRow
                        key={user.id}
                        className="border-border/30 hover:bg-muted/20 transition-colors"
                        data-testid={`row-user-${user.id}`}
                      >
                        <TableCell className="font-medium text-sm">
                          {user.firstName} {user.lastName}
                        </TableCell>
                        <TableCell className="text-muted-foreground font-mono text-xs">
                          {user.email}
                        </TableCell>
                        <TableCell className="text-muted-foreground font-mono text-xs">
                          {user.contactPhone ?? <span className="opacity-30">—</span>}
                        </TableCell>
                        <TableCell>
                          {user.role === "admin" ? (
                            <span className="text-[10px] font-bold uppercase tracking-widest text-primary px-2">
                              Admin
                            </span>
                          ) : isPending ? (
                            // Pending row: role select is staged locally; the
                            // "Approve as <role>" button commits both status
                            // and role in a single backend call.
                            <Select
                              value={draftRole}
                              onValueChange={(v) =>
                                setPendingRoleById((m) => ({ ...m, [user.id]: v as SetUserApprovalBodyRole }))
                              }
                              disabled={approvalMutation.isPending}
                            >
                              <SelectTrigger
                                className="w-[180px] h-8 rounded-sm text-xs font-mono uppercase tracking-wider bg-background border-border/50"
                                data-testid={`select-pending-role-${user.id}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="rounded-sm">
                                {APPROVAL_ROLES.map((r) => (
                                  <SelectItem key={r.value} value={r.value} className="text-xs font-mono uppercase tracking-wider">
                                    {r.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            // Approved/rejected rows: changing the select
                            // immediately calls PATCH /admin/users/:id/role.
                            <Select
                              value={user.role}
                              onValueChange={(v) => handleRoleChange(user.id, v)}
                              disabled={updateRoleMutation.isPending}
                            >
                              <SelectTrigger
                                className="w-[180px] h-8 rounded-sm text-xs font-mono uppercase tracking-wider bg-background border-border/50"
                                data-testid={`select-role-${user.id}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="rounded-sm">
                                <SelectItem value="global_admin" className="text-xs font-mono uppercase tracking-wider">Global Admin</SelectItem>
                                <SelectItem value="admin" className="text-xs font-mono uppercase tracking-wider">Admin</SelectItem>
                                <SelectItem value="customer_service_rep" className="text-xs font-mono uppercase tracking-wider">Customer Service Rep</SelectItem>
                                <SelectItem value="user" className="text-xs font-mono uppercase tracking-wider">User</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={status} />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {isPending && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-[10px] uppercase tracking-widest rounded-sm border-green-500/40 text-green-600 hover:bg-green-500/10 hover:text-green-600"
                                onClick={() => handleApproveWithRole(user.id, draftRole)}
                                disabled={approvalMutation.isPending}
                                data-testid={`btn-approve-as-role-${user.id}`}
                              >
                                {approvalMutation.isPending ? "Approving…" : `Approve as ${draftRole}`}
                              </Button>
                            )}
                            {!isPending && status !== "approved" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-[10px] uppercase tracking-widest rounded-sm border-green-500/40 text-green-600 hover:bg-green-500/10 hover:text-green-600"
                                onClick={() => handleStatusChange(user.id, "approved")}
                                disabled={updateStatusMutation.isPending}
                                data-testid={`btn-approve-${user.id}`}
                              >
                                Approve
                              </Button>
                            )}
                            {status !== "rejected" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-[10px] uppercase tracking-widest rounded-sm border-red-500/40 text-red-600 hover:bg-red-500/10 hover:text-red-600"
                                onClick={() => handleStatusChange(user.id, "rejected")}
                                disabled={updateStatusMutation.isPending}
                                data-testid={`btn-reject-${user.id}`}
                              >
                                Reject
                              </Button>
                            )}
                            {status === "approved" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-[10px] uppercase tracking-widest rounded-sm border-amber-500/40 text-amber-600 hover:bg-amber-500/10 hover:text-amber-600"
                                onClick={() => handleStatusChange(user.id, "pending")}
                                disabled={updateStatusMutation.isPending}
                                data-testid={`btn-revoke-${user.id}`}
                              >
                                Revoke
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
