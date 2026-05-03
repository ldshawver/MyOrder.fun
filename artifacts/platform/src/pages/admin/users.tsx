import { useState } from "react";
import { useListUsers, useUpdateUserRole, getListUsersQueryKey, useUpdateUserStatus, useGetCurrentUser, useListPendingUsers, useSetUserApproval, getListPendingUsersQueryKey } from "@workspace/api-client-react";
import type { UserProfileStatus, UpdateUserRoleBodyRole, SetUserApprovalBodyRole } from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Mail, CheckCircle2, XCircle, Clock } from "lucide-react";

type StatusFilter = "all" | "pending" | "approved" | "rejected" | "deactivated";
type PageTab = "users" | "pending" | "waitlist";
type RoleFilter = "all" | "supervisor" | "customer_service_rep" | "user";

// Active roles surfaced in dropdowns. business_sitter and lab_tech are
// retired job titles — folded into customer_service_rep going forward — so
// they no longer appear here even though the backend still accepts them
// for any historical rows that haven't been migrated.
const APPROVAL_ROLES: { value: SetUserApprovalBodyRole; label: string }[] = [
  { value: "user", label: "User" },
  { value: "supervisor", label: "Supervisor" },
  { value: "customer_service_rep", label: "Customer Service Rep" },
  { value: "sales_rep", label: "Sales Rep" },
];

const INVITE_ROLES = APPROVAL_ROLES;
const ROLE_TABS: { id: RoleFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "supervisor", label: "Supervisor" },
  { id: "customer_service_rep", label: "CSR" },
  { id: "user", label: "Plain User" },
];

function PendingTab() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useListPendingUsers({
    query: { queryKey: getListPendingUsersQueryKey() },
  });
  const approval = useSetUserApproval();
  const [roleById, setRoleById] = useState<Record<number, SetUserApprovalBodyRole>>({});

  const users = data?.users ?? [];

  const handleApprove = (id: number) => {
    const role = roleById[id] ?? "user";
    approval.mutate(
      { id, data: { approve: true, role } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListPendingUsersQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        },
      },
    );
  };

  const handleReject = (id: number) => {
    approval.mutate(
      { id, data: { approve: false } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListPendingUsersQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        },
      },
    );
  };

  return (
    <div className="bg-card border border-border/50 rounded-sm shadow-sm overflow-hidden">
      <Table>
        <TableHeader className="bg-muted/10">
          <TableRow className="border-border/50">
            <TableHead className="font-semibold text-xs uppercase tracking-wider">User</TableHead>
            <TableHead className="font-semibold text-xs uppercase tracking-wider">Email</TableHead>
            <TableHead className="font-semibold text-xs uppercase tracking-wider">Phone</TableHead>
            <TableHead className="font-semibold text-xs uppercase tracking-wider">Assign Role</TableHead>
            <TableHead className="font-semibold text-xs uppercase tracking-wider">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={5} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest">
                Loading pending users…
              </TableCell>
            </TableRow>
          ) : isError ? (
            <TableRow>
              <TableCell colSpan={5} className="h-32 text-center text-red-500 font-mono text-xs uppercase tracking-widest">
                Failed to load pending users.
              </TableCell>
            </TableRow>
          ) : users.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest border-dashed">
                No users awaiting approval.
              </TableCell>
            </TableRow>
          ) : (
            users.map((u) => (
              <TableRow key={u.id} className="border-border/30 hover:bg-muted/20 transition-colors" data-testid={`row-pending-${u.id}`}>
                <TableCell className="font-medium text-sm">
                  {u.firstName} {u.lastName}
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">{u.email}</TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {u.contactPhone ?? <span className="opacity-30">—</span>}
                </TableCell>
                <TableCell>
                  <Select
                    value={roleById[u.id] ?? "user"}
                    onValueChange={(v) => setRoleById((m) => ({ ...m, [u.id]: v as SetUserApprovalBodyRole }))}
                  >
                    <SelectTrigger
                      className="w-[160px] h-8 rounded-sm text-xs font-mono uppercase tracking-wider bg-background border-border/50"
                      data-testid={`select-pending-role-${u.id}`}
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
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] uppercase tracking-widest rounded-sm border-green-500/40 text-green-600 hover:bg-green-500/10 hover:text-green-600"
                      onClick={() => handleApprove(u.id)}
                      disabled={approval.isPending}
                      data-testid={`btn-approve-pending-${u.id}`}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] uppercase tracking-widest rounded-sm border-red-500/40 text-red-600 hover:bg-red-500/10 hover:text-red-600"
                      onClick={() => handleReject(u.id)}
                      disabled={approval.isPending}
                      data-testid={`btn-reject-pending-${u.id}`}
                    >
                      Reject
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
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
};

type InviteDraft = { role: SetUserApprovalBodyRole; firstName: string; lastName: string };

function WaitlistTab() {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();
  const { data: currentUser } = useGetCurrentUser({ query: { queryKey: ["getCurrentUser"] } });
  const [search, setSearch] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ id: string; msg: string; ok: boolean } | null>(null);
  const [openInviteId, setOpenInviteId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, InviteDraft>>({});

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
    enabled: currentUser?.role === "admin",
  });

  function getDraft(id: string): InviteDraft {
    return drafts[id] ?? { role: "user", firstName: "", lastName: "" };
  }
  function updateDraft(id: string, patch: Partial<InviteDraft>) {
    setDrafts((m) => ({ ...m, [id]: { ...getDraft(id), ...patch } }));
  }

  async function handleInvite(id: string) {
    const draft = getDraft(id);
    setActionLoading(id);
    setActionMsg(null);
    try {
      const token = await getToken();
      const res = await fetch(`/api/admin/users/waitlist/${id}/invite`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          role: draft.role,
          firstName: draft.firstName.trim() || undefined,
          lastName: draft.lastName.trim() || undefined,
        }),
      });
      const body = await res.json() as { status?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Invite failed");
      setActionMsg({ id, msg: `Invited as ${draft.role}. User added to platform.`, ok: true });
      setOpenInviteId(null);
      refetch();
      // Bring the new approved user into the Platform Users tab immediately.
      queryClient.invalidateQueries({ queryKey: ["listUsers"] });
    } catch (e) {
      setActionMsg({ id, msg: (e as Error).message, ok: false });
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
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={4} className="h-28 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest">
                  Loading waitlist…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={4} className="h-28 text-center text-red-500 font-mono text-xs uppercase tracking-widest">
                  Failed to load waitlist.
                </TableCell>
              </TableRow>
            ) : entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-28 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest border-dashed">
                  No waitlist entries.
                </TableCell>
              </TableRow>
            ) : (
              entries.flatMap((entry) => {
                const isOpen = openInviteId === entry.id;
                const draft = getDraft(entry.id);
                const rows = [
                  <TableRow key={entry.id} className="border-border/30 hover:bg-muted/20 transition-colors">
                    <TableCell className="font-mono text-sm text-primary/90">
                      <div className="flex items-center gap-2">
                        <Mail size={12} className="text-muted-foreground shrink-0" />
                        {entry.emailAddress}
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
                      <div className="flex items-center gap-2">
                        {actionMsg?.id === entry.id && !isOpen && (
                          <span className={`text-[10px] font-mono ${actionMsg.ok ? "text-green-500" : "text-red-500"}`}>
                            {actionMsg.msg}
                          </span>
                        )}
                        {entry.status !== "rejected" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[10px] uppercase tracking-widest rounded-sm border-green-500/40 text-green-600 hover:bg-green-500/10 hover:text-green-600 gap-1"
                            onClick={() => setOpenInviteId(isOpen ? null : entry.id)}
                            disabled={actionLoading === entry.id}
                            data-testid={`btn-invite-toggle-${entry.id}`}
                          >
                            <CheckCircle2 size={11} />
                            {entry.status === "invited" ? "Re-Invite" : "Invite"}
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
                      </div>
                    </TableCell>
                  </TableRow>,
                ];

                if (isOpen) {
                  rows.push(
                    <TableRow key={`${entry.id}-form`} className="bg-muted/5 border-border/30">
                      <TableCell colSpan={4} className="py-4">
                        <div className="flex flex-wrap items-end gap-3" data-testid={`form-invite-${entry.id}`}>
                          <div className="flex flex-col gap-1">
                            <label className="text-[9px] uppercase tracking-widest text-muted-foreground font-mono">
                              First Name
                            </label>
                            <Input
                              value={draft.firstName}
                              onChange={(e) => updateDraft(entry.id, { firstName: e.target.value })}
                              className="h-8 w-40 text-xs rounded-sm bg-background border-border/50"
                              placeholder="Optional"
                              data-testid={`input-invite-firstName-${entry.id}`}
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-[9px] uppercase tracking-widest text-muted-foreground font-mono">
                              Last Name
                            </label>
                            <Input
                              value={draft.lastName}
                              onChange={(e) => updateDraft(entry.id, { lastName: e.target.value })}
                              className="h-8 w-40 text-xs rounded-sm bg-background border-border/50"
                              placeholder="Optional"
                              data-testid={`input-invite-lastName-${entry.id}`}
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className="text-[9px] uppercase tracking-widest text-muted-foreground font-mono">
                              Role
                            </label>
                            <Select
                              value={draft.role}
                              onValueChange={(v) => updateDraft(entry.id, { role: v as SetUserApprovalBodyRole })}
                            >
                              <SelectTrigger
                                className="w-[180px] h-8 rounded-sm text-xs font-mono uppercase tracking-wider bg-background border-border/50"
                                data-testid={`select-invite-role-${entry.id}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="rounded-sm">
                                {INVITE_ROLES.map((r) => (
                                  <SelectItem key={r.value} value={r.value} className="text-xs font-mono uppercase tracking-wider">
                                    {r.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <Button
                            size="sm"
                            className="h-8 text-[10px] uppercase tracking-widest rounded-sm gap-1"
                            onClick={() => handleInvite(entry.id)}
                            disabled={actionLoading === entry.id}
                            data-testid={`btn-invite-confirm-${entry.id}`}
                          >
                            <CheckCircle2 size={11} />
                            {actionLoading === entry.id ? "Inviting…" : "Send Invite & Approve"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 text-[10px] uppercase tracking-widest rounded-sm"
                            onClick={() => setOpenInviteId(null)}
                            disabled={actionLoading === entry.id}
                          >
                            Cancel
                          </Button>
                          {actionMsg?.id === entry.id && (
                            <span className={`text-[10px] font-mono ${actionMsg.ok ? "text-green-500" : "text-red-500"}`}>
                              {actionMsg.msg}
                            </span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                }
                return rows;
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

  const { data, isLoading, isError } = useListUsers(
    {},
    { query: { queryKey: ["listUsers"] } },
  );

  const updateRoleMutation = useUpdateUserRole();
  const updateStatusMutation = useUpdateUserStatus();

  const handleRoleChange = (id: number, newRole: string) => {
    if (["supervisor", "customer_service_rep", "sales_rep", "user"].includes(newRole)) {
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

  const allUsers = data?.users ?? [];
  // Treat retired roles as their replacement (CSR) for the "CSR" tab.
  const matchesRoleTab = (userRole: string | undefined, tab: RoleFilter): boolean => {
    if (tab === "all") return true;
    const r = userRole ?? "user";
    if (tab === "customer_service_rep") {
      return r === "customer_service_rep" || r === "business_sitter" || r === "lab_tech";
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
    supervisor: allUsers.filter((u) => matchesRoleTab(u.role, "supervisor")).length,
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
          Manage roles and access. Invite pending Clerk waitlist applicants.
        </p>
      </div>

      {/* Page tabs */}
      <div className="flex items-center gap-1 border-b border-border/40 pb-0">
        {([
          { id: "users" as PageTab, label: "Platform Users", count: allUsers.length },
          { id: "pending" as PageTab, label: "Pending Approval", count: counts.pending },
          { id: "waitlist" as PageTab, label: "Waitlist (Clerk)", count: null, icon: Clock },
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setPageTab(tab.id)}
            className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider transition-colors border-b-2 -mb-px ${
              pageTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            {tab.count != null && <span className="ml-1.5 opacity-60">({tab.count})</span>}
          </button>
        ))}
      </div>

      {pageTab === "waitlist" ? (
        <WaitlistTab />
      ) : pageTab === "pending" ? (
        <PendingTab />
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
                  <TableHead className="font-semibold text-xs uppercase tracking-wider">Current Role</TableHead>
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
                    <TableCell colSpan={6} className="h-32 text-center text-red-500 font-mono text-xs uppercase tracking-widest">
                      Failed to load users. Check API connection.
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest border-dashed">
                      No {statusFilter === "all" ? "" : statusFilter} users found.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((user) => (
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
                        ) : (
                          <Select
                            value={user.role}
                            onValueChange={(v) => handleRoleChange(user.id, v)}
                            disabled={updateRoleMutation.isPending}
                          >
                            <SelectTrigger
                              className="w-[160px] h-8 rounded-sm text-xs font-mono uppercase tracking-wider bg-background border-border/50"
                              data-testid={`select-role-${user.id}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="rounded-sm">
                              <SelectItem value="supervisor" className="text-xs font-mono uppercase tracking-wider">Supervisor</SelectItem>
                              <SelectItem value="customer_service_rep" className="text-xs font-mono uppercase tracking-wider">Customer Service Rep</SelectItem>
                              <SelectItem value="sales_rep" className="text-xs font-mono uppercase tracking-wider">Sales Rep</SelectItem>
                              <SelectItem value="user" className="text-xs font-mono uppercase tracking-wider">User</SelectItem>
                              {/* Legacy roles kept for users still on retired titles */}
                              {(user.role === "business_sitter" || user.role === "lab_tech") && (
                                <SelectItem value={user.role} className="text-xs font-mono uppercase tracking-wider opacity-60">
                                  {user.role === "business_sitter" ? "Business Sitter (legacy)" : "Lab Tech (legacy)"}
                                </SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={user.status} />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {user.status !== "approved" && (
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
                          {user.status !== "rejected" && (
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
                          {user.status === "approved" && (
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
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
