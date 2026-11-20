import { describe, expect, it } from "vitest";
import { assertGuestCapabilityState, createGuestToken, guestTokenDigestMatches, hashGuestToken, isValidGuestToken } from "../guestTokens";

describe("guest token capabilities", () => {
  it("creates distinct 32-byte base64url tokens and persists only purpose-bound SHA-256 digests", () => {
    const a = createGuestToken("checkout"), b = createGuestToken("checkout");
    expect(a.token).toHaveLength(43); expect(isValidGuestToken(a.token)).toBe(true); expect(a.token).not.toBe(b.token);
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/); expect(a.digest).toBe(hashGuestToken("checkout", a.token));
    expect(guestTokenDigestMatches("checkout", a.token, a.digest)).toBe(true);
    expect(guestTokenDigestMatches("tracking", a.token, a.digest)).toBe(false);
  });
  it("rejects malformed tokens without exposing token content", () => {
    expect(isValidGuestToken("bad")).toBe(false);
    expect(guestTokenDigestMatches("checkout", "bad", "0".repeat(64))).toBe(false);
  });
  it("rejects expired, revoked, and consumed sessions", () => {
    const future = new Date(Date.now() + 60_000);
    expect(() => assertGuestCapabilityState({ expiresAt: new Date(Date.now() - 1), revokedAt: null })).toThrow("Guest capability is unavailable");
    expect(() => assertGuestCapabilityState({ expiresAt: future, revokedAt: new Date() })).toThrow("Guest capability is unavailable");
    expect(() => assertGuestCapabilityState({ expiresAt: future, revokedAt: null, consumedAt: new Date() })).toThrow("Guest capability is unavailable");
  });
});
