import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../admin/reports.tsx", import.meta.url), "utf8");

describe("receipt reprints", () => {
  it("uses the authenticated print trigger instead of navigating to a missing GET route", () => {
    expect(source).toContain('fetch(`/api/print/orders/${orderId}/receipt`, { method: "POST"');
    expect(source).toContain("Authorization: `Bearer ${token}`");
    expect(source).not.toContain('href={`/api/print/orders/${receipt.orderId}/receipt`}');
  });
});
