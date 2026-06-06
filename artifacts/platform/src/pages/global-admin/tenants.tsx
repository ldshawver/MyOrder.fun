import { useListTenants } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function GlobalAdminTenants() {
  const { data, isLoading } = useListTenants({ query: { queryKey: ["listTenants"] } });

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="border-b border-border/50 pb-6">
        <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-title">Tenants</h1>
        <p className="text-muted-foreground" data-testid="text-subtitle">Manage all tenants on the platform.</p>
      </div>

      <div className="bg-card border border-border/50 rounded-sm shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/10">
            <TableRow className="border-border/50">
              <TableHead className="font-semibold text-xs uppercase tracking-wider">ID</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Name</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Slug</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Status</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Plan</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest">
                  Loading tenants...
                </TableCell>
              </TableRow>
            ) : data?.tenants?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest border-dashed">
                  No tenants found.
                </TableCell>
              </TableRow>
            ) : (
              data?.tenants?.map((tenant) => (
                <TableRow key={tenant.id} className="border-border/30 hover:bg-muted/20" data-testid={`row-tenant-${tenant.id}`}>
                  <TableCell className="font-mono text-xs text-muted-foreground">{tenant.id}</TableCell>
                  <TableCell className="font-medium text-sm">{tenant.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{tenant.slug}</TableCell>
                  <TableCell>
                    <Badge variant={tenant.status === "active" ? "default" : "secondary"} className="uppercase text-[10px] tracking-widest px-2 py-0.5 rounded-sm">
                      {tenant.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm font-mono">{tenant.plan || "Standard"}</TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">{new Date(tenant.createdAt).toLocaleDateString()}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
