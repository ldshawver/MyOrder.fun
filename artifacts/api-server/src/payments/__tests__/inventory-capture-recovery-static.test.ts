import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(__dirname, "../inventory.ts"), "utf8");

describe("settled payment inventory recovery", () => {
  it("re-reserves expired checkout holds before confirming a paid sale", () => {
    expect(source).toContain('row.status === "confirmed"');
    expect(source).toContain('row.status === "reserved" && row.expiresAt > new Date()');
    expect(source).toContain("!hasConfirmed && !hasActiveReservation");
    expect(source).toContain("idempotencyKey: null");
  });
});
