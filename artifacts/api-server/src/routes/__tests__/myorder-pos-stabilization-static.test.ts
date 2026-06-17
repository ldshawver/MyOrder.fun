import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("MyOrder POS stabilization static checks", () => {
  it("keeps deployment docs/workflow on the MyOrder target and safe compose sequence", () => {
    const workflow = read(".github/workflows/deploy.yml");
    const readiness = read("docs/POS_PRODUCTION_READINESS_2026-06-15.md");
    const combined = `${workflow}\n${readiness}`;

    expect(combined).toContain("/opt/alavont/deploy");
    expect(readiness).toContain("docker compose build --pull");
    expect(readiness).toContain("docker compose up -d db");
    expect(readiness).toContain("docker compose run --rm migrate");
    expect(readiness).toContain("docker compose up -d api platform nginx");
    expect(combined).not.toMatch(/lux-email-bot|luxit\.service|docker compose down/);
  });

  it("documents current MyOrder wording and avoids stale editor terminology", () => {
    const readiness = read("docs/POS_PRODUCTION_READINESS_2026-06-15.md");

    expect(readiness).toContain("Start Shift / End Shift");
    expect(readiness).toContain("Puck/Web Editor");
    expect(readiness).not.toContain("Plasmic");
  });
});

