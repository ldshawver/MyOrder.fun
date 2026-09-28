/**
 * Receipt Phase 1: data contract, template renderer, encoders and fallback.
 */
import { describe, expect, it, vi } from "vitest";

// The pipeline module imports the database and tenant config; renderReceipt
// itself is pure, so these stubs are never exercised here.
vi.mock("@workspace/db", () => new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : {}) }));
vi.mock("../../config/tenantConfig", () => ({ getTenantSettings: vi.fn() }));
vi.mock("../../config/brandingConfig", () => ({ getBranding: vi.fn() }));
vi.mock("../printService", () => ({ getSettings: vi.fn() }));
vi.mock("../logger", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));

import {
  buildReceiptData,
  maskReference,
  sanitizeReceiptText,
  toCents,
  SAMPLE_RECEIPT_DATA,
  type ReceiptSnapshotInput,
} from "../print/receiptData";
import { renderReceiptFromTemplate, textSizeFor } from "../print/receiptTemplateRenderer";
import { encodeReceiptEscPos, encodeReceiptPlain } from "../print/receiptEncoders";
import { renderReceipt, renderReceiptPreview, PREVIEW_BANNER, type LegacyReceiptPresentation } from "../print/receiptPipeline";
import { decodeStoredReceiptText } from "../receiptRenderer";
import { receiptTemplateLayoutSchema } from "../printTemplateSchema";

const PRESENTATION: LegacyReceiptPresentation = {
  paperWidth: "80mm", dualBrandName: null, footerMessage: "Thanks for shopping", receiptTemplateStyle: "clean",
  showOperatorName: true, showDiscreetNotice: false, receiptBrandName: "MYORDER.FUN",
};

function snapshot(overrides: Partial<ReceiptSnapshotInput["order"]> = {}, extra: Partial<ReceiptSnapshotInput> = {}): ReceiptSnapshotInput {
  return {
    business: { name: "Lucifer Cruz", address: { line1: "1 Main St", city: "Sacramento", region: "CA", postalCode: "95814" }, phone: "(916) 555-0100", timezone: "America/Los_Angeles" },
    order: {
      id: 12345, createdAt: "2026-09-28T10:05:00.000Z", orderType: "pickup", paymentStatus: "paid", paymentMethod: "cash",
      subtotal: "52.00", grossSubtotal: "52.00", discountTotal: "2.00", taxableSubtotal: "50.00", tax: "4.00", total: "54.00",
      customerCreditApplied: "0.00", remainingTenderAmount: "54.00", amountTendered: "60.00", changeGiven: "6.00",
      taxSnapshot: { taxRate: 0.08, jurisdiction: "Sacramento, California" },
      ...overrides,
    },
    items: [
      { catalogItemName: "Catalog Name A", receiptName: "Product A", quantity: 2, unitPrice: "10.00", totalPrice: "20.00" },
      { catalogItemName: "Catalog Name B", receiptName: "Another Product", quantity: 1, unitPrice: "32.00", totalPrice: "32.00" },
    ],
    lineNameMode: "lucifer_only",
    customer: { firstName: "Casey", lastName: "Jones" },
    employee: { firstName: "Luke", lastName: "S" },
    providerCaptureId: null,
    ...extra,
  };
}

const FULL_TEMPLATE = [
  { type: "data", id: "biz", field: "businessName", align: "center", bold: true, fontSize: 20 },
  { type: "data", id: "addr", field: "businessAddress", align: "center" },
  { type: "data", id: "phone", field: "businessPhone", align: "center" },
  { type: "separator", id: "s1", style: "dashed" },
  { type: "data", id: "num", field: "orderNumber" },
  { type: "data", id: "dt", field: "dateTime" },
  { type: "data", id: "emp", field: "csr" },
  { type: "separator", id: "s2", style: "solid" },
  { type: "data", id: "items", field: "items" },
  { type: "separator", id: "s3", style: "solid" },
  { type: "data", id: "sub", field: "subtotal" },
  { type: "data", id: "disc", field: "discounts" },
  { type: "data", id: "tax", field: "salesTax" },
  { type: "data", id: "tot", field: "total", bold: true },
  { type: "data", id: "tender", field: "tenderType" },
  { type: "data", id: "ref", field: "paymentReference" },
  { type: "data", id: "cash", field: "cashReceived" },
  { type: "data", id: "chg", field: "change" },
  { type: "separator", id: "s4", style: "double" },
  { type: "data", id: "ty", field: "thankYou", align: "center" },
];

const plain = (layout: unknown, data = buildReceiptData(snapshot()), width = 48) =>
  encodeReceiptPlain(renderReceiptFromTemplate(layout, data, width)).split("\n");

// Every ESC/GS sequence the encoder is allowed to emit.
const ALLOWED_COMMANDS = ["\x1b@", "\x1ba\x00", "\x1ba\x01", "\x1ba\x02", "\x1bE\x00", "\x1bE\x01", "\x1d!\x00", "\x1d!\x01", "\x1d!\x11", "\x1bd\x03", "\x1dVA\x00"];
function withoutAllowedCommands(bytes: string): string {
  return ALLOWED_COMMANDS.reduce((acc, command) => acc.split(command).join(""), bytes);
}

describe("receipt data contract", () => {
  it("uses the order's stored money snapshot, never recomputing totals", () => {
    const data = buildReceiptData(snapshot({ total: "99.99" }));
    expect(data.totals.totalCents).toBe(9999);
    expect(data.items.reduce((sum, item) => sum + item.lineTotalCents, 0)).toBe(5200);
    expect(plain(FULL_TEMPLATE, data).some((line) => /^TOTAL\s+\$99\.99$/.test(line))).toBe(true);
  });

  it("reads historical line names and prices from the order snapshot", () => {
    const data = buildReceiptData(snapshot());
    expect(data.items[0]).toMatchObject({ displayName: "Product A", quantity: 2, unitPriceCents: 1000, lineTotalCents: 2000 });
    expect(JSON.stringify(data)).not.toContain("Catalog Name A");
  });

  it("is deeply immutable", () => {
    const data = buildReceiptData(snapshot());
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.totals)).toBe(true);
    expect(Object.isFrozen(data.items[0])).toBe(true);
    expect(() => { (data.totals as { totalCents: number }).totalCents = 1; }).toThrow();
  });

  it("parses decimal strings to exact cents", () => {
    expect(toCents("16.31")).toBe(1631);
    expect(toCents("0.10")).toBe(10);
    expect(toCents("1234.5")).toBe(123450);
    expect(toCents("2.005")).toBe(201);
    expect(toCents(null)).toBe(0);
  });

  it("masks provider references and omits them for cash", () => {
    expect(maskReference("CAPTURE-9A8B7C6D")).toBe("…6D".replace("6D", "7C6D"));
    const card = buildReceiptData(snapshot({ paymentMethod: "paypal_card", amountTendered: null, changeGiven: null }, { providerCaptureId: "5TY05013RG002845M" }));
    expect(card.payment.referenceMasked).toBe("…845M");
    expect(JSON.stringify(card)).not.toContain("5TY05013RG002845M");
    expect(buildReceiptData(snapshot({}, { providerCaptureId: "5TY05013RG002845M" })).payment.referenceMasked).toBeNull();
  });

  it("exposes customer safe name and full name separately", () => {
    const data = buildReceiptData(snapshot());
    expect(data.customer).toEqual({ safeName: "Casey J.", fullName: "Casey Jones" });
  });

  it("strips printer control characters from every order-supplied string", () => {
    const data = buildReceiptData(snapshot({}, {
      items: [{ catalogItemName: "x", receiptName: "Evil\x1b@\x1dV\x00Name", quantity: 1, unitPrice: "1.00", totalPrice: "1.00" }],
      customer: { firstName: "Bad\x1bE\x01", lastName: "Actor‮" },
    }));
    expect(data.items[0]!.displayName).toBe("Evil @ V Name");
    expect(data.customer.fullName).toBe("Bad E Actor");
    expect(sanitizeReceiptText("a\tb\nc​d")).toBe("a b c d");
  });
});

describe("template rendering", () => {
  it("renders blocks in template order", () => {
    const lines = plain([
      { type: "data", id: "b", field: "total" },
      { type: "customText", id: "a", text: "FIRST TEXT" },
      { type: "data", id: "c", field: "orderNumber" },
    ]);
    expect(lines[0]).toMatch(/^TOTAL/);
    expect(lines[1]).toBe("FIRST TEXT");
    expect(lines[2]).toBe("Order #12345");
  });

  it("omits disabled blocks", () => {
    const lines = plain([
      { type: "data", id: "a", field: "orderNumber", enabled: false },
      { type: "separator", id: "s", style: "solid", enabled: false },
      { type: "data", id: "b", field: "total" },
    ]);
    expect(lines).toEqual(["TOTAL" + " ".repeat(48 - 5 - 6) + "$54.00"]);
  });

  it("aligns text left, center and right", () => {
    const lines = plain([
      { type: "customText", id: "l", text: "LEFT", align: "left" },
      { type: "customText", id: "c", text: "MID", align: "center" },
      { type: "customText", id: "r", text: "RIGHT", align: "right" },
    ], undefined, 32);
    expect(lines).toEqual(["LEFT", " ".repeat(14) + "MID", " ".repeat(27) + "RIGHT"]);
    const bytes = encodeReceiptEscPos(renderReceiptFromTemplate([
      { type: "customText", id: "c", text: "MID", align: "center" },
      { type: "customText", id: "r", text: "RIGHT", align: "right" },
    ], SAMPLE_RECEIPT_DATA, 32));
    expect(bytes).toContain("\x1ba\x01\x1bE\x00\x1d!\x00MID\n");
    expect(bytes).toContain("\x1ba\x02\x1bE\x00\x1d!\x00RIGHT\n");
  });

  it("maps emphasis and size to fixed printer commands", () => {
    expect(textSizeFor(12)).toBe("normal");
    expect(textSizeFor(20)).toBe("tall");
    expect(textSizeFor(36)).toBe("large");
    const bytes = encodeReceiptEscPos(renderReceiptFromTemplate([
      { type: "customText", id: "b", text: "BOLD", bold: true },
      { type: "customText", id: "t", text: "TALL", fontSize: 20 },
      { type: "customText", id: "l", text: "LARGE", fontSize: 36 },
    ], SAMPLE_RECEIPT_DATA, 48));
    expect(bytes).toContain("\x1bE\x01\x1d!\x00BOLD\n");
    expect(bytes).toContain("\x1d!\x01TALL\n");
    expect(bytes).toContain("\x1d!\x11LARGE\n");
    expect(bytes.startsWith("\x1b@")).toBe(true);
    expect(bytes.endsWith("\x1bd\x03\x1dVA\x00")).toBe(true);
  });

  it("handles 58mm and 80mm widths and wraps long text", () => {
    const long = "A".repeat(10) + " " + "B".repeat(30) + " " + "C".repeat(20);
    const narrow = plain([{ type: "customText", id: "t", text: long }], undefined, 32);
    const wide = plain([{ type: "customText", id: "t", text: long }], undefined, 48);
    expect(narrow.every((line) => line.length <= 32)).toBe(true);
    expect(wide.every((line) => line.length <= 48)).toBe(true);
    expect(narrow.length).toBeGreaterThan(wide.length);
    const large = plain([{ type: "customText", id: "t", text: "X".repeat(30), fontSize: 36 }], undefined, 48);
    expect(large.every((line) => line.length <= 24)).toBe(true);
    const items = plain([{ type: "data", id: "i", field: "items" }], buildReceiptData(snapshot({}, {
      items: [{ catalogItemName: "x", receiptName: "An extremely long product name that cannot possibly fit", quantity: 1, unitPrice: "1.00", totalPrice: "1.00" }],
    })), 32);
    expect(items.every((line) => line.length <= 32)).toBe(true);
    expect(items.at(-1)).toMatch(/\$1\.00$/);
  });

  it("renders solid, dashed and double separators", () => {
    const lines = plain([
      { type: "separator", id: "a", style: "solid" },
      { type: "separator", id: "b", style: "dashed" },
      { type: "separator", id: "c", style: "double" },
    ], undefined, 32);
    expect(lines).toEqual(["-".repeat(32), "- ".repeat(16), "=".repeat(32)]);
  });

  it("enforces custom text and block limits", () => {
    expect(receiptTemplateLayoutSchema.safeParse([{ type: "customText", id: "t", text: "x".repeat(500) }]).success).toBe(true);
    expect(receiptTemplateLayoutSchema.safeParse([{ type: "customText", id: "t", text: "x".repeat(501) }]).success).toBe(false);
    const blocks = Array.from({ length: 101 }, (_, i) => ({ type: "separator", id: `s${i}`, style: "solid" }));
    expect(receiptTemplateLayoutSchema.safeParse(blocks).success).toBe(false);
  });

  it("rejects unknown fields, block types and properties", () => {
    for (const bad of [
      [{ type: "data", id: "a", field: "password" }],
      [{ type: "data", id: "a", field: "total", value: 0 }],
      [{ type: "html", id: "a", html: "<b>x</b>" }],
      [{ type: "customText", id: "a", text: "x", expression: "order.total * 0" }],
      [{ type: "data", id: "bad id!", field: "total" }],
    ]) {
      expect(receiptTemplateLayoutSchema.safeParse(bad).success).toBe(false);
      expect(() => renderReceiptFromTemplate(bad, SAMPLE_RECEIPT_DATA, 48)).toThrow();
    }
  });

  it("treats template text as literal, with no interpolation", () => {
    const lines = plain([{ type: "customText", id: "t", text: "{{order.total}} ${total} <script>x</script>" }]);
    expect(lines[0]).toBe("{{order.total}} ${total} <script>x</script>");
  });

  it("skips logo and QR deterministically and reports them as unsupported", () => {
    const rendered = renderReceiptFromTemplate([
      { type: "data", id: "logo", field: "logo", align: "center" },
      { type: "data", id: "qr", field: "qrCode" },
      { type: "customText", id: "t", text: "AFTER", when: "hasQrCode" },
      { type: "data", id: "n", field: "orderNumber" },
    ], SAMPLE_RECEIPT_DATA, 48);
    expect(rendered.skipped).toEqual([
      { blockId: "logo", field: "logo", reason: "unsupported" },
      { blockId: "qr", field: "qrCode", reason: "unsupported" },
      { blockId: "t", field: "customText", reason: "condition" },
    ]);
    expect(encodeReceiptPlain(rendered)).toBe("Order #SAMPLE-0001");
  });
});

describe("money, tax and tender formatting", () => {
  it("shows discounts only when present", () => {
    expect(plain([{ type: "data", id: "d", field: "discounts" }])).toEqual([`Discount${" ".repeat(48 - 8 - 6)}-$2.00`]);
    expect(plain([{ type: "data", id: "d", field: "discounts" }], buildReceiptData(snapshot({ discountTotal: "0.00" })))).toEqual([""]);
  });

  it("formats tax rate and jurisdiction from the tax snapshot", () => {
    const [line] = plain([{ type: "data", id: "t", field: "salesTax" }]);
    expect(line).toMatch(/^Tax 8% - Sacramento, California\s+\$4\.00$/);
    const [odd] = plain([{ type: "data", id: "t", field: "salesTax" }], buildReceiptData(snapshot({ taxSnapshot: { taxRate: 0.0875 } })));
    expect(odd).toMatch(/^Tax 8\.75%\s+\$4\.00$/);
  });

  it("shows tender, marks unpaid tender, and shows masked card references", () => {
    expect(plain([{ type: "data", id: "t", field: "tenderType" }])[0]).toMatch(/^Paid by Cash\s+\$54\.00$/);
    expect(plain([{ type: "data", id: "t", field: "tenderType" }], buildReceiptData(snapshot({ paymentStatus: "unpaid" })))[0])
      .toMatch(/^Paid by Cash \(unpaid\)\s+\$54\.00$/);
    const card = buildReceiptData(snapshot({ paymentMethod: "paypal_card" }, { providerCaptureId: "5TY05013RG002845M" }));
    expect(plain([{ type: "data", id: "t", field: "tenderType" }, { type: "data", id: "r", field: "paymentReference" }], card))
      .toEqual([expect.stringMatching(/^Paid by PayPal\s+\$54\.00$/), expect.stringMatching(/^Reference\s+\.\.\.845M$/)]);
  });

  it("shows cash received and change only for cash payments", () => {
    const layout = [{ type: "data", id: "c", field: "cashReceived" }, { type: "data", id: "g", field: "change" }];
    expect(plain(layout)).toEqual([expect.stringMatching(/^Cash received\s+\$60\.00$/), expect.stringMatching(/^Change\s+\$6\.00$/)]);
    expect(plain(layout, buildReceiptData(snapshot({ paymentMethod: "paypal_card" })))).toEqual([""]);
  });
});

describe("item options and variants", () => {
  const withOption = buildReceiptData(snapshot({}, {
    items: [{ catalogItemName: "x", receiptName: "Product / Base", optionLabel: "Large, Blue", sku: "SKU-9", quantity: 2, unitPrice: "10.00", totalPrice: "20.00" }],
  }));

  it("renders items without options exactly as a plain line", () => {
    expect(plain([{ type: "data", id: "i", field: "items" }])).toEqual([
      expect.stringMatching(/^2 {2}Product A\s+\$20\.00$/),
      expect.stringMatching(/^1 {2}Another Product\s+\$32\.00$/),
    ]);
  });

  it("renders a present option as its own line and never parses names", () => {
    expect(plain([{ type: "data", id: "i", field: "items" }], withOption)).toEqual([
      expect.stringMatching(/^2 {2}Product \/ Base\s+\$20\.00$/),
      "   Large, Blue",
    ]);
  });

  it("shows SKU and unit price only when enabled, and hides options when disabled", () => {
    expect(plain([{ type: "data", id: "i", field: "items", showSku: true, showUnitPrice: true, showOption: false }], withOption)).toEqual([
      expect.stringMatching(/^2 {2}Product \/ Base\s+\$20\.00$/),
      "   SKU SKU-9",
      "   @ $10.00 ea",
    ]);
  });
});

describe("printer command injection", () => {
  it("rejects control characters in saved template text", () => {
    for (const text of ["\x1b@", "a\x1dVA\x00b", "x‮y", "tab\there"]) {
      expect(receiptTemplateLayoutSchema.safeParse([{ type: "customText", id: "t", text }]).success).toBe(false);
      expect(receiptTemplateLayoutSchema.safeParse([{ type: "data", id: "t", field: "total", label: text }]).success).toBe(false);
    }
  });

  it("never lets order data or template text emit printer commands", () => {
    const hostile = buildReceiptData(snapshot({ notes: "\x1bp\x00\x19\xfa drawer" }, {
      items: [{ catalogItemName: "x", receiptName: "Evil\x1b@\x1dV\x42\x00", quantity: 1, unitPrice: "1.00", totalPrice: "1.00" }],
      customer: { firstName: "\x1b!\x38", lastName: "\x1dk" },
      employee: { firstName: "\x10\x14\x01", lastName: null },
    }));
    const layout = [...FULL_TEMPLATE, { type: "data", id: "cust", field: "customerName" }];
    const bytes = encodeReceiptEscPos(renderReceiptFromTemplate(layout, hostile, 48));
    // eslint-disable-next-line no-control-regex -- asserting no control bytes remain
    expect(withoutAllowedCommands(bytes)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  });

  it("falls back to the legacy receipt when a stored template contains commands", () => {
    const result = renderReceipt(SAMPLE_RECEIPT_DATA, { id: 9, version: 3, paperWidth: "80mm", layout: [{ type: "customText", id: "t", text: "\x1b@" }] }, PRESENTATION, "plain");
    expect(result).toMatchObject({ source: "fallback", fallbackReason: "invalid-template", templateId: 9 });
  });
});

describe("pipeline: fallback, preview and engine parity", () => {
  const data = buildReceiptData(snapshot());

  it("uses the legacy receipt when there is no tenant template", () => {
    const result = renderReceipt(data, null, PRESENTATION, "plain");
    expect(result).toMatchObject({ source: "fallback", fallbackReason: "no-template", templateId: null });
    expect(result.text).toContain("Thanks for shopping");
    // The legacy builder keeps its existing money style for negatives.
    expect(result.text).toMatch(/Discount\s+\$-2\.00/);
    expect(result.text).toMatch(/Cash tendered\s+\$60\.00/);
    expect(result.text).toMatch(/Change\s+\$6\.00/);
    expect(result.text).toContain("Sacramento, California");
  });

  it("uses a valid tenant template and records its id and version", () => {
    const result = renderReceipt(data, { id: 4, version: 7, paperWidth: "80mm", layout: FULL_TEMPLATE }, PRESENTATION, "escpos");
    expect(result).toMatchObject({ source: "template", templateId: 4, templateVersion: 7, fallbackReason: null });
    expect(result.text).not.toContain("\x00");
    expect(decodeStoredReceiptText(result.text).endsWith("\x1bd\x03\x1dVA\x00")).toBe(true);
  });

  it("previews only synthetic data, clearly marked", () => {
    const preview = renderReceiptPreview(SAMPLE_RECEIPT_DATA, { id: 0, version: 0, paperWidth: "80mm", layout: FULL_TEMPLATE }, PRESENTATION);
    expect(preview.text.startsWith(PREVIEW_BANNER)).toBe(true);
    expect(preview.text).toContain("SAMPLE BUSINESS");
    expect(() => renderReceiptPreview(data, null, PRESENTATION)).toThrow("synthetic sample");
  });

  it("renders preview and printed receipts with the same engine", () => {
    const template = { id: 4, version: 1, paperWidth: "80mm", layout: FULL_TEMPLATE };
    const printed = decodeStoredReceiptText(renderReceipt(SAMPLE_RECEIPT_DATA, template, PRESENTATION, "escpos").text);
    const preview = renderReceiptPreview(SAMPLE_RECEIPT_DATA, template, PRESENTATION).text;
    const printedLines = withoutAllowedCommands(printed).split("\n").map((line) => line.trim()).filter(Boolean);
    const previewLines = preview.split("\n").map((line) => line.trim()).filter((line) => line && line !== PREVIEW_BANNER);
    expect(previewLines).toEqual(printedLines);
  });
});
