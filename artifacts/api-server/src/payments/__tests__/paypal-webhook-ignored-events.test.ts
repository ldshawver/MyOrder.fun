import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../service.ts", import.meta.url), "utf8");

describe("PayPal unsupported webhook safety", () => {
  it("verifies and records CHECKOUT.ORDER.COMPLETED as an ignored, replay-safe event without payment mutation", () => {
    const allowed = source.match(/const allowed = new Set\(\[([^\]]+)\]\)/)?.[1] ?? "";
    expect(allowed).not.toContain("CHECKOUT.ORDER.COMPLETED");
    expect(source).toContain('processingState: allowed.has(event.event_type) ? "verified" : "ignored"');
    expect(source).toContain('if (!allowed.has(event.event_type)) return { replayed: false, processed: false };');
    expect(source.indexOf('if (!allowed.has(event.event_type)) return')).toBeLessThan(source.indexOf('if (event.event_type === "CHECKOUT.ORDER.APPROVED")'));
  });
});
