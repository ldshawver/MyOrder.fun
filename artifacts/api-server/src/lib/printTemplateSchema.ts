import { z } from "zod";

/**
 * Strict receipt template layout. A template only chooses, orders and styles
 * server-defined fields; it never supplies values, expressions or printer
 * commands. Template text is plain text: control and format characters
 * (ESC, GS, NUL, bidi overrides, ...) are rejected at save time and stripped
 * again at render time.
 */

// C0/C1 controls, DEL, and Unicode format characters (bidi overrides,
// zero-width joiners). Printers interpret some of these as commands.
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
export const UNSAFE_TEMPLATE_TEXT = /[\u0000-\u001F\u007F-\u009F\p{Cf}]/u;
const plainText = (max: number) =>
  z.string().max(max).refine((value) => !UNSAFE_TEMPLATE_TEXT.test(value), {
    message: "Text may not contain control or format characters",
  });

const alignment = z.enum(["left", "center", "right"]);
const conditionalField = z.enum([
  "hasLogo", "hasCustomerName", "hasDiscount", "hasTax", "isCash", "hasChange", "hasQrCode",
]);

const common = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  enabled: z.boolean().default(true),
  align: alignment.default("left"),
  fontSize: z.number().int().min(8).max(48).default(12),
  bold: z.boolean().default(false),
  spacingBefore: z.number().int().min(0).max(48).default(0),
  spacingAfter: z.number().int().min(0).max(48).default(0),
  when: conditionalField.optional(),
}).strict();

/**
 * Every field maps to one server formatter in lib/print/receiptTemplateRenderer.
 * "logo" and "qrCode" are recognised for forward compatibility but do not
 * render yet; the renderer skips them and reports them as unsupported.
 */
export const RECEIPT_DATA_FIELDS = [
  "logo", "businessName", "businessAddress", "businessPhone", "orderNumber", "dateTime",
  "csr", "customerSafeName", "customerName", "items", "subtotal", "discounts", "salesTax",
  "tenderType", "paymentReference", "total", "cashReceived", "change", "thankYou", "qrCode",
] as const;
const dataType = z.enum(RECEIPT_DATA_FIELDS);

const dataBlock = common.extend({
  type: z.literal("data"),
  field: dataType,
  label: plainText(80).optional(),
  logoWidth: z.number().int().min(16).max(1024).optional(),
  // Item display options (only meaningful for field "items").
  showOption: z.boolean().optional(),
  showSku: z.boolean().optional(),
  showUnitPrice: z.boolean().optional(),
  showItemNotes: z.boolean().optional(),
}).strict();

const customTextBlock = common.extend({
  type: z.literal("customText"),
  text: plainText(500),
}).strict();

const separatorBlock = common.pick({ id: true, enabled: true, spacingBefore: true, spacingAfter: true }).extend({
  type: z.literal("separator"),
  style: z.enum(["solid", "dashed", "double"]),
}).strict();

export const receiptTemplateLayoutSchema = z.array(
  z.discriminatedUnion("type", [dataBlock, customTextBlock, separatorBlock]),
).max(100);

export type ReceiptTemplateLayout = z.infer<typeof receiptTemplateLayoutSchema>;
export type ReceiptTemplateBlock = ReceiptTemplateLayout[number];

export function parseReceiptTemplateLayout(value: unknown): ReceiptTemplateLayout {
  return receiptTemplateLayoutSchema.parse(value);
}
