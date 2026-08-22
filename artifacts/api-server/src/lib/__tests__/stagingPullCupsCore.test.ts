import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const core = require(resolve(import.meta.dirname, "../../../../../deploy/print-bridge/staging-pull-core.js")) as {
  parseCupsSubmission(value: string): { cupsRequestId: string; cupsJobId: number } | null;
  extractCupsJobRecord(history: string, requestId: string): string;
  classifyCupsStatus(active: string, completed: string): string;
};

describe("MARKLIFE CUPS lifecycle parsing", () => {
  it("captures the exact successful CUPS request ID", () => expect(core.parseCupsSubmission("request id is MARKLIFE_X2-417 (1 file(s))")).toEqual({ cupsRequestId: "MARKLIFE_X2-417", cupsJobId: 417 }));
  it("rejects success output without the exact queue request ID", () => expect(core.parseCupsSubmission("request id is Brother-417")).toBeNull());
  it("keeps an active request pending", () => expect(core.classifyCupsStatus("MARKLIFE_X2-417 user 1024", "")).toBe("pending"));
  it("reports completion only from the exact completed request history", () => expect(core.classifyCupsStatus("", "MARKLIFE_X2-417 user 1024 completed")).toBe("completed"));
  it("distinguishes canceled and failed CUPS jobs", () => {
    expect(core.classifyCupsStatus("", "MARKLIFE_X2-417 canceled")).toBe("canceled");
    expect(core.classifyCupsStatus("MARKLIFE_X2-417 filter failed", "")).toBe("cups_failed");
  });
  it("extracts only the exact job from queue-scoped history", () => {
    const history = "MARKLIFE_X2-952 other 1024\n\tStatus: completed\n\nMARKLIFE_X2-953 operator 3072\n\tStatus: Unable to send data to printer.\n\tAlerts: printer-stopped\n\nMARKLIFE_X2-954 other 1024";
    const record = core.extractCupsJobRecord(history, "MARKLIFE_X2-953");
    expect(record).toContain("MARKLIFE_X2-953");
    expect(record).toContain("printer-stopped");
    expect(record).not.toContain("MARKLIFE_X2-952");
    expect(record).not.toContain("MARKLIFE_X2-954");
  });
  it("classifies stopped and backend-send failures without retrying", () => {
    expect(core.classifyCupsStatus("MARKLIFE_X2-953\n Status: Unable to send data to printer.", "")).toBe("cups_failed");
    expect(core.classifyCupsStatus("MARKLIFE_X2-953\n Alerts: printer-stopped", "")).toBe("cups_failed");
  });
  it("keeps missing or unrelated history unknown", () => {
    expect(core.extractCupsJobRecord("MARKLIFE_X2-954 operator 1024", "MARKLIFE_X2-953")).toBe("");
    expect(core.classifyCupsStatus("", "")).toBe("unknown");
  });
});
