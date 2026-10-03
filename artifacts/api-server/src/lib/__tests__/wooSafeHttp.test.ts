import { EventEmitter } from "node:events";
import type { request } from "node:https";
import { describe, expect, it, vi } from "vitest";
import { assertWooHttpsOrigin, fetchWooSafely, isPublicWooAddress, resolvePublicWooAddress } from "../wooSafeHttp";

describe("WooCommerce SSRF boundary", () => {
  it.each(["http://shop.example", "https://user:pass@shop.example", "https://localhost", "https://127.0.0.1", "https://10.0.0.2", "https://169.254.169.254", "https://[::1]", "https://[fc00::1]", "https://shop.local", "https://shop.example/path", "https://shop.example?secret=1"])("rejects prohibited origin %s", url => {
    expect(() => assertWooHttpsOrigin(url)).toThrow();
  });

  it.each(["10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "198.51.100.2", "203.0.113.3", "::1", "fe80::1", "fd00::1", "2001:db8::1", "2001:0db8::1", "2001::1", "2002:0a00:0001::1", "::ffff:127.0.0.1"])("blocks private resolution %s", address => {
    expect(isPublicWooAddress(address)).toBe(false);
  });

  it("rejects a hostname if any DNS result is private", async () => {
    const resolver = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.1.2.3", family: 4 }]);
    await expect(resolvePublicWooAddress("shop.example", resolver as never)).rejects.toThrow(/prohibited/);
  });

  it("pins a public DNS answer", async () => {
    const resolver = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    await expect(resolvePublicWooAddress("shop.example", resolver as never)).resolves.toEqual({ address: "8.8.8.8", family: 4 });
  });

  it("returns a pinned address record list when Node requests all DNS answers", async () => {
    const transport = vi.fn((_url, options: { lookup: (host: string, options: { all: boolean }, callback: (error: Error | null, addresses: unknown) => void) => void }, respond: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.end = () => options.lookup("8.8.8.8", { all: true }, (error, addresses) => {
        expect(error).toBeNull();
        expect(addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> };
        res.statusCode = 200;
        res.headers = { "content-type": "application/json" };
        respond(res);
        res.emit("data", Buffer.from("{}"));
        res.emit("end");
      });
      req.destroy = vi.fn();
      return req;
    });
    const response = await fetchWooSafely("https://8.8.8.8", "/wp-json/wc/v3/system_status", "ck_synthetic", "cs_synthetic", transport as unknown as typeof request);
    expect(response.status).toBe(200);
  });

  it("authenticates a synthetic WooCommerce response over the checked transport", async () => {
    const transport = vi.fn((_url, options: { headers: Record<string, string> }, respond: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) => {
      expect(options.headers.Authorization).toBe(`Basic ${Buffer.from("ck_synthetic:cs_synthetic").toString("base64")}`);
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.end = () => queueMicrotask(() => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> };
        res.statusCode = 200;
        res.headers = { "content-type": "application/json" };
        respond(res);
        res.emit("data", Buffer.from('{"environment":{"version":"synthetic"}}'));
        res.emit("end");
      });
      req.destroy = vi.fn();
      return req;
    });
    const response = await fetchWooSafely("https://shop.example", "/wp-json/wc/v3/system_status", "ck_synthetic", "cs_synthetic", transport as unknown as typeof request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ environment: { version: "synthetic" } });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects without forwarding credentials", async () => {
    const transport = vi.fn((_url, _options, respond: (res: EventEmitter & { statusCode: number; destroy: () => void }) => void) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.end = () => queueMicrotask(() => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number; destroy: () => void };
        res.statusCode = 302;
        res.destroy = vi.fn();
        respond(res);
      });
      req.destroy = vi.fn();
      return req;
    });
    await expect(fetchWooSafely("https://shop.example", "/wp-json/wc/v3/system_status", "ck_sentinel", "cs_sentinel", transport as unknown as typeof request)).rejects.toThrow(/redirect/);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
