import crypto from "node:crypto";

const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

/** Authenticate the inbound, staging-only bridge discovery channel. */
export function authenticatePrintBridgeDiscovery(input: { nodeEnvironment?: string; requestedEnvironment?: string; bridgeEnvironment?: string | null; presentedCredential: string; credentialHash?: string | null }) {
  if (input.nodeEnvironment !== "staging" || input.requestedEnvironment !== "staging" || input.bridgeEnvironment !== "staging") return { ok: false, error: "WRONG_ENVIRONMENT" } as const;
  const presented = Buffer.from(hash(input.presentedCredential));
  const expected = Buffer.from(input.credentialHash ?? "");
  if (!input.presentedCredential || presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) return { ok: false, error: "BRIDGE_AUTH_REJECTED" } as const;
  return { ok: true } as const;
}
