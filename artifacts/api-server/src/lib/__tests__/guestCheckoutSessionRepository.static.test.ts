import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const source = readFileSync(resolve(root, "artifacts/api-server/src/lib/guestCheckoutSessionRepository.ts"), "utf8");

describe("guest checkout capability repository", () => {
  it("uses one conditional database update with database time and returning", () => {
    for (const predicate of ["guestCheckoutSessionsTable.id", "guestCheckoutSessionsTable.tenantId", "guestCheckoutSessionsTable.staffActorUserId", "guestCheckoutSessionsTable.capabilityHash", "isNull(guestCheckoutSessionsTable.consumedAt)", "isNull(guestCheckoutSessionsTable.revokedAt)", "CURRENT_TIMESTAMP", ".returning("]) expect(source).toContain(predicate);
  });
  it("requires a caller-owned transaction rather than creating one", () => {
    expect(source).not.toContain("db.transaction(");
    expect(source).toContain("tx.update(guestCheckoutSessionsTable)");
  });
});
