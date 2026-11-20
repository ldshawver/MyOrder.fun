import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../..", import.meta.url);
const reports = readFileSync(new URL("artifacts/api-server/src/routes/reports.ts", root), "utf8");
const service = readFileSync(new URL("artifacts/api-server/src/payments/service.ts", root), "utf8");

describe("payment-source reporting", () => {
  it("uses provider-verified funding sources and marks indistinguishable history unspecified", () => {
    for (const label of ["Venmo", "Apple Pay", "Google Pay", "Credit card", "Debit card", "Unspecified digital"]) expect(reports).toContain(label);
    expect(reports).toContain("paymentAttemptsTable.fundingSource");
    expect(service).toContain("fundingSource: capture.fundingSource");
  });
});
