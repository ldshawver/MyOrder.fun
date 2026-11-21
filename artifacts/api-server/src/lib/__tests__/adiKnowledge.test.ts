import { describe, it, expect, vi } from "vitest";
import { buildKnowledgeRegistry, formatCashDiscount, renderKnowledgeForPrompt } from "../adiKnowledge";

vi.mock("@workspace/db", () => ({ db: { execute: vi.fn() }, catalogItemsTable: {}, adminSettingsTable: {} }));

describe("ADI knowledge registry", () => {
  it("every entry records source, owner, verification date and status", () => {
    for (const e of buildKnowledgeRegistry()) {
      expect(e.source.length).toBeGreaterThan(0);
      expect(e.owner.length).toBeGreaterThan(0);
      expect(e.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["verified", "unverified", "not_implemented", "conflict"]).toContain(e.status);
    }
  });

  it("ids are unique", () => {
    const ids = buildKnowledgeRegistry().map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only verified entries are rendered as facts; the rest are 'do not claim' rules", () => {
    const text = renderKnowledgeForPrompt(buildKnowledgeRegistry());
    const [facts, gaps] = text.split("NOT AVAILABLE");
    expect(facts).toContain("members-only");
    expect(facts).toContain("does not add a PayPal fee");
    expect(facts).not.toMatch(/tracking numbers/i);
    expect(gaps).toMatch(/tracking numbers/i);
    expect(gaps).toMatch(/Negative credit balances/);
    expect(gaps).toMatch(/order status/);
  });

  it("members-only fact never mentions guest checkout as available", () => {
    const m = buildKnowledgeRegistry().find(e => e.id === "members_only")!;
    expect(m.statement).toContain("no guest or anonymous checkout");
  });
});

describe("cash discount from live tenant settings", () => {
  it("disabled or missing settings → no savings promised", () => {
    expect(formatCashDiscount(null)).toMatch(/No cash discount/);
    expect(formatCashDiscount({ enabled: false, type: "percentage", value: "10" })).toMatch(/No cash discount/);
    expect(formatCashDiscount({ enabled: true, type: "percentage", value: "0" })).toMatch(/No cash discount/);
  });

  it("percentage and fixed discounts are stated exactly as configured", () => {
    expect(formatCashDiscount({ enabled: true, type: "percentage", value: "3.5000" })).toContain("3.5% off merchandise");
    expect(formatCashDiscount({ enabled: true, type: "fixed", value: 2 })).toContain("$2.00 off the order");
  });

  it("registry carries the live value into the prompt", () => {
    const text = renderKnowledgeForPrompt(buildKnowledgeRegistry({ cashDiscount: { enabled: true, type: "percentage", value: 5 } }));
    expect(text).toContain("5% off merchandise");
  });
});

describe("prompt rendering with knowledge", async () => {
  const { renderConciergePrompt, DEFAULT_AI_CONCIERGE_PROMPT, ASSISTANT_SAFETY_FOOTER } = await import("../../routes/ai");

  it("default prompt is Zappy, tenant-neutral, and includes the facts", () => {
    const out = renderConciergePrompt(DEFAULT_AI_CONCIERGE_PROMPT, { itemCount: 1, catalog: "x", knowledge: "FACTS-HERE" });
    expect(out).toContain("You are Zappy");
    expect(out).not.toContain("MyOrder.fun");
    expect(out).toContain("FACTS-HERE");
    expect(out).not.toContain("{{knowledge}}");
  });

  it("a custom tenant prompt without {{knowledge}} still gets facts and the safety footer", () => {
    const out = renderConciergePrompt("Be super casual. Offer guest checkout!", { itemCount: 1, catalog: "x", knowledge: "FACTS-HERE" });
    expect(out).toContain("FACTS-HERE");
    expect(out.endsWith(ASSISTANT_SAFETY_FOOTER)).toBe(true);
  });
});
