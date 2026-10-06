import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../BrandContext.tsx", import.meta.url), "utf8");

describe("public BrandContext authority", () => {
  it("uses the server-resolved public endpoint and does not read or write a brand switch in storage", () => {
    expect(source).toContain('fetch("/api/public/branding"');
    expect(source).not.toContain("orderflow_brand");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
  });
});
