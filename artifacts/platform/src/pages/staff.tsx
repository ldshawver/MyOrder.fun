import { useListOrders, OrderStatus } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";

export default function StaffQueue() {
  const { data, isLoading } = useListOrders(
    { status: "pending", limit: 50 },
    { query: { queryKey: ["listOrders", "pending"] } }
  );

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="border-b border-border/50 pb-6">
        <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-title">Staff Queue</h1>
        <p className="text-muted-foreground" data-testid="text-subtitle">Orders requiring immediate attention.</p>
      </div>

      <div className="bg-card border border-border/50 rounded-sm shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/10">
            <TableRow className="border-border/50">
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Order ID</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Time</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Customer</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider text-right">Items</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider text-right">Total</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest">
                  Loading queue...
                </TableCell>
              </TableRow>
            ) : data?.orders?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest border-dashed">
                  Queue is clear.
                </TableCell>
              </TableRow>
            ) : (
              data?.orders?.map((order) => (
                <TableRow key={order.id} className="border-border/30 hover:bg-muted/20 group" data-testid={`row-queue-${order.id}`}>
                  <TableCell className="font-medium text-sm font-mono">#{order.id}</TableCell>
                  <TableCell className="text-sm text-muted-foreground font-mono">{new Date(order.createdAt).toLocaleTimeString()}</TableCell>
                  <TableCell className="text-sm font-medium">{order.customerName || "N/A"}</TableCell>
                  <TableCell className="text-sm text-right font-mono text-muted-foreground">{order.items.length}</TableCell>
                  <TableCell className="font-medium text-sm text-right font-mono">
                    ${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link href={`/orders/${order.id}`} className="inline-flex items-center text-xs font-semibold uppercase tracking-wider text-primary hover:text-primary/80 transition-colors" data-testid={`link-process-${order.id}`}>
                      Process <ChevronRight size={14} className="ml-1" />
                    </Link>
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
