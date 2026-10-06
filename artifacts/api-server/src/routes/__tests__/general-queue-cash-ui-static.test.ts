import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../../../../platform/src/pages/staff.tsx"), "utf8");

describe("General Queue cash-session UI contract", () => {
  it("allows managers to open against an active location without a register", () => {
    expect(source).toContain('data-testid="select-general-session-location"');
    expect(source).toContain('No register (optional)');
    expect(source).toContain('disabled={!selectedLocationId');
  });
  it("keeps management controls role-scoped", () => {
    expect(source).toContain('canManageGeneralSession');
    expect(source).toContain('isCsrOnly && !generalSession.participants.some');
  });
  it("renders authoritative session details", () => {
    for (const text of ["Opened by:", "Accountable cash:", "Expected closing cash:", "locationName", "registerLabel"]) expect(source).toContain(text);
  });
  it("supports participant management", () => {
    expect(source).toContain('Add Participant');
    expect(source).toContain('manageParticipant("DELETE"');
  });
  it("renders reconciliation reason and stable idempotency keys", () => {
    expect(source).toContain("discrepancyReason");
    expect(source).toContain("openIdempotencyKey");
    expect(source).toContain("closeIdempotencyKey");
  });
});
