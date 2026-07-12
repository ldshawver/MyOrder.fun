import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../../../../");
function src(path: string): string { return readFileSync(resolve(root, path), "utf8"); }
function exists(path: string): boolean { return existsSync(resolve(root, path)); }

describe("schedule publish SMS audit", () => {
  it("documents that schedule publishing SMS is not implemented as a campaign", () => {
    const audit = src("docs/schedule-publish-sms-audit.md");
    const routeIndex = src("artifacts/api-server/src/routes/index.ts");
    const schemaIndex = src("lib/db/src/schema/index.ts");

    expect(audit).toContain("Schedule Publish SMS Notification Flow Audit");
    expect(audit).toContain("no backend schedule publish route exists");
    expect(audit).toContain("notifyEmployeesOfScheduleChanges");
    expect(routeIndex).not.toContain("smsCampaignsRouter");
    expect(schemaIndex).not.toContain("sms-campaigns");
    expect(exists("artifacts/api-server/src/routes/sms-campaigns.ts")).toBe(false);
    expect(exists("lib/db/src/schema/sms-campaigns.ts")).toBe(false);
  });
});
