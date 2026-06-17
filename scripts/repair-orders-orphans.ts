import { and, eq, isNull, sql } from "drizzle-orm";
import { auditLogsTable, db, labTechShiftsTable, orderItemsTable, ordersTable, tenantsTable, usersTable } from "@workspace/db";

type Summary = { scanned: number; archived: number; voided: number; skipped: number; reasons: Record<string, number> };
const summary: Summary = { scanned: 0, archived: 0, voided: 0, skipped: 0, reasons: {} };
function reason(name: string) { summary.reasons[name] = (summary.reasons[name] ?? 0) + 1; }

async function exists<T>(query: Promise<T[]>): Promise<boolean> { return (await query).length > 0; }

async function main() {
  const orders = await db.select().from(ordersTable);
  summary.scanned = orders.length;
  for (const order of orders) {
    const reasons: string[] = [];
    if (!(await exists(db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, order.customerId)).limit(1)))) reasons.push("missing_customer");
    if (!(await exists(db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.id, order.tenantId)).limit(1)))) reasons.push("missing_tenant");
    if (!(await exists(db.select({ id: orderItemsTable.id }).from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id)).limit(1)))) reasons.push("missing_order_items");
    if (order.assignedShiftId && !(await exists(db.select({ id: labTechShiftsTable.id }).from(labTechShiftsTable).where(and(eq(labTechShiftsTable.id, order.assignedShiftId), eq(labTechShiftsTable.tenantId, order.tenantId))).limit(1)))) reasons.push("impossible_route_reference");
    if (reasons.length === 0) { summary.skipped++; continue; }
    reasons.forEach(reason);
    if (["archived", "voided"].includes(order.status)) { summary.skipped++; continue; }
    const unreadable = reasons.includes("missing_customer") || reasons.includes("missing_tenant") || reasons.includes("missing_order_items");
    const newStatus = unreadable && order.status !== "completed" ? "voided" : "archived";
    await db.update(ordersTable).set(newStatus === "voided" ? { status: "voided", voidedAt: new Date(), routingStatus: "yellow", routingMessage: `Repair script voided structurally unreadable order: ${reasons.join(",")}` } : { status: "archived", archivedAt: new Date(), routingStatus: "yellow", routingMessage: `Repair script archived broken order: ${reasons.join(",")}` }).where(eq(ordersTable.id, order.id));
    await db.insert(auditLogsTable).values({
      actorId: order.customerId,
      actorEmail: "system@repair.local",
      actorRole: "system",
      action: "ORDER_REPAIR_ARCHIVE_OR_VOID",
      resourceType: "order",
      resourceId: String(order.id),
      metadata: { priorStatus: order.status, newStatus, reasons },
    }).catch(async () => {
      await db.execute(sql`INSERT INTO audit_logs (actor_id, actor_email, actor_role, action, resource_output, resource_id, metadata) VALUES (${order.customerId}, 'system@repair.local', 'system', 'ORDER_REPAIR_ARCHIVE_OR_VOID', 'order', ${String(order.id)}, ${JSON.stringify({ priorStatus: order.status, newStatus, reasons })}::jsonb)`);
    });
    if (newStatus === "voided") summary.voided++; else summary.archived++;
  }
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((err) => { console.error(JSON.stringify({ error: err?.message ?? String(err), summary }, null, 2)); process.exit(1); });
