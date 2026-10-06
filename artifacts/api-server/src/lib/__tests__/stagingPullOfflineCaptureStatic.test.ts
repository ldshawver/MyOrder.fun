import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const packageRoot = resolve(root, "deploy/print-bridge/offline-marklife-capture");
const read = (name: string) => readFileSync(resolve(packageRoot, name), "utf8");

describe("MARKLIFE offline capture containment", () => {
  it("packages the exact retained one-page artwork copy", () => {
    const artwork = readFileSync(resolve(packageRoot, "input/Thank-You-Sticker-job-960-copy.png"));
    expect(artwork).toHaveLength(2123);
    expect(createHash("sha256").update(artwork).digest("hex")).toBe("b421a2f74da6c5cec20048c494ba3e898296f0909a309c08badf746bb83dc423");
  });

  it("requires reviewed containment and cannot currently execute the vendor filter", () => {
    const runner = read("capture-filter.sh");
    expect(runner).toContain("OPERATOR_AUTHORIZATION");
    expect(runner).toContain("containment-report.sha256");
    expect(runner).toContain("Execution remains intentionally unimplemented");
    expect(runner).not.toContain("sandbox-exec");
    expect(runner).not.toMatch(/\b(?:lp|lpr|cupsenable|cupsdisable|cancel)\b/);
  });

  it("denies network, IOKit, and writes outside the capture directory", () => {
    const profile = read("filter.sb.in");
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny iokit-open)");
    expect(profile).toContain('(allow file-write* (subpath "@CAPTURE_DIR@"))');
    expect(profile).toContain('(allow process-exec (literal "@FILTER_PATH@"))');
  });
});
