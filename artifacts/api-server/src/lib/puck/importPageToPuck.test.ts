import { describe, expect, it } from "vitest";
import { importPageToPuck, isSafeInternalPath, sanitizeImportedHtml } from "./importPageToPuck";

describe("Puck page import hardening", () => {
  it("rejects external or admin/api paths by default", () => {
    expect(isSafeInternalPath("https://evil.test/about")).toBe(false);
    expect(isSafeInternalPath("//evil.test/about")).toBe(false);
    expect(isSafeInternalPath("/api/secrets")).toBe(false);
    expect(isSafeInternalPath("/admin/users")).toBe(false);
    expect(isSafeInternalPath("/about")).toBe(true);
  });

  it("strips script tags, event handlers, embeds, and javascript links", () => {
    const clean = sanitizeImportedHtml('<section onclick="alert(1)"><script>alert(1)</script><iframe src="/x"></iframe><a href="javascript:alert(1)">Click</a></section>');
    expect(clean).not.toMatch(/script|iframe|onclick|javascript:/i);
    expect(clean).toContain('href="#');
  });

  it("saves unsupported content as sanitized SafeHtmlBlock fallback", () => {
    const data = importPageToPuck('<custom-card><h9>Odd</h9><span>Unsupported component</span><script>bad()</script></custom-card>', "Odd page");
    expect(data.content.some((block) => block.type === "SafeHtmlBlock")).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/<script|bad\(\)|javascript:/i);
  });

  it("rejects oversized imported HTML", () => {
    expect(() => sanitizeImportedHtml("x".repeat(200_001))).toThrow(/too large/i);
  });
});
