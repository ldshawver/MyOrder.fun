/**
 * Tests for simplePrint.ts (Task #9).
 *
 * Mocks node:child_process.spawn for the local CUPS path and global fetch for
 * the Tailscale bridge path. Verifies command shape, ESC/POS framing, friendly
 * error messages, and AbortController-based bridge timeouts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import {
  buildReceiptTestPayload,
  buildLabelTestPayload,
  printViaCups,
  printViaBridge,
  probeBridge,
  probeCupsQueues,
  isValidQueueName,
  DEFAULT_BRIDGE_URL,
} from "../simplePrint";

interface FakeProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (b: Buffer) => void; end: () => void; on: (ev: string, fn: () => void) => void };
  __writes: Buffer[];
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  const writes: Buffer[] = [];
  proc.__writes = writes;
  proc.stdin = {
    write: (b: Buffer) => { writes.push(b); },
    end: () => {},
    on: () => {},
  };
  return proc;
}

beforeEach(() => {
  spawnMock.mockReset();
  delete process.env.PRINT_BRIDGE_URL;
  delete process.env.PRINT_BRIDGE_API_KEY;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.PRINT_BRIDGE_HEALTH_TIMEOUT_MS;
});

describe("isValidQueueName", () => {
  it("accepts safe names", () => {
    expect(isValidQueueName("receipt")).toBe(true);
    expect(isValidQueueName("Reciept_POS80_Printer")).toBe(true);
    expect(isValidQueueName("label-1.test")).toBe(true);
  });
  it("rejects unsafe names", () => {
    expect(isValidQueueName("receipt; rm -rf /")).toBe(false);
    expect(isValidQueueName("$(whoami)")).toBe(false);
    expect(isValidQueueName("")).toBe(false);
    expect(isValidQueueName("a".repeat(65))).toBe(false);
  });
});

describe("printViaCups", () => {
  it("invokes lp -d <queue>, pipes ESC/POS payload via stdin, returns ok on exit 0", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const promise = printViaCups("receipt", buildReceiptTestPayload());
    // emit lp output then close
    setImmediate(() => {
      proc.stdout.emit("data", Buffer.from("request id is receipt-42 (1 file(s))\n"));
      proc.emit("close", 0);
    });
    const result = await promise;

    expect(spawnMock).toHaveBeenCalledWith(
      "lp",
      ["-d", "receipt"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
    // payload contains ESC/POS reset and cut commands
    const payload = Buffer.concat(proc.__writes).toString("binary");
    expect(payload.startsWith("\x1b@")).toBe(true);
    expect(payload.endsWith("\x1dV1")).toBe(true);
    expect(payload).toContain("TEST RECEIPT");

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("local_cups");
    expect(result.printerName).toBe("receipt");
    expect(result.jobRef).toBe("receipt-42");
    // The full required response contract (ok, command, stdout, stderr, exitCode).
    expect(result.command).toBe("lp -d receipt");
    expect(result.stdout).toContain("request id is receipt-42");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("returns a friendly error when lp exits non-zero", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValueOnce(proc);

    const promise = printViaCups("label", buildLabelTestPayload());
    setImmediate(() => {
      proc.stderr.emit("data", Buffer.from("lp: The printer or class does not exist."));
      proc.emit("close", 1);
    });
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/lp exited with code 1/);
    expect(result.message).toContain("label");
    expect(result.exitCode).toBe(1);
  });

  it("rejects unsafe queue names without spawning lp", async () => {
    const result = await printViaCups("receipt; rm -rf /", buildReceiptTestPayload());
    expect(spawnMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Invalid CUPS queue name/);
  });
});

describe("probeBridge", () => {
  it("returns a friendly timeout message when the bridge is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const result = await probeBridge(DEFAULT_BRIDGE_URL, 30);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Bridge unreachable");
    expect(result.message).toContain(DEFAULT_BRIDGE_URL);
    expect(result.message).toMatch(/Local VPS CUPS|Tailscale/);
  });

  it("returns ok with latency when the bridge responds 200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const result = await probeBridge(DEFAULT_BRIDGE_URL, 1000);
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
  });
});

describe("printViaBridge", () => {
  it("accepts a health response after 2 seconds when the configured timeout is 10 seconds", async () => {
    vi.useFakeTimers();
    process.env.PRINT_BRIDGE_HEALTH_TIMEOUT_MS = "10000";
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve(new Response("ok", { status: 200 })), 2500);
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

    const resultPromise = printViaBridge(
      "receipt",
      "Brightek_POS80",
      buildReceiptTestPayload(),
      "http://bridge.test",
      1000,
    );
    await vi.advanceTimersByTimeAsync(2500);
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toBe("http://bridge.test/print");
  });

  it("an actual health timeout prevents POST /print", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => (
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })
    ));

    const resultPromise = printViaBridge(
      "receipt",
      "Brightek_POS80",
      buildReceiptTestPayload(),
      "http://bridge.test",
      1000,
      10000,
    );
    await vi.advanceTimersByTimeAsync(10000);
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.message).toContain("timeout after 10000ms");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("http://bridge.test/healthz");
  });

  it("a non-success health response prevents printing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("offline", { status: 503 }));

    const result = await printViaBridge(
      "receipt",
      "Brightek_POS80",
      buildReceiptTestPayload(),
      "http://bridge.test",
      1000,
      10000,
    );

    expect(result.ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("http://bridge.test/healthz");
  });

  it("sends an x-api-key header when PRINT_BRIDGE_API_KEY is set", async () => {
    process.env.PRINT_BRIDGE_API_KEY = "secret-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))            // /healthz
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })); // /print

    const result = await printViaBridge("receipt", "receipt", buildReceiptTestPayload(), "http://bridge.test", 1000);

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const printCall = fetchSpy.mock.calls[1];
    expect(printCall[0]).toBe("http://bridge.test/print");
    const init = printCall[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("secret-key");
    const body = JSON.parse(String(init.body));
    expect(body.role).toBe("receipt");
    expect(body.printer).toBe("receipt");
    expect(typeof body.payloadBase64).toBe("string");
  });

  it("posts exactly once to the requested Brightek queue without fallback or retry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

    const result = await printViaBridge(
      "receipt",
      "Brightek_POS80",
      buildReceiptTestPayload(),
      "http://bridge.test",
      1000,
      10000,
    );

    expect(result.ok).toBe(true);
    expect(result.printerName).toBe("Brightek_POS80");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const postCalls = fetchSpy.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(postCalls).toHaveLength(1);
    const body = JSON.parse(String(postCalls[0][1]?.body));
    expect(body.printer).toBe("Brightek_POS80");
    expect(JSON.stringify(body)).not.toContain("Label_Themal_Printer");
  });

  it("returns a friendly error when the bridge health check fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const result = await printViaBridge("label", "label", buildLabelTestPayload(), "http://bridge.test", 30);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Bridge unreachable");
  });
});

describe("probeCupsQueues", () => {
  it("parses queues from lpstat -p output", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValueOnce(proc);
    const promise = probeCupsQueues();
    setImmediate(() => {
      proc.stdout.emit("data", Buffer.from(
        "printer receipt is idle.  enabled since ...\nprinter label is idle.  enabled since ...\n",
      ));
      proc.emit("close", 0);
    });
    const r = await promise;
    expect(spawnMock).toHaveBeenCalledWith("lpstat", ["-p"], expect.any(Object));
    expect(r.ok).toBe(true);
    expect(r.queues).toEqual(["receipt", "label"]);
  });
});
