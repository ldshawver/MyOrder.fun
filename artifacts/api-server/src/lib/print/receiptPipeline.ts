/**
 * receiptPipeline.ts — the single path from an order (or sample) to receipt text.
 *
 *   order snapshot ─► loadReceiptData ─► ReceiptData ─┐
 *   sample ──────────────────────────► ReceiptData ───┤
 *                                                     ├─► tenant default template?
 *                                                     │     yes: renderReceiptFromTemplate ─► encoder
 *                                                     │     no / invalid: legacy builder (fallback)
 *                                                     ▼
 *                                              receipt text ─► print job ─► registered printer ─► bridge
 *
 * Automatic receipts, reprints and previews all go through here, so their
 * data and rendering cannot drift. This module never prints: callers store the
 * text on a print job and the existing registered-printer dispatch sends it.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  ordersTable,
  orderItemsTable,
  usersTable,
  adminSettingsTable,
  printTemplatesTable,
  paymentAttemptsTable,
  paymentCapturesTable,
} from "@workspace/db";
import { getTenantSettings } from "../../config/tenantConfig";
import { getBranding } from "../../config/brandingConfig";
import { logger } from "../logger";
import { getSettings } from "../printService";
import { charWidth } from "./widths";
import { renderCustomerReceipt, renderCustomerReceiptBody, encodeStoredReceiptText } from "../receiptRenderer";
import { buildReceiptData, type ReceiptData, type ReceiptLineNameMode } from "./receiptData";
import { renderReceiptFromTemplate, type SkippedBlock } from "./receiptTemplateRenderer";
import { encodeReceiptEscPos, encodeReceiptPlain } from "./receiptEncoders";

const log = logger.child({ module: "receiptPipeline" });

export const PREVIEW_BANNER = "*** SAMPLE / PREVIEW - NOT A RECEIPT ***";

export interface ReceiptTemplateRecord {
  readonly id: number;
  readonly version: number;
  readonly paperWidth: string;
  readonly layout: unknown;
}

export interface RenderedReceipt {
  readonly text: string;
  readonly source: "template" | "fallback";
  readonly templateId: number | null;
  readonly templateVersion: number | null;
  readonly fallbackReason: "no-template" | "invalid-template" | null;
  readonly skipped: readonly SkippedBlock[];
}

/** Legacy global presentation settings, used only by the fallback builder. */
export interface LegacyReceiptPresentation {
  readonly paperWidth: string;
  readonly dualBrandName: string | null;
  readonly footerMessage: string | null;
  readonly receiptTemplateStyle: "clean" | "classic" | "compact";
  readonly showOperatorName: boolean;
  readonly showDiscreetNotice: boolean;
  readonly receiptBrandName: string;
}

// ── Loading ───────────────────────────────────────────────────────────────────

/** The tenant's active default receipt template; never another tenant's. */
export async function resolveTenantReceiptTemplate(tenantId: number): Promise<ReceiptTemplateRecord | null> {
  const [row] = await db
    .select({
      id: printTemplatesTable.id,
      version: printTemplatesTable.version,
      paperWidth: printTemplatesTable.paperWidth,
      layout: printTemplatesTable.templateJson,
    })
    .from(printTemplatesTable)
    .where(and(
      eq(printTemplatesTable.tenantId, tenantId),
      eq(printTemplatesTable.jobType, "receipt"),
      eq(printTemplatesTable.isActive, true),
      eq(printTemplatesTable.isDefault, true),
    ))
    .orderBy(desc(printTemplatesTable.updatedAt))
    .limit(1);
  return row ?? null;
}

export async function loadLegacyReceiptPresentation(tenantId: number): Promise<LegacyReceiptPresentation> {
  const settings = await getSettings();
  let receiptBrandName = "MYORDER.FUN";
  try {
    const displayName = (await getBranding(tenantId))?.supplier.displayName;
    if (typeof displayName === "string" && displayName.toLowerCase().includes("lucifer")) receiptBrandName = "LUCIFER CRUZ";
  } catch { /* non-critical: keep the platform wordmark */ }
  const style = settings.receiptTemplateStyle;
  return {
    paperWidth: settings.paperWidth ?? "80mm",
    dualBrandName: settings.brandName ?? null,
    footerMessage: settings.footerMessage ?? null,
    receiptTemplateStyle: style === "classic" || style === "compact" ? style : "clean",
    showOperatorName: settings.includeOperatorName !== false,
    showDiscreetNotice: settings.showDiscreetNotice ?? false,
    receiptBrandName,
  };
}

/**
 * Builds ReceiptData for one of the tenant's orders from its stored snapshot:
 * order-line names and prices, and the order's financial/tax snapshot.
 * Returns null when the order does not belong to the tenant.
 */
export async function loadReceiptData(tenantId: number, orderId: number): Promise<ReceiptData | null> {
  const [order] = await db.select().from(ordersTable)
    .where(and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.id, orderId))).limit(1);
  if (!order) return null;

  const items = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id));
  const person = async (userId: number | null | undefined) => {
    if (!userId) return null;
    const [row] = await db.select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
      .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    return row ?? null;
  };
  const [adminSettings] = await db.select({ mode: adminSettingsTable.receiptLineNameMode })
    .from(adminSettingsTable).where(eq(adminSettingsTable.tenantId, tenantId)).limit(1);
  const tenant = await getTenantSettings(tenantId);

  let providerCaptureId: string | null = null;
  const attempts = await db.select({ id: paymentAttemptsTable.id }).from(paymentAttemptsTable)
    .where(and(eq(paymentAttemptsTable.tenantId, tenantId), eq(paymentAttemptsTable.orderId, order.id)));
  if (attempts.length) {
    const [capture] = await db.select({ providerCaptureId: paymentCapturesTable.providerCaptureId })
      .from(paymentCapturesTable)
      .where(and(
        eq(paymentCapturesTable.tenantId, tenantId),
        inArray(paymentCapturesTable.paymentAttemptId, attempts.map((attempt) => attempt.id)),
      ))
      .orderBy(desc(paymentCapturesTable.capturedAt))
      .limit(1);
    providerCaptureId = capture?.providerCaptureId ?? null;
  }

  const mode = adminSettings?.mode;
  return buildReceiptData({
    business: {
      name: tenant?.business.publicBusinessName ?? null,
      address: (tenant?.business.businessAddress as Record<string, unknown> | undefined) ?? null,
      phone: tenant?.business.supportPhone ?? null,
      timezone: tenant?.business.timezone ?? null,
    },
    order,
    items: items.map((item) => ({
      catalogItemName: item.catalogItemName,
      receiptName: item.receiptName,
      alavontName: item.alavontName,
      luciferCruzName: item.luciferCruzName,
      optionLabel: item.optionLabelSnapshot,
      sku: item.skuSnapshot,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
      note: null,
    })),
    lineNameMode: mode === "alavont_only" || mode === "both" ? mode : "lucifer_only",
    customer: order.customerNameSnapshot
      ? { firstName: order.customerNameSnapshot, lastName: null }
      : await person(order.customerId),
    employee: await person(order.assignedCsrUserId),
    providerCaptureId,
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/** Maps ReceiptData onto the legacy builder's input so the fallback is complete too. */
function legacyReceiptOrder(data: ReceiptData, presentation: LegacyReceiptPresentation) {
  const dollars = (cents: number | null) => (cents === null ? undefined : cents / 100);
  return {
    id: Number(data.order.number) || 0,
    orderNumber: data.order.number,
    createdAt: data.order.placedAt,
    customerName: data.customer.fullName ?? undefined,
    fulfillmentType: data.order.fulfillment ?? undefined,
    notes: data.order.note ?? undefined,
    paymentStatus: data.payment.status ?? undefined,
    paymentMethod: data.payment.tenderLabel ?? undefined,
    // Names are already resolved and sanitised; "both" keeps a secondary line.
    receiptLineNameMode: "both" as ReceiptLineNameMode,
    items: data.items.map((item) => ({
      name: item.optionLabel ? `${item.displayName} - ${item.optionLabel}` : item.displayName,
      alavontName: item.optionLabel ? `${item.displayName} - ${item.optionLabel}` : item.displayName,
      luciferCruzName: item.secondaryName ?? (item.optionLabel ? `${item.displayName} - ${item.optionLabel}` : item.displayName),
      quantity: item.quantity,
      unitPrice: item.unitPriceCents / 100,
      totalPrice: item.lineTotalCents / 100,
      notes: item.note ?? undefined,
    })),
    subtotal: data.totals.subtotalCents / 100,
    discount: data.totals.discountCents / 100,
    taxableSubtotal: dollars(data.totals.taxableSubtotalCents),
    tax: data.totals.taxCents / 100,
    taxRate: data.totals.taxRatePercent ? Number(data.totals.taxRatePercent) / 100 : undefined,
    taxJurisdiction: data.totals.taxJurisdiction ?? undefined,
    total: data.totals.totalCents / 100,
    customerCreditApplied: data.totals.customerCreditCents / 100,
    remainingPaymentMethod: data.payment.tenderLabel ?? undefined,
    remainingPaymentAmount: dollars(data.payment.tenderAmountCents),
    cashTendered: dollars(data.payment.cashReceivedCents),
    changeGiven: dollars(data.payment.changeCents),
    providerCaptureReference: data.payment.referenceMasked ?? undefined,
    paperWidth: presentation.paperWidth,
    dualBrandName: presentation.dualBrandName ?? undefined,
    footerMessage: presentation.footerMessage ?? undefined,
    showDiscreetNotice: presentation.showDiscreetNotice,
    showOperatorName: presentation.showOperatorName,
    operatorName: data.employeeName ?? undefined,
    receiptTemplateStyle: presentation.receiptTemplateStyle,
    receiptBrandName: presentation.receiptBrandName,
  };
}

/**
 * Renders receipt text. Uses the tenant template when it is valid; otherwise
 * the legacy builder, so a missing or broken template never blocks printing.
 * "escpos" output is stored on print jobs; "plain" is for on-screen preview.
 */
export function renderReceipt(
  data: ReceiptData,
  template: ReceiptTemplateRecord | null,
  presentation: LegacyReceiptPresentation,
  output: "escpos" | "plain",
  /** Columns of the printer this will print on; overrides the template/settings width. */
  columns?: number,
): RenderedReceipt {
  if (columns) presentation = { ...presentation, paperWidth: columns <= 32 ? "58mm" : "80mm" };
  if (template) {
    try {
      const lines = renderReceiptFromTemplate(template.layout, data, columns ?? charWidth(template.paperWidth));
      return {
        text: output === "escpos" ? encodeStoredReceiptText(encodeReceiptEscPos(lines)) : encodeReceiptPlain(lines),
        source: "template",
        templateId: template.id,
        templateVersion: template.version,
        fallbackReason: null,
        skipped: lines.skipped,
      };
    } catch (err) {
      log.warn({ event: "receipt_template_invalid", templateId: template.id, err: err instanceof Error ? err.message : String(err) },
        "receipt template invalid; using fallback receipt");
      return renderFallback(data, presentation, output, template, "invalid-template");
    }
  }
  return renderFallback(data, presentation, output, null, "no-template");
}

function renderFallback(
  data: ReceiptData,
  presentation: LegacyReceiptPresentation,
  output: "escpos" | "plain",
  template: ReceiptTemplateRecord | null,
  reason: "no-template" | "invalid-template",
): RenderedReceipt {
  const order = legacyReceiptOrder(data, presentation);
  const text = output === "escpos" ? renderCustomerReceipt(order) : renderCustomerReceiptBody(order);
  return { text, source: "fallback", templateId: template?.id ?? null, templateVersion: template?.version ?? null, fallbackReason: reason, skipped: [] };
}

/** Receipt text for a stored print job of one of the tenant's orders. */
export async function renderOrderReceipt(tenantId: number, orderId: number, columns?: number): Promise<{ receipt: RenderedReceipt; data: ReceiptData } | null> {
  const data = await loadReceiptData(tenantId, orderId);
  if (!data) return null;
  const [template, presentation] = await Promise.all([
    resolveTenantReceiptTemplate(tenantId),
    loadLegacyReceiptPresentation(tenantId),
  ]);
  return { receipt: renderReceipt(data, template, presentation, "escpos", columns), data };
}

/** Preview text built from fixed synthetic data; never a real order, never printed. */
export function renderReceiptPreview(
  data: ReceiptData,
  template: ReceiptTemplateRecord | null,
  presentation: LegacyReceiptPresentation,
): RenderedReceipt {
  if (data.source !== "sample") throw new Error("Receipt previews only render synthetic sample data");
  const receipt = renderReceipt(data, template, presentation, "plain");
  return { ...receipt, text: `${PREVIEW_BANNER}\n\n${receipt.text}\n\n${PREVIEW_BANNER}` };
}

