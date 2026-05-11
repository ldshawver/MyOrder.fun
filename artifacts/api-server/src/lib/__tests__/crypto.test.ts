import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { encrypt, decrypt, safeDecrypt, _resetKeyCacheForTests } from "../crypto";

describe("crypto helper", () => {
  beforeEach(() => {
    process.env.SETTINGS_ENC_KEY = "0".repeat(64);
    _resetKeyCacheForTests();
  });

  it("round-trips a value", () => {
    const ct = encrypt("ck_supersecret_value_123");
    expect(ct.startsWith("enc:v1:")).toBe(true);
    expect(ct).not.toContain("ck_supersecret_value_123");
    expect(decrypt(ct)).toBe("ck_supersecret_value_123");
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const a = encrypt("hello");
    const b = encrypt("hello");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("hello");
    expect(decrypt(b)).toBe("hello");
  });

  it("decrypt() passes through legacy plaintext (no enc:v1: prefix)", () => {
    expect(decrypt("legacy_plain_value")).toBe("legacy_plain_value");
  });

  it("safeDecrypt() returns null on undefined/null input", () => {
    expect(safeDecrypt(null)).toBeNull();
    expect(safeDecrypt(undefined)).toBeNull();
  });

  it("safeDecrypt() returns null on tampered ciphertext", () => {
    const ct = encrypt("secret");
    const tampered = ct.slice(0, -4) + "AAAA";
    expect(safeDecrypt(tampered)).toBeNull();
  });
});
