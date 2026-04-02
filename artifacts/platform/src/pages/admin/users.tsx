import { useListUsers, useUpdateUserRole, getListUsersQueryKey, UserProfileRole } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

export default function AdminUsers() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListUsers({}, { query: { queryKey: ["listUsers"] } });
  const updateRoleMutation = useUpdateUserRole();

  const handleRoleChange = (id: number, newRole: string) => {
    // Only allow changing to specific roles as per API type
    if (["tenant_admin", "staff", "customer"].includes(newRole)) {
      updateRoleMutation.mutate(
        { id, data: { role: newRole as any } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          }
        }
      );
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="border-b border-border/50 pb-6">
        <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-title">User Management</h1>
        <p className="text-muted-foreground" data-testid="text-subtitle">Manage roles and access for your organization.</p>
      </div>

      <div className="bg-card border border-border/50 rounded-sm shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/10">
            <TableRow className="border-border/50">
              <TableHead className="font-semibold text-xs uppercase tracking-wider">User</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Email</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Current Role</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest">
                  Loading directory...
                </TableCell>
              </TableRow>
            ) : data?.users?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest border-dashed">
                  No users found.
                </TableCell>
              </TableRow>
            ) : (
              data?.users?.map((user) => (
                <TableRow key={user.id} className="border-border/30 hover:bg-muted/20 transition-colors" data-testid={`row-user-${user.id}`}>
                  <TableCell className="font-medium text-sm">{user.firstName} {user.lastName}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">{user.email}</TableCell>
                  <TableCell>
                    {user.role === 'global_admin' ? (
                      <span className="text-[10px] font-bold uppercase tracking-widest text-primary px-2">Global Admin</span>
                    ) : (
                      <Select 
                        value={user.role} 
                        onValueChange={(v) => handleRoleChange(user.id, v)}
                        disabled={updateRoleMutation.isPending}
                      >
                        <SelectTrigger className="w-[180px] h-8 rounded-sm text-xs font-mono uppercase tracking-wider bg-background border-border/50" data-testid={`select-role-${user.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="rounded-sm">
                          <SelectItem value="tenant_admin" className="text-xs font-mono uppercase tracking-wider">Tenant Admin</SelectItem>
                          <SelectItem value="staff" className="text-xs font-mono uppercase tracking-wider">Staff</SelectItem>
                          <SelectItem value="customer" className="text-xs font-mono uppercase tracking-wider">Customer</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`uppercase text-[9px] tracking-widest px-2 py-0.5 rounded-sm border-transparent ${user.isActive ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                      {user.isActive ? 'Active' : 'Inactive'}
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
