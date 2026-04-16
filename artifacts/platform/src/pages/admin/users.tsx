import { useState } from "react";
import { useListUsers, useUpdateUserRole, getListUsersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type StatusFilter = "all" | "pending" | "approved" | "rejected";

const STATUS_COLORS: Record<string, string> = {
  approved: "bg-green-500/10 text-green-500 border-transparent",
  pending:  "bg-yellow-500/10 text-yellow-500 border-transparent",
  rejected: "bg-red-500/10 text-red-500 border-transparent",
};

export default function AdminUsers() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const { data, isLoading, isError } = useListUsers(
    {},
    { query: { queryKey: ["listUsers"] } },
  );

  const updateRoleMutation = useUpdateUserRole();

  const handleRoleChange = (id: number, newRole: string) => {
    if (["supervisor", "business_sitter", "user"].includes(newRole)) {
      updateRoleMutation.mutate(
        { id, data: { role: newRole as any } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          },
        },
      );
    }
  };

  const allUsers = data?.users ?? [];
  const filtered =
    statusFilter === "all"
      ? allUsers
      : allUsers.filter((u) => (u.status ?? "pending") === statusFilter);

  const counts = {
    all:      allUsers.length,
    approved: allUsers.filter((u) => (u.status ?? "pending") === "approved").length,
    pending:  allUsers.filter((u) => (u.status ?? "pending") === "pending").length,
    rejected: allUsers.filter((u) => (u.status ?? "pending") === "rejected").length,
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="border-b border-border/50 pb-6">
        <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-title">
          User Management
        </h1>
        <p className="text-muted-foreground" data-testid="text-subtitle">
          Manage roles and access for your organization.
        </p>
      </div>

      {/* Status filter tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        {(["all", "approved", "pending", "rejected"] as StatusFilter[]).map((s) => (
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
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Role</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Account</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest">
                  Loading directory...
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-red-500 font-mono text-xs uppercase tracking-widest">
                  Failed to load users. Check API connection.
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest border-dashed">
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
                          <SelectItem value="business_sitter" className="text-xs font-mono uppercase tracking-wider">Business Sitter</SelectItem>
                          <SelectItem value="user" className="text-xs font-mono uppercase tracking-wider">User</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={`uppercase text-[9px] tracking-widest px-2 py-0.5 rounded-sm ${STATUS_COLORS[user.status ?? "pending"] ?? STATUS_COLORS.pending}`}
                    >
                      {user.status ?? "pending"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
