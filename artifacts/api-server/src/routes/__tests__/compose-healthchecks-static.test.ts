import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const production = read("deploy/docker-compose.yml");
const staging = read("deploy/docker-compose.staging.yml");
const platformNginx = read("deploy/nginx-spa.conf");

function serviceBlock(compose: string, name: string, nextName?: string): string {
  const start = compose.indexOf(`  ${name}:`);
  const nextMarker = nextName === "volumes" ? "\nvolumes:" : `\n  ${nextName}:`;
  const foundEnd = nextName ? compose.indexOf(nextMarker, start + 1) : -1;
  return compose.slice(start, foundEnd === -1 ? compose.length : foundEnd);
}

describe("Compose health-check topology", () => {
  it("probes the platform listener on port 3000 in production", () => {
    expect(platformNginx).toContain("listen 3000;");
    const platform = serviceBlock(production, "platform", "nginx");
    expect(platform).toContain("wget -q --spider http://127.0.0.1:3000/");
    expect(platform).not.toContain("wget -q --spider http://127.0.0.1/ || exit 1");
    expect(platform).toContain("interval: 10s");
    expect(platform).toContain("timeout: 5s");
    expect(platform).toContain("retries: 10");
    expect(platform).toContain("start_period: 10s");
  });

  it("defines healthy staging probes using tools present in each image", () => {
    const blocks = [
      serviceBlock(staging, "db", "migrate"),
      serviceBlock(staging, "api", "platform"),
      serviceBlock(staging, "platform", "nginx"),
      serviceBlock(staging, "nginx", "volumes"),
    ];
    expect(blocks[0]).toContain("pg_isready");
    expect(blocks[1]).toContain("fetch('http://127.0.0.1:8080/healthz')");
    expect(blocks[2]).toContain("wget -q --spider http://127.0.0.1:3000/");
    expect(blocks[3]).toContain("wget -q --spider http://127.0.0.1/ || exit 1");
    for (const block of blocks) {
      expect(block).toContain("interval: 10s");
      expect(block).toContain("timeout: 5s");
      expect(block).toContain("retries: 10");
      expect(block).toContain("start_period: 10s");
    }
  });

  it("makes staging nginx wait for healthy API and platform services", () => {
    const nginx = serviceBlock(staging, "nginx", "volumes");
    expect(nginx).toContain("api:\n        condition: service_healthy");
    expect(nginx).toContain("platform:\n        condition: service_healthy");
    const productionNginx = serviceBlock(production, "nginx");
    expect(productionNginx).toContain("api:\n        condition: service_healthy");
    expect(productionNginx).toContain("platform:\n        condition: service_healthy");
  });
});
