import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const catalog = readFileSync(new URL("../../pages/catalog.tsx", import.meta.url), "utf8");

describe("catalogue banner and search layout", () => {
  it("renders the banner at full width with its source aspect ratio and no crop rule", () => {
    expect(catalog).toContain('aspect-[3/1] w-full');
    expect(catalog).toContain('block h-auto w-full catalog-hero-frame');
    expect(catalog).not.toContain('h-full w-full object-contain catalog-hero-frame');
    expect(catalog).not.toContain('object-cover catalog-hero-frame');
    expect(catalog).not.toMatch(/catalog-hero[^\n]*min-h-/);
  });

  it("keeps only the accessible search controls opaque", () => {
    expect(catalog).toContain('data-testid="catalog-search-wrapper"');
    expect(catalog).toContain('gap-2 bg-transparent p-3');
    expect(catalog).toContain('role="search"');
    expect(catalog).toContain('aria-label="Search catalogue"');
    expect(catalog).toContain('bg-background pl-9');
    expect(catalog).toContain('bg-primary px-4 text-primary-foreground');
    expect(catalog).not.toMatch(/catalog-search-wrapper[^\n]*(backdrop|bg-background|shadow-xl)/);
  });

  it("removes the customer-facing fulfillment wording and its wrappers", () => {
    expect(catalog).not.toContain("Alavont fulfilled by Lucifer Cruz");
    expect(catalog).not.toContain("All transactions are private and discreet.");
    expect(catalog).not.toContain("LC branded banner");
  });

  it("retains responsive desktop and mobile control layout without an empty section", () => {
    expect(catalog).toContain('flex flex-wrap items-center gap-2');
    expect(catalog).toContain('sm:min-w-[260px]');
    expect(catalog).not.toContain("LC branded banner");
    expect(catalog).not.toContain("border-blue-500/15 bg-blue-500/5");
    expect(catalog).not.toContain("mt-8 rounded-2xl border border-border/30 bg-background/80");
  });
});
