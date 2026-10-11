import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const source = readFileSync(resolve(root, "artifacts/platform/src/pages/staff.tsx"), "utf8");
const events = readFileSync(resolve(root, "artifacts/platform/src/hooks/useOrderEvents.ts"), "utf8");

describe("CSR queue reliability wiring", () => {
  it("requires a token and retains the last successful queue snapshot on fetch failure", () => {
    expect(source).toContain("if (!token) throw new Error(");
    expect(source).toContain("setQueueError(reason instanceof Error ? reason.message");
    expect(source).not.toContain("setQueueData({ orders: [], total: 0 });");
    expect(source).toContain("Showing the last successful queue snapshot.");
  });

  it("guards snapshots against overlapping requests and newer order events", () => {
    expect(source).toContain("queueRequestNumber.current");
    expect(source).toContain("queueEventRevision.current");
    expect(source).toContain("eventRevision === queueEventRevision.current");
  });

  it("reconciles after SSE reconnect, browser visibility/network restore, and periodically", () => {
    expect(source).toContain("onReconnect: onSseReconnect");
    expect(source).toContain('window.addEventListener("online", reconcile)');
    expect(source).toContain('document.addEventListener("visibilitychange", reconcile)');
    expect(source).toContain("setInterval(reconcile, 15_000)");
    expect(events).toContain("if (hasConnected) onReconnect?.()");
  });
});
