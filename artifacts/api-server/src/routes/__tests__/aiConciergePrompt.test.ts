import { describe, it, expect } from "vitest";
import { DEFAULT_AI_CONCIERGE_PROMPT, renderConciergePrompt } from "../ai";

describe("AI Concierge prompt rendering", () => {
  it("substitutes {{itemCount}} and {{catalog}} in the default prompt", () => {
    const out = renderConciergePrompt(DEFAULT_AI_CONCIERGE_PROMPT, {
      itemCount: 7,
      catalog: "- Item A\n- Item B",
    });
    expect(out).toContain("CURRENT CATALOG (7 items available):");
    expect(out).toContain("- Item A\n- Item B");
    expect(out).not.toContain("{{itemCount}}");
    expect(out).not.toContain("{{catalog}}");
  });

  it("falls back to a friendly empty-catalog string when catalog is empty", () => {
    const out = renderConciergePrompt(DEFAULT_AI_CONCIERGE_PROMPT, {
      itemCount: 0,
      catalog: "",
    });
    expect(out).toContain("CURRENT CATALOG (0 items available):");
    expect(out).toContain("No items available right now.");
  });

  it("substitutes placeholders inside an admin-supplied custom template", () => {
    const custom = "Hello! There are {{itemCount}} items.\nMenu:\n{{catalog}}\nThanks.";
    const out = renderConciergePrompt(custom, {
      itemCount: 3,
      catalog: "- Burger $5",
    });
    expect(out).toBe("Hello! There are 3 items.\nMenu:\n- Burger $5\nThanks.");
  });

  it("replaces every occurrence of a placeholder, not just the first", () => {
    const custom = "{{itemCount}} {{itemCount}} {{itemCount}}";
    const out = renderConciergePrompt(custom, { itemCount: 9, catalog: "" });
    expect(out).toBe("9 9 9");
  });

  it("leaves unrelated text untouched", () => {
    const custom = "Plain text with no placeholders.";
    const out = renderConciergePrompt(custom, { itemCount: 1, catalog: "x" });
    expect(out).toBe("Plain text with no placeholders.");
  });
});
