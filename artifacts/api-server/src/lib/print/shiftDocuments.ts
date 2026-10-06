/**
 * shiftDocuments.ts — clock in/out, deposit and shift reports.
 *
 * Everything printed for a shift is loaded here from the tenant's own shift
 * record (tenant-filtered) and routed by document type through the shift's
 * location (CSR box → inventory location). Nothing comes from the request.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  labTechShiftsTable,
  usersTable,
  csrBoxesTable,
  inventoryLocationsTable,
  shiftInventoryItemsTable,
  inventoryTemplatesTable,
  type PrintPrinter,
} from "@workspace/db";
import { getTenantSettings } from "../../config/tenantConfig";
import { logger } from "../logger";
import { toCents } from "./receiptData";
import {
  buildClockSlip,
  buildDepositSlip,
  buildShiftInventoryReport,
  buildShiftSalesReport,
  displayPersonName,
  type ShiftInventoryRow,
  type ShiftReportContext,
  type ShiftSalesData,
} from "./documents";
import { queueDocumentPrint, type QueueDocumentResult } from "./documentJobs";

const log = logger.child({ module: "shiftDocuments" });

export interface ShiftDocumentContext {
  readonly tenantId: number;
  readonly shiftId: number;
  readonly employeeUserId: number;
  readonly employeeName: string;
  readonly businessName: string;
  readonly timezone: string;
  readonly locationId: number | null;
  readonly locationName: string | null;
  readonly clockedInAt: string;
  readonly clockedOutAt: string | null;
  readonly cashBankStartCents: number;
}

/** The inventory location of a tenant shift's CSR box, if any. */
export async function shiftLocationId(tenantId: number, shiftId: number): Promise<number | null> {
  const [shift] = await db.select({ box: labTechShiftsTable.boxAssignmentId }).from(labTechShiftsTable)
    .where(and(eq(labTechShiftsTable.tenantId, tenantId), eq(labTechShiftsTable.id, shiftId))).limit(1);
  if (!shift?.box) return null;
  const [box] = await db.select({ id: csrBoxesTable.id }).from(csrBoxesTable)
    .where(and(eq(csrBoxesTable.tenantId, tenantId), eq(csrBoxesTable.slug, shift.box))).limit(1);
  if (!box) return null;
  const [location] = await db.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable)
    .where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.csrBoxId, box.id))).limit(1);
  return location?.id ?? null;
}

/** Loads a shift of this tenant; null when the shift is not the tenant's. */
export async function loadShiftDocumentContext(tenantId: number, shiftId: number): Promise<ShiftDocumentContext | null> {
  const [shift] = await db.select().from(labTechShiftsTable)
    .where(and(eq(labTechShiftsTable.tenantId, tenantId), eq(labTechShiftsTable.id, shiftId))).limit(1);
  if (!shift) return null;
  const [employee] = await db.select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
    .from(usersTable).where(eq(usersTable.id, shift.techId)).limit(1);
  let location: { id: number; name: string } | undefined;
  if (shift.boxAssignmentId) {
    const [box] = await db.select({ id: csrBoxesTable.id }).from(csrBoxesTable)
      .where(and(eq(csrBoxesTable.tenantId, tenantId), eq(csrBoxesTable.slug, shift.boxAssignmentId))).limit(1);
    if (box) {
      [location] = await db.select({ id: inventoryLocationsTable.id, name: inventoryLocationsTable.name }).from(inventoryLocationsTable)
        .where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.csrBoxId, box.id))).limit(1);
    }
  }
  const tenant = await getTenantSettings(tenantId);
  return {
    tenantId,
    shiftId: shift.id,
    employeeUserId: shift.techId,
    employeeName: displayPersonName(employee?.firstName, employee?.lastName),
    businessName: tenant?.business.publicBusinessName ?? "MyOrder.fun",
    timezone: tenant?.business.timezone ?? "America/Los_Angeles",
    locationId: location?.id ?? null,
    locationName: location?.name ?? null,
    clockedInAt: new Date(shift.clockedInAt).toISOString(),
    clockedOutAt: shift.clockedOutAt ? new Date(shift.clockedOutAt).toISOString() : null,
    cashBankStartCents: toCents(shift.cashBankStart),
  };
}

const num = (value: unknown): number | null => (value === null || value === undefined || value === "" ? null : Number(value));

/** The shift's recorded inventory rows with PAR from their templates. */
export async function loadShiftInventoryRows(shiftId: number): Promise<ShiftInventoryRow[]> {
  const items = await db.select().from(shiftInventoryItemsTable)
    .where(eq(shiftInventoryItemsTable.shiftId, shiftId)).orderBy(asc(shiftInventoryItemsTable.displayOrder));
  const templateIds = [...new Set(items.map((item) => item.templateItemId).filter((id): id is number => id != null))];
  const templates = templateIds.length
    ? await db.select({ id: inventoryTemplatesTable.id, parLevel: inventoryTemplatesTable.parLevel })
        .from(inventoryTemplatesTable).where(inArray(inventoryTemplatesTable.id, templateIds))
    : [];
  const par = new Map(templates.map((template) => [template.id, num(template.parLevel)]));
  return items.filter((item) => item.rowType === "item").map((item) => ({
    section: item.sectionName ?? null,
    name: item.itemName,
    unit: item.unitType ?? null,
    start: num(item.quantityStart),
    sold: num(item.quantitySold),
    counted: num(item.quantityEndActual),
    par: item.templateItemId ? par.get(item.templateItemId) ?? null : null,
    flagged: Boolean(item.isFlagged),
  }));
}

export function shiftReportContext(ctx: ShiftDocumentContext, generatedAt: string): ShiftReportContext {
  return {
    businessName: ctx.businessName, locationName: ctx.locationName, employeeName: ctx.employeeName,
    shiftRef: String(ctx.shiftId), timezone: ctx.timezone, clockedInAt: ctx.clockedInAt,
    clockedOutAt: ctx.clockedOutAt, generatedAt,
  };
}

const PAYMENT_LABELS: Record<string, string> = { cash: "Cash", card: "Card", comp: "Comp", split: "Split", other: "Other", cash_app: "Cash App", paypal_card: "PayPal" };

/** Normalises computeShiftStats output (money in dollars) to report data in cents. */
export function shiftSalesData(stats: Record<string, unknown>): ShiftSalesData {
  const totals = (stats.paymentTotals ?? {}) as Record<string, unknown>;
  const items = Array.isArray(stats.byItem) ? (stats.byItem as Array<Record<string, unknown>>) : [];
  const commission = stats.commission;
  return {
    orderCount: Number(stats.orderCount ?? 0) || 0,
    totalRevenueCents: toCents(stats.totalRevenue),
    paymentTotals: Object.entries(totals).map(([method, amount]) => ({ label: PAYMENT_LABELS[method] ?? method, cents: toCents(amount) })),
    items: items.map((item) => ({
      name: String(item.name ?? item.itemName ?? "Item"),
      quantity: Number(item.quantity ?? item.qty ?? 0) || 0,
      revenueCents: toCents(item.revenue ?? item.total ?? 0),
    })),
    commissionCents: typeof commission === "number" || typeof commission === "string" ? toCents(commission) : null,
  };
}

interface ShiftPrint {
  documentType: "CLOCK_IN" | "CLOCK_OUT" | "DEPOSIT" | "INVENTORY_STOCK_LIST" | "REPORT";
  jobType: string;
  render: Parameters<typeof queueDocumentPrint>[0]["render"];
}

/**
 * Queues and dispatches shift documents. Automatic prints never block the
 * shift: failures are logged and recorded on the job.
 */
async function printForShift(
  ctx: ShiftDocumentContext,
  documents: ShiftPrint[],
  options: { suffix: string; legacyFallback?: () => Promise<PrintPrinter | null> },
): Promise<QueueDocumentResult[]> {
  const { dispatchJob } = await import("../printService");
  const results: QueueDocumentResult[] = [];
  for (const document of documents) {
    try {
      const result = await queueDocumentPrint({
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        shiftId: ctx.shiftId,
        operatorUserId: ctx.employeeUserId,
        documentType: document.documentType,
        jobType: document.jobType,
        idempotencyKey: `${document.jobType}:${ctx.tenantId}:${ctx.shiftId}${options.suffix}`,
        render: document.render,
        metadata: { shiftId: ctx.shiftId },
        legacyFallback: options.legacyFallback,
      });
      if (result.status === "queued") dispatchJob(result.job, result.printer).catch(() => {});
      results.push(result);
    } catch (err) {
      log.warn({ event: "shift_document_failed", shiftId: ctx.shiftId, jobType: document.jobType, err: err instanceof Error ? err.message : String(err) },
        "shift document could not be queued");
    }
  }
  return results;
}

/** Clock-in: CLOCK_IN slip and the beginning inventory list. */
export async function printClockInDocuments(ctx: ShiftDocumentContext, legacyFallback?: () => Promise<PrintPrinter | null>) {
  const rows = await loadShiftInventoryRows(ctx.shiftId);
  const report = shiftReportContext(ctx, ctx.clockedInAt);
  return printForShift(ctx, [
    {
      documentType: "CLOCK_IN", jobType: "shift_clock_in",
      render: { kind: "thermal", lines: () => buildClockSlip({ event: "in", businessName: ctx.businessName, locationName: ctx.locationName, employeeName: ctx.employeeName, at: ctx.clockedInAt, timezone: ctx.timezone, shiftRef: String(ctx.shiftId) }) },
    },
    { documentType: "INVENTORY_STOCK_LIST", jobType: "shift_beginning_inventory", render: { kind: "report", report: () => buildShiftInventoryReport(report, "beginning", rows) } },
  ], { suffix: "", legacyFallback });
}

export interface ClockOutFigures {
  stats: Record<string, unknown>;
  expectedCash: number | null;
  countedCash: number | null;
  variance: number | null;
}

/** Clock-out: CLOCK_OUT slip, deposit, sales report, ending inventory and restock list. */
export async function printClockOutDocuments(ctx: ShiftDocumentContext, figures: ClockOutFigures, legacyFallback?: () => Promise<PrintPrinter | null>) {
  const rows = await loadShiftInventoryRows(ctx.shiftId);
  const clockedOutAt = ctx.clockedOutAt ?? new Date().toISOString();
  const report = shiftReportContext({ ...ctx, clockedOutAt }, clockedOutAt);
  const sales = shiftSalesData(figures.stats);
  const cashSalesCents = sales.paymentTotals.find((total) => total.label === "Cash")?.cents ?? 0;
  return printForShift(ctx, [
    {
      documentType: "CLOCK_OUT", jobType: "shift_clock_out",
      render: { kind: "thermal", lines: () => buildClockSlip({ event: "out", businessName: ctx.businessName, locationName: ctx.locationName, employeeName: ctx.employeeName, at: clockedOutAt, timezone: ctx.timezone, shiftRef: String(ctx.shiftId) }) },
    },
    {
      documentType: "DEPOSIT", jobType: "shift_deposit",
      render: { kind: "thermal", lines: () => buildDepositSlip({
        businessName: ctx.businessName, locationName: ctx.locationName, employeeName: ctx.employeeName, shiftRef: String(ctx.shiftId),
        timezone: ctx.timezone, clockedInAt: ctx.clockedInAt, clockedOutAt,
        cashBankStartCents: ctx.cashBankStartCents, cashSalesCents,
        expectedCashCents: figures.expectedCash === null ? ctx.cashBankStartCents + cashSalesCents : toCents(figures.expectedCash),
        countedCashCents: figures.countedCash === null ? null : toCents(figures.countedCash),
        varianceCents: figures.variance === null ? null : toCents(figures.variance),
        paymentTotals: sales.paymentTotals.filter((total) => total.cents !== 0),
      }) },
    },
    { documentType: "REPORT", jobType: "shift_sales", render: { kind: "report", report: () => buildShiftSalesReport(report, sales) } },
    { documentType: "INVENTORY_STOCK_LIST", jobType: "shift_ending_inventory", render: { kind: "report", report: () => buildShiftInventoryReport(report, "ending", rows) } },
    { documentType: "INVENTORY_STOCK_LIST", jobType: "shift_restock", render: { kind: "report", report: () => buildShiftInventoryReport(report, "restock", rows) } },
  ], { suffix: "", legacyFallback });
}

/** Manual restock list for one of the tenant's shifts (admin action). Not dispatched here. */
export async function queueRestockList(ctx: ShiftDocumentContext, requestKey: string): Promise<QueueDocumentResult> {
  const rows = await loadShiftInventoryRows(ctx.shiftId);
  const report = shiftReportContext(ctx, new Date().toISOString());
  return queueDocumentPrint({
    tenantId: ctx.tenantId,
    locationId: ctx.locationId,
    shiftId: ctx.shiftId,
    documentType: "INVENTORY_STOCK_LIST",
    jobType: "shift_restock",
    idempotencyKey: `shift_restock:${ctx.tenantId}:${ctx.shiftId}:manual:${requestKey}`,
    render: { kind: "report", report: () => buildShiftInventoryReport(report, "restock", rows) },
    metadata: { shiftId: ctx.shiftId, manual: true },
    recordNoRoute: false,
  });
}
