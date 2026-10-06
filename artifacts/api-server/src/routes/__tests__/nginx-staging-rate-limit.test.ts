import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("staging nginx API rate limit", () => {
  it("returns 429 rather than misclassifying rate-limit rejections as service unavailable", () => {
    const config = readFileSync(join(__dirname, "../../../../../deploy/nginx-staging.conf"), "utf8");
    expect(config).toContain("limit_req zone=staging_api");
    expect(config).toContain("limit_req_status 429;");
  });
});
