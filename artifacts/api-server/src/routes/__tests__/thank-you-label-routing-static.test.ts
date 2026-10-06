import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const route = readFileSync(
  resolve(root, "artifacts/api-server/src/routes/print.ts"),
  "utf8",
);

describe("Thank You label routing", () => {
  it("uses the tenant thank_you assignment instead of an operator label profile", () => {
    const start = route.indexOf('router.post(\n  "/print/label/thank-you"');
    const end = route.indexOf("// ── Per-order print triggers", start);
    const handler = route.slice(start, end);

    expect(handler).toContain("resolveThankYouStickerRouting");
    expect(handler).toContain("routing.eligible ? routing.selectedPrinter : null");
    expect(handler).not.toContain("resolveLabelPrinter(");
    expect(handler).toContain("routing.blockedReason");
  });

  it("applies the same fail-closed tenant routing to order-label reprints", () => {
    const start = route.indexOf('router.post("/print/orders/:id/label"');
    const handler = route.slice(start);

    expect(handler).toContain("resolveThankYouStickerRouting");
    expect(handler).toContain("id: orderId");
    expect(handler).not.toContain("resolveLabelPrinter(");
  });
});
