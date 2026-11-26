import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn() }, catalogItemsTable: {}, adminSettingsTable: {},
  ordersTable: {}, orderItemsTable: {}, customerCreditAccountsTable: {},
}));
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../lib/logger", () => ({ logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { AiNotConfiguredError, openAiApiKey, postChatCompletion } from "../ai";

const repo = resolve(__dirname, "../../../../..");
const read = (p: string) => readFileSync(join(repo, p), "utf8");
const FAKE_KEY = "sk-test-staging-0000000000000000";

describe("Zappy AI key handling", () => {
  const original = process.env.OPENAI_API_KEY;
  const fetchSpy = vi.fn();
  beforeEach(() => { fetchSpy.mockReset(); vi.stubGlobal("fetch", fetchSpy); });
  afterEach(() => { vi.unstubAllGlobals(); if (original === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original; });

  it("missing or blank key fails safely without calling the provider", async () => {
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = value;
      expect(() => openAiApiKey()).toThrow(AiNotConfiguredError);
      await expect(postChatCompletion({})).rejects.toBeInstanceOf(AiNotConfiguredError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1); // warns once, not per message
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/sk-/);
  });

  it("sends the key only in the Authorization header to the provider", async () => {
    process.env.OPENAI_API_KEY = FAKE_KEY;
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) });
    await postChatCompletion({ model: "gpt-4o-mini", messages: [] });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(String(init.body)).not.toContain(FAKE_KEY);
  });

  it("provider errors expose only the status, never a body that echoes the key", async () => {
    process.env.OPENAI_API_KEY = FAKE_KEY;
    fetchSpy.mockResolvedValue({ ok: false, status: 401, text: async () => `Incorrect API key provided: ${FAKE_KEY}`, json: async () => ({ error: { message: FAKE_KEY } }) });
    const err = await postChatCompletion({}).catch(e => e as Error);
    expect(err.message).toBe("AI API error: 401");
    expect(err.message).not.toContain("sk-");
  });
});

describe("Zappy AI key stays server-side (static)", () => {
  it("staging reads the key from its protected env file instead of hard-coding it empty", () => {
    const staging = read("deploy/docker-compose.staging.yml");
    expect(staging).toContain("OPENAI_API_KEY: ${OPENAI_API_KEY:-}");
    expect(staging).not.toContain('OPENAI_API_KEY: ""');
    // Only the API service gets it — never the platform (browser bundle) build.
    const platform = staging.slice(staging.indexOf("\n  platform:"), staging.indexOf("\n  nginx:"));
    expect(platform).not.toMatch(/OPENAI/);
    expect(staging.match(/OPENAI_API_KEY/g)).toHaveLength(2); // the line + no other use
  });

  it("production and dev Compose configuration are unchanged", () => {
    expect(read("deploy/docker-compose.yml")).toContain("      OPENAI_API_KEY: ${OPENAI_API_KEY}\n");
    expect(read("deploy/docker-compose.dev.yml")).toContain("      OPENAI_API_KEY: ${OPENAI_API_KEY:-}\n");
  });

  it("no browser code, Vite variable or platform image references the key", () => {
    expect(read("deploy/Dockerfile.platform")).not.toMatch(/OPENAI/);
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? (f === "node_modules" || f === "dist" ? [] : walk(p)) : [p];
    });
    const offenders = walk(join(repo, "artifacts/platform/src"))
      .filter(f => /\.(ts|tsx|js|jsx)$/.test(f))
      .filter(f => /OPENAI_API_KEY|VITE_OPENAI|api\.openai\.com/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("chat responses say whether real AI or the fallback answered", () => {
    const src = read("artifacts/api-server/src/routes/ai.ts");
    expect(src).toContain('res.setHeader(ZAPPY_SOURCE_HEADER, aiSource)');
    expect(src).toMatch(/aiSource = "fallback";\n\s+if \(!\(err instanceof AiNotConfiguredError\)\) logger\.error/);
    expect(src.match(/process\.env\.OPENAI_API_KEY/g)).toHaveLength(1);
  });
});
