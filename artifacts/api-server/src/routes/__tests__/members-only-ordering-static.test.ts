import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const routesIndex = readFileSync(join(process.cwd(), "src/routes/index.ts"), "utf8");

describe("members-only ordering route composition", () => {
  it("does not mount an anonymous guest checkout router", () => {
    expect(routesIndex).not.toContain('from "./guest-checkout"');
    expect(routesIndex).not.toContain("guestCheckoutRouter");
    expect(routesIndex).not.toContain("/guest-checkout");
  });
});
