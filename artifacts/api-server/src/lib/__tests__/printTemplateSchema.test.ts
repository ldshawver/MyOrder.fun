import { describe, expect, it } from "vitest";
import { parseReceiptTemplateLayout } from "../printTemplateSchema";

describe("tenant print template declarative schema", () => {
  it("accepts allowlisted receipt components", () => {
    expect(parseReceiptTemplateLayout([
      { id: "logo", type: "data", field: "logo", enabled: true, align: "center", fontSize: 12, bold: false, spacingBefore: 0, spacingAfter: 4, logoWidth: 320 },
      { id: "total", type: "data", field: "total", enabled: true, align: "right", fontSize: 18, bold: true, spacingBefore: 4, spacingAfter: 0 },
    ])).toHaveLength(2);
  });

  it.each([
    [{ id: "evil", type: "html", html: "<script>alert(1)</script>" }],
    [{ id: "evil", type: "data", field: "total", enabled: true, align: "left", fontSize: 12, bold: false, spacingBefore: 0, spacingAfter: 0, onclick: "steal()" }],
    [{ id: "evil", type: "data", field: "process.env", enabled: true, align: "left", fontSize: 12, bold: false, spacingBefore: 0, spacingAfter: 0 }],
  ])("rejects executable, unknown, or non-allowlisted template input", (layout) => {
    expect(() => parseReceiptTemplateLayout(layout)).toThrow();
  });
});
