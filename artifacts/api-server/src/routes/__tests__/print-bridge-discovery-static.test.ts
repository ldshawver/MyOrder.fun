import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { authenticatePrintBridgeDiscovery } from "../../lib/printBridgeDiscoveryPolicy";

const root = resolve(import.meta.dirname, "../../../../..");
const route = readFileSync(resolve(root, "artifacts/api-server/src/routes/print-bridge-discovery.ts"), "utf8");

describe("tenant-scoped bridge discovery", () => {
  it("authenticates staging-only discovery and rejects a wrong credential", () => {
    expect(authenticatePrintBridgeDiscovery({ nodeEnvironment: "staging", requestedEnvironment: "staging", bridgeEnvironment: "staging", presentedCredential: "wrong", credentialHash: "d58c4cacf3db5c1e8c4b1c8d07bd05ceea29ce83a7b94752d9ff124c75b041ad" }).ok).toBe(false);
  });
  it("binds discovery to the bridge profile tenant and leaves function assignment unassigned", () => {
    expect(route).toContain("bridge.tenantId");
    expect(route).toContain('role: "unassigned"');
    expect(route).not.toContain("tenantId: req.body");
    expect(route).toContain("pg_advisory_xact_lock");
  });
});
