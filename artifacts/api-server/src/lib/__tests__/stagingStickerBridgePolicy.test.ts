import { describe, expect, it } from "vitest";
import { authenticateBridge, hashBridgeValue, sanitizeBridgeFailure, validateStickerClaim, validateStickerPrinter } from "../stagingStickerBridgePolicy";

const secret = "a".repeat(48);
describe("staging sticker bridge policy", () => {
  it("accepts the correct staging credential and rejects wrong credentials/environments", () => {
    const base = { nodeEnvironment: "staging", requestedEnvironment: "staging", bridgeEnvironment: "staging", allowedJobType: "thank_you_sticker", presentedSecret: secret, credentialHash: hashBridgeValue(secret) };
    expect(authenticateBridge(base)).toEqual({ ok: true });
    expect(authenticateBridge({ ...base, presentedSecret: "b".repeat(48) })).toMatchObject({ ok: false, error: "BRIDGE_AUTH_REJECTED" });
    expect(authenticateBridge({ ...base, requestedEnvironment: "production" })).toMatchObject({ ok: false, error: "WRONG_ENVIRONMENT" });
  });

  it("rejects wrong queue, device, role, capabilities, or copy count", () => {
    const base = { role: "thank_you_sticker", queue: "MARKLIFE_X2", copies: 1, receiptCapable: false, labelCapable: false, expectedDeviceUriHash: hashBridgeValue("usb://MARKLIFE/X2?location=8343000"), actualDeviceUri: "usb://MARKLIFE/X2?location=8343000" };
    expect(validateStickerPrinter(base)).toBe(true);
    expect(validateStickerPrinter({ ...base, queue: "default" })).toBe(false);
    expect(validateStickerPrinter({ ...base, actualDeviceUri: "usb://OTHER" })).toBe(false);
    expect(validateStickerPrinter({ ...base, role: "receipt" })).toBe(false);
    expect(validateStickerPrinter({ ...base, labelCapable: true })).toBe(false);
    expect(validateStickerPrinter({ ...base, copies: 2 })).toBe(false);
  });

  it("accepts only the approved fixed rendering contract", () => {
    const claim = { jobType: "thank_you_sticker", queue: "MARKLIFE_X2", copies: 1, media: "Custom.1.9375x1.9375in", resolution: "203dpi", rotate: 0, horizontal: 0, vertical: 0, mirror: 0, negative: 0, darkness: 10, templateVersion: 1, artworkChecksum: "0fad41aa3b9f338e00f02d4bcd1e80acc34a6d4bb1cb8a846ce52b4d740a83f4", imageBase64: "iVBORw0KGgo=" };
    expect(validateStickerClaim(claim)).toBe(true);
    expect(validateStickerClaim({ ...claim, queue: "Brother_HL_L2405W" })).toBe(false);
    expect(validateStickerClaim({ ...claim, copies: 2 })).toBe(false);
    expect(validateStickerClaim({ ...claim, jobType: "receipt" })).toBe(false);
  });

  it("redacts credential-shaped failure text", () => expect(sanitizeBridgeFailure("token=abc123\nfailed")).toBe("credential=[redacted] failed"));
});
