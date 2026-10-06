import { describe, expect, it } from "vitest";
import { THANK_YOU_STICKER_ARTWORK_SHA256, validateThankYouStickerPrinter } from "../printRoutingResolver";

const printer = (overrides: Record<string, unknown> = {}) => ({
  role: "thank_you", bridgePrinterName: "Assigned_Thank_You",
  name: "Dedicated Thank You Sticker", isActive: true, ...overrides,
}) as never;

describe("Thank You sticker routing", () => {
  it("accepts the active tenant-assigned thank-you queue", () => {
    expect(validateThankYouStickerPrinter(printer())).toEqual({ eligible: true, reason: "tenant thank-you assignment verified" });
    expect(THANK_YOU_STICKER_ARTWORK_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["receipt role", { role: "receipt" }],
    ["ordinary label role", { role: "label" }],
    ["unassigned role", { role: "unassigned" }],
    ["missing queue", { bridgePrinterName: null, name: "" }],
    ["disabled printer", { isActive: false }],
  ])("fails closed for %s", (_name, overrides) => {
    expect(validateThankYouStickerPrinter(printer(overrides))).toMatchObject({ eligible: false });
  });
});
