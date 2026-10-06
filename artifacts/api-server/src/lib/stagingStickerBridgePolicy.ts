import crypto from "node:crypto";

export const STICKER_QUEUE = "MARKLIFE_X2";
export const STICKER_MEDIA = "Custom.1.9375x1.9375in";
export const STICKER_RESOLUTION = "203dpi";
export const STICKER_ARTWORK_SHA256 = "0fad41aa3b9f338e00f02d4bcd1e80acc34a6d4bb1cb8a846ce52b4d740a83f4";
export const hashBridgeValue = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export function authenticateBridge(input: { nodeEnvironment?: string; requestedEnvironment?: string; presentedSecret: string; credentialHash?: string | null; bridgeEnvironment?: string | null; allowedJobType?: string | null }) {
  if (input.nodeEnvironment !== "staging" || input.requestedEnvironment !== "staging" || input.bridgeEnvironment !== "staging") return { ok: false, error: "WRONG_ENVIRONMENT" } as const;
  const presented = Buffer.from(hashBridgeValue(input.presentedSecret)); const expected = Buffer.from(input.credentialHash ?? "");
  if (!input.presentedSecret || presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected) || input.allowedJobType !== "thank_you_sticker") return { ok: false, error: "BRIDGE_AUTH_REJECTED" } as const;
  return { ok: true } as const;
}

export function validateStickerPrinter(input: { role: string; queue: string | null; copies: number; receiptCapable: boolean; labelCapable: boolean; expectedDeviceUriHash: string | null; actualDeviceUri: string }) {
  return input.role === "thank_you_sticker" && input.queue === STICKER_QUEUE && input.copies === 1 && !input.receiptCapable && !input.labelCapable && input.expectedDeviceUriHash === hashBridgeValue(input.actualDeviceUri);
}

export function validateStickerClaim(input: Record<string, unknown>) {
  return input.jobType === "thank_you_sticker" && input.queue === STICKER_QUEUE && input.copies === 1 && input.media === STICKER_MEDIA && input.resolution === STICKER_RESOLUTION && input.rotate === 0 && input.horizontal === 0 && input.vertical === 0 && input.mirror === 0 && input.negative === 0 && input.darkness === 10 && input.templateVersion === 1 && input.artworkChecksum === STICKER_ARTWORK_SHA256 && typeof input.imageBase64 === "string" && input.imageBase64.length > 0;
}

export function sanitizeBridgeFailure(value: unknown) {
  return String(value ?? "unspecified").replace(/[\r\n\t]/g, " ").replace(/(?:bearer|token|secret|key)\s*[:=]\s*\S+/gi, "credential=[redacted]").slice(0, 240);
}
