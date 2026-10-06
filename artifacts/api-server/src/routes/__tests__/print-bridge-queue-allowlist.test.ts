/**
 * Bridge queue allowlist (deploy/print-bridge/queue-policy.js + server.js).
 *
 * Integration cases start the real bridge on loopback with fake `lpstat` and
 * `lp` executables on PATH, so nothing can reach a real CUPS printer.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bridgeDir = resolve(import.meta.dirname, "../../../../../deploy/print-bridge");
const require = createRequire(import.meta.url);
const policy = require(join(bridgeDir, "queue-policy.js")) as {
  parseAllowedQueues: (raw: string | undefined, printerName?: string) => { configured: boolean; queues: Set<string> | null };
  filterPrinters: (printers: Array<{ name: string }>, p: unknown) => Array<{ name: string }>;
  checkPrintTarget: (req: { printerName?: unknown; imagePath?: string }, p: unknown) => { ok: boolean; status?: number; error?: string };
};

const KEY = "test-bridge-key-0123456789abcdef0123456789abcdef";

describe("queue policy (unit)", () => {
  it("is unconfigured, and permissive, when ALLOWED_QUEUES is unset", () => {
    const p = policy.parseAllowedQueues(undefined);
    expect(p.configured).toBe(false);
    expect(policy.checkPrintTarget({ printerName: "Anything", imagePath: "/etc/hosts" }, p)).toEqual({ ok: true });
    expect(policy.filterPrinters([{ name: "A" }, { name: "B" }], p)).toHaveLength(2);
  });

  it.each([
    ["", "lists no queues"],
    [" , ,", "lists no queues"],
    ["Pi_Receipt,bad name", "malformed"],
    ["Pi_Receipt,-Pdefault", "malformed"],
    ["../etc", "malformed"],
  ])("fails closed on misconfigured ALLOWED_QUEUES %j", (raw, message) => {
    expect(() => policy.parseAllowedQueues(raw)).toThrow(message);
  });

  it("fails closed when PRINTER_NAME is outside the allowlist", () => {
    expect(() => policy.parseAllowedQueues("Pi_Receipt", "Other_Queue")).toThrow("not in ALLOWED_QUEUES");
  });

  it("allows only listed, well-formed, explicit queues and rejects imagePath", () => {
    const p = policy.parseAllowedQueues(" Pi_Receipt , Pi_Report ", "Pi_Receipt");
    expect(policy.checkPrintTarget({ printerName: "Pi_Receipt" }, p)).toEqual({ ok: true });
    expect(policy.checkPrintTarget({ printerName: "Pi_Report" }, p)).toEqual({ ok: true });
    expect(policy.checkPrintTarget({ printerName: "Brightek_POS80" }, p)).toMatchObject({ ok: false, status: 403 });
    expect(policy.checkPrintTarget({ printerName: "" }, p)).toMatchObject({ ok: false, status: 400 });
    for (const bad of ["pi receipt", "-oraw", "a;rm", "x".repeat(65), 42]) {
      expect(policy.checkPrintTarget({ printerName: bad }, p)).toMatchObject({ ok: false, status: 400 });
    }
    expect(policy.checkPrintTarget({ printerName: "Pi_Receipt", imagePath: "/etc/passwd" }, p)).toMatchObject({ ok: false, status: 400 });
    expect(policy.filterPrinters([{ name: "Pi_Receipt" }, { name: "Other_Queue" }], p).map((x) => x.name)).toEqual(["Pi_Receipt"]);
  });
});

// Spawning node is slow when the whole suite runs in parallel.
describe("bridge server with fake CUPS (integration)", { timeout: 30_000 }, () => {
  let binDir = "";
  let lpLog = "";
  let child: ChildProcess | null = null;

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), "bridge-fake-cups-"));
    lpLog = join(binDir, "lp.log");
    writeFileSync(join(binDir, "lpstat"),
      "#!/bin/sh\necho 'printer Pi_Receipt is idle.  enabled since today'\necho 'printer Other_Queue is idle.  enabled since today'\n");
    writeFileSync(join(binDir, "lp"), "#!/bin/sh\necho \"$@\" >> \"$LP_LOG\"\necho 'request id is fake-1'\n");
    chmodSync(join(binDir, "lpstat"), 0o755);
    chmodSync(join(binDir, "lp"), 0o755);
    return () => rmSync(binDir, { recursive: true, force: true });
  });

  afterEach(() => {
    child?.kill();
    child = null;
    rmSync(lpLog, { force: true });
  });

  const freePort = () => new Promise<number>((done) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => done(port));
    });
  });

  const baseEnv = (port: number, extra: Record<string, string>) => ({
    PATH: `${binDir}:/usr/bin:/bin`,
    HOME: binDir,
    LP_LOG: lpLog,
    PORT: String(port),
    BIND_HOST: "127.0.0.1",
    PRINT_BRIDGE_API_KEY: KEY,
    DIRECT_PRINTER_IP: "",
    USB_DEVICE: "",
    ...extra,
  });

  async function startBridge(extra: Record<string, string>) {
    const port = await freePort();
    child = spawn(process.execPath, [join(bridgeDir, "server.js")], { cwd: binDir, env: baseEnv(port, extra), stdio: "pipe" });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(`${url}/healthz`)).ok) return url;
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("bridge did not start");
  }

  async function exitCode(extra: Record<string, string>) {
    const port = await freePort();
    return new Promise<{ code: number | null; stderr: string }>((done) => {
      const proc = spawn(process.execPath, [join(bridgeDir, "server.js")], { cwd: binDir, env: baseEnv(port, extra), stdio: "pipe" });
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d; });
      const timer = setTimeout(() => proc.kill(), 15_000);
      proc.on("exit", (code) => { clearTimeout(timer); done({ code, stderr }); });
    });
  }

  const print = (url: string, body: Record<string, unknown>) => fetch(`${url}/print`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify({ text: "QUEUE POLICY TEST", role: "receipt", ...body }),
  });
  const lpCalls = () => (existsSync(lpLog) ? readFileSync(lpLog, "utf8").trim().split("\n").filter(Boolean) : []);

  it.each([
    [{ ALLOWED_QUEUES: "" }, "lists no queues"],
    [{ ALLOWED_QUEUES: "Pi Receipt" }, "malformed"],
    [{ ALLOWED_QUEUES: "Pi_Receipt", PRINTER_NAME: "Other_Queue" }, "not in ALLOWED_QUEUES"],
  ])("refuses to start when misconfigured: %j", async (extra, message) => {
    const { code, stderr } = await exitCode(extra);
    expect(code).toBe(1);
    expect(stderr).toContain(message);
  });

  it("exposes and prints only allowlisted queues when configured", async () => {
    const url = await startBridge({ ALLOWED_QUEUES: "Pi_Receipt", PRINTER_NAME: "Pi_Receipt" });
    const auth = { headers: { "x-api-key": KEY } };

    const printers = await (await fetch(`${url}/printers`, auth)).json();
    expect(printers.printerNames).toEqual(["Pi_Receipt"]);
    expect((await (await fetch(`${url}/health`, auth)).json()).printerNames).toEqual(["Pi_Receipt"]);
    expect((await (await fetch(`${url}/healthz`)).json()).printerNames).toEqual(["Pi_Receipt"]);

    expect((await print(url, { printerName: "Other_Queue" })).status).toBe(403);
    expect((await print(url, { printerName: "../Pi_Receipt" })).status).toBe(400);
    expect((await print(url, { printerName: "-oraw" })).status).toBe(400);
    expect((await print(url, {})).status).toBe(400);
    expect((await print(url, { printerName: "Pi_Receipt", imagePath: "/etc/hosts" })).status).toBe(400);
    expect(lpCalls()).toEqual([]);

    const ok = await print(url, { printerName: "Pi_Receipt" });
    expect(ok.status).toBe(200);
    expect(lpCalls()).toHaveLength(1);
    expect(lpCalls()[0]).toContain("-d Pi_Receipt");
  });

  it("prints server-rendered PDFs non-raw to the allowlisted queue and rejects anything else", async () => {
    const url = await startBridge({ ALLOWED_QUEUES: "Office_Laser", PRINTER_NAME: "Office_Laser" });
    const pdf = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n").toString("base64");
    const send = (body: Record<string, unknown>) => fetch(`${url}/print`, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ printerName: "Office_Laser", format: "pdf", role: "report", ...body }),
    });
    expect((await send({ documentBase64: Buffer.from("not a pdf").toString("base64") })).status).toBe(400);
    expect((await send({ documentBase64: pdf, imageBase64: pdf })).status).toBe(400);
    expect((await send({ documentBase64: pdf, printerName: "Other_Queue" })).status).toBe(403);
    expect(lpCalls()).toEqual([]);
    const ok = await send({ documentBase64: pdf, copies: 2 });
    expect(ok.status).toBe(200);
    const [call] = lpCalls();
    expect(call).toMatch(/^-d Office_Laser -n 2 \S+\.pdf$/);
    expect(call).not.toContain("raw");
  });

  it("still requires the bridge key when configured", async () => {
    const url = await startBridge({ ALLOWED_QUEUES: "Pi_Receipt" });
    expect((await fetch(`${url}/printers`)).status).toBe(401);
    const res = await fetch(`${url}/print`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x", printerName: "Pi_Receipt" }) });
    expect(res.status).toBe(401);
    expect(lpCalls()).toEqual([]);
  });

  it("keeps the legacy behaviour when ALLOWED_QUEUES is unset (Mac)", async () => {
    const url = await startBridge({});
    const printers = await (await fetch(`${url}/printers`, { headers: { "x-api-key": KEY } })).json();
    expect(printers.printerNames).toEqual(["Pi_Receipt", "Other_Queue"]);
    expect((await print(url, { printerName: "Other_Queue" })).status).toBe(200);
    expect(lpCalls()[0]).toContain("-d Other_Queue");
  });
});
