import { z } from "zod";

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

const dataType = z.enum([
  "logo", "businessName", "orderNumber", "dateTime", "csr", "customerSafeName",
  "customerName", "items", "subtotal", "discounts", "salesTax", "tenderType", "total",
  "cashReceived", "change", "thankYou", "qrCode",
]);

const dataBlock = common.extend({
  type: z.literal("data"),
  field: dataType,
  label: z.string().max(80).optional(),
  logoWidth: z.number().int().min(16).max(1024).optional(),
}).strict();

const customTextBlock = common.extend({
  type: z.literal("customText"),
  text: z.string().max(500),
}).strict();

const separatorBlock = common.pick({ id: true, enabled: true, spacingBefore: true, spacingAfter: true }).extend({
  type: z.literal("separator"),
  style: z.enum(["solid", "dashed", "double"]),
}).strict();

export const receiptTemplateLayoutSchema = z.array(
  z.discriminatedUnion("type", [dataBlock, customTextBlock, separatorBlock]),
).max(100);

export type ReceiptTemplateLayout = z.infer<typeof receiptTemplateLayoutSchema>;

export function parseReceiptTemplateLayout(value: unknown): ReceiptTemplateLayout {
  return receiptTemplateLayoutSchema.parse(value);
}
