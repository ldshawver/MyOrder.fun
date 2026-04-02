import { useListAuditLogs } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function GlobalAdminAudit() {
  const { data, isLoading } = useListAuditLogs(
    { limit: 100 },
    { query: { queryKey: ["listAuditLogs"] } }
  );

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="border-b border-border/50 pb-6">
        <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-title">Audit Logs</h1>
        <p className="text-muted-foreground" data-testid="text-subtitle">System-wide activity monitoring.</p>
      </div>

      <div className="bg-card border border-border/50 rounded-sm shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/10">
            <TableRow className="border-border/50">
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Timestamp</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Actor</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Action</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Resource</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">IP Address</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest">
                  Loading audit trail...
                </TableCell>
              </TableRow>
            ) : data?.entries?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest border-dashed">
                  No audit logs found.
                </TableCell>
              </TableRow>
            ) : (
              data?.entries?.map((log) => (
                <TableRow key={log.id} className="border-border/30 hover:bg-muted/20" data-testid={`row-log-${log.id}`}>
                  <TableCell className="whitespace-nowrap text-xs font-mono text-muted-foreground">
                    {new Date(log.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-sm">{log.actorEmail}</div>
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mt-0.5">{log.actorRole}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-widest rounded-sm bg-background">
                      {log.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm font-mono text-muted-foreground">
                    {log.resourceType} {log.resourceId ? `#${log.resourceId}` : ""}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {log.ipAddress || "Unknown"}
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
