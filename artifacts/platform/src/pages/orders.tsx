import { useState } from "react";
import { useListOrders } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";

export default function Orders() {
  const { data, isLoading } = useListOrders(
    { limit: 50 },
    { query: { queryKey: ["listOrders"] } }
  );

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-end justify-between border-b border-border/50 pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2" data-testid="text-title">Orders</h1>
          <p className="text-muted-foreground">Manage and track your organization's orders.</p>
        </div>
        <Link href="/orders/new" className="bg-primary text-primary-foreground px-4 py-2 rounded-sm text-sm font-medium hover:opacity-90 transition-opacity" data-testid="link-new-order">
          New Order
        </Link>
      </div>

      <div className="bg-card border border-border/50 rounded-sm shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/10">
            <TableRow className="border-border/50">
              <TableHead className="w-[120px] font-semibold text-xs uppercase tracking-wider">Order ID</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Date</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Customer</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Status</TableHead>
              <TableHead className="font-semibold text-xs uppercase tracking-wider">Payment</TableHead>
              <TableHead className="text-right font-semibold text-xs uppercase tracking-wider">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground font-mono text-xs uppercase tracking-widest">
                  Loading orders...
                </TableCell>
              </TableRow>
            ) : data?.orders?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground border-border/50 font-mono text-xs uppercase tracking-widest" data-testid="text-empty-state">
                  No orders found.
                </TableCell>
              </TableRow>
            ) : (
              data?.orders?.map((order) => (
                <TableRow key={order.id} className="cursor-pointer hover:bg-muted/20 border-border/30 transition-colors group" data-testid={`row-order-${order.id}`}>
                  <TableCell className="font-medium font-mono text-sm">
                    <Link href={`/orders/${order.id}`} className="block h-full w-full group-hover:text-primary transition-colors" data-testid={`link-order-${order.id}`}>
                      #{order.id}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm font-mono">
                    <Link href={`/orders/${order.id}`} className="block h-full w-full">
                      {new Date(order.createdAt).toLocaleDateString()}
                    </Link>
                  </TableCell>
                  <TableCell className="font-medium text-sm">
                    <Link href={`/orders/${order.id}`} className="block h-full w-full">
                      {order.customerName || "N/A"}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/orders/${order.id}`} className="block h-full w-full">
                      <Badge variant={order.status === "delivered" ? "default" : "secondary"} className="uppercase text-[10px] tracking-widest px-2 py-0.5 rounded-sm">
                        {order.status}
                      </Badge>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/orders/${order.id}`} className="block h-full w-full">
                      <Badge variant={order.paymentStatus === "paid" ? "default" : "outline"} className="uppercase text-[10px] tracking-widest px-2 py-0.5 rounded-sm">
                        {order.paymentStatus}
                      </Badge>
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-medium text-sm font-mono">
                    <Link href={`/orders/${order.id}`} className="block h-full w-full">
                      ${order.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
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
