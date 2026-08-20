import { describe, expect, it } from "vitest";
import { THANK_YOU_STICKER_ARTWORK_SHA256, THANK_YOU_STICKER_QUEUE, validateThankYouStickerPrinter } from "../printRoutingResolver";

const printer = (overrides: Record<string, unknown> = {}) => ({
  role: "thank_you_sticker", bridgePrinterName: THANK_YOU_STICKER_QUEUE,
  name: "Dedicated Thank You Sticker", isActive: true, ...overrides,
}) as never;

describe("Thank You sticker routing", () => {
  it("accepts only the active dedicated MARKLIFE_X2 queue", () => {
    expect(validateThankYouStickerPrinter(printer())).toEqual({ eligible: true, reason: "dedicated MARKLIFE_X2 route verified" });
    expect(THANK_YOU_STICKER_ARTWORK_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["receipt role", { role: "receipt" }],
    ["ordinary label role", { role: "label" }],
    ["different queue", { bridgePrinterName: "receipt" }],
    ["system default", { bridgePrinterName: null, name: "Default_Printer" }],
    ["disabled printer", { isActive: false }],
  ])("fails closed for %s", (_name, overrides) => {
    expect(validateThankYouStickerPrinter(printer(overrides))).toMatchObject({ eligible: false });
  });
});
