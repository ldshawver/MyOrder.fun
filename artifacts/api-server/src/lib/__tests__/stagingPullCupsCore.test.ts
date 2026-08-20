import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const core = require(resolve(import.meta.dirname, "../../../../../deploy/print-bridge/staging-pull-core.js")) as {
  parseCupsSubmission(value: string): { cupsRequestId: string; cupsJobId: number } | null;
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
});
