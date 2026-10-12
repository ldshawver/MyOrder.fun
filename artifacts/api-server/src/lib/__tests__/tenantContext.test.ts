import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { requireTenantContext } from "../tenantContext";

function resolve(role: string, tenantId: number | null, query: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  const req = { dbUser: { role, tenantId }, query, body } as unknown as Request;
  let status = 200;
  const json = vi.fn();
  const res = { status(code: number) { status = code; return this; }, json } as unknown as Response;
  const next = vi.fn();
  requireTenantContext(req, res, next);
  return { status, tenantId: req.authorizedTenantId, next };
}

describe("tenant context authority", () => {
  it("keeps normal single tenant requests working", () => {
    const result = resolve("admin", 12);
    expect(result).toMatchObject({ status: 200, tenantId: 12 });
    expect(result.next).toHaveBeenCalledOnce();
  });
  it("rejects cross tenant selection and malformed IDs", () => {
    expect(resolve("admin", 12, { tenantId: "13" }).status).toBe(403);
    expect(resolve("admin", 12, { tenantId: "abc" }).status).toBe(400);
    expect(resolve("admin", 12, { tenantId: "12x" }).status).toBe(400);
  });
  it("requires a deliberate tenant from tenantless global admin", () => {
    expect(resolve("global_admin", null).status).toBe(403);
    expect(resolve("global_admin", null, { tenantId: "15" }).tenantId).toBe(15);
  });
  it("rejects conflicting query and body tenant IDs", () => {
    expect(resolve("global_admin", null, { tenantId: "15" }, { tenantId: 16 }).status).toBe(400);
  });
});
