import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { requireTenantContext } from "../tenantContext";

vi.mock("@clerk/express", () => ({
  getAuth: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(() => Promise.resolve()), select: vi.fn(), insert: vi.fn() },
  usersTable: { clerkId: "clerkId", id: "id", email: "email" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { isConfiguredAccountOwner, normalizeRole, requireApproved, requireDbUser, requireRole } from "../auth";

function makeRes() {
  const res = {
    statusCode: 200,
    _json: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this._json = body;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; _json: unknown };
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    clerkId: "clerk_test",
    email: "test@example.com",
    role: "user",
    status: "approved",
    approvedByClerkId: "configured_owner",
    approvedAt: new Date(),
    isActive: true,
    ...overrides,
  };
}

describe("requireApproved middleware", () => {
  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    next = vi.fn();
    process.env.MYORDER_OWNER_CLERK_ID = "configured_owner";
    vi.mocked(getAuth).mockReturnValue(null as never);
  });

  it("returns 401 when req.dbUser is not set", () => {
    const req = {} as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 for a user with status 'pending'", () => {
    const req = { dbUser: makeUser({ status: "pending" }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
    expect((res._json as Record<string, unknown>).error).toMatch(/pending approval/i);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 for a user with status 'rejected'", () => {
    const req = { dbUser: makeUser({ status: "rejected" }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() for a user with status 'approved'", () => {
    const req = { dbUser: makeUser({ status: "approved" }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it("fails closed for legacy approved accounts without owner provenance", () => {
    const req = { dbUser: makeUser({ approvedByClerkId: null, approvedAt: null }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows the authenticated configured owner with approved status and incomplete provenance", () => {
    vi.mocked(getAuth).mockReturnValue({ userId: "configured_owner", sessionClaims: {} } as never);
    const req = { dbUser: makeUser({ clerkId: "configured_owner", approvedByClerkId: null, approvedAt: null }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it("allows the authenticated configured owner with pending status", () => {
    vi.mocked(getAuth).mockReturnValue({ userId: "configured_owner", sessionClaims: {} } as never);
    const req = { dbUser: makeUser({ clerkId: "configured_owner", status: "pending", approvedByClerkId: null, approvedAt: null }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
  });

  it("requires the authenticated Clerk subject and configured database identity to match exactly", () => {
    vi.mocked(getAuth).mockReturnValue({ userId: "different_subject", sessionClaims: {} } as never);
    const req = { dbUser: makeUser({ clerkId: "configured_owner", status: "pending" }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not grant owner access based on a matching email", () => {
    vi.mocked(getAuth).mockReturnValue({ userId: "non_owner_subject", sessionClaims: {} } as never);
    const req = { dbUser: makeUser({ clerkId: "non_owner_subject", email: "owner@example.invalid", approvedByClerkId: null, approvedAt: null }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not grant owner access from Clerk metadata or a frontend role", () => {
    vi.mocked(getAuth).mockReturnValue({ userId: "non_owner_subject", sessionClaims: { publicMetadata: { role: "global_admin", status: "approved" } } } as never);
    const req = { dbUser: makeUser({ clerkId: "non_owner_subject", role: "global_admin", approvedByClerkId: null, approvedAt: null }), role: "global_admin" } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not let the owner exception bypass a later tenant or object authorization check", () => {
    vi.mocked(getAuth).mockReturnValue({ userId: "configured_owner", sessionClaims: {} } as never);
    const req = { dbUser: makeUser({ clerkId: "configured_owner", role: "user", tenantId: 1 }), query: { tenantId: "2" }, body: {} } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, (() => requireTenantContext(req, res, next as NextFunction)) as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect((res._json as Record<string, unknown>).error).toMatch(/tenant assignment does not match/i);
  });

  it("blocks an admin user with pending status", () => {
    const req = { dbUser: makeUser({ role: "admin", status: "pending" }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("blocks a csr with pending status", () => {
    const req = { dbUser: makeUser({ role: "csr", status: "pending" }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("blocks a rejected staff user", () => {
    const req = { dbUser: makeUser({ role: "csr", status: "rejected" }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
    expect((res._json as Record<string, unknown>).status).toBe("rejected");
    expect(next).not.toHaveBeenCalled();
  });

  it("blocks an inactive approved staff user", () => {
    const req = { dbUser: makeUser({ role: "csr", status: "approved", isActive: false }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
    expect((res._json as Record<string, unknown>).error).toMatch(/deactivated/i);
    expect(next).not.toHaveBeenCalled();
  });

  it("403 response body includes the user's status field", () => {
    const req = { dbUser: makeUser({ status: "pending" }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect((res._json as Record<string, unknown>).status).toBe("pending");
  });

  it("403 response body includes 'pending' when status is null/undefined", () => {
    const req = { dbUser: makeUser({ status: null }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
    expect((res._json as Record<string, unknown>).status).toBe("pending");
  });
});

describe("requireDbUser middleware", () => {
  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    next = vi.fn();
  });

  it("returns 401 when req.dbUser is not set", () => {
    const req = {} as Request;
    const res = makeRes();
    requireDbUser(req, res, next as NextFunction);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when req.dbUser is set", () => {
    const req = { dbUser: makeUser() } as unknown as Request;
    const res = makeRes();
    requireDbUser(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("requireRole middleware", () => {
  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    next = vi.fn();
  });

  it("returns 401 when req.dbUser is not set", () => {
    const req = {} as Request;
    const res = makeRes();
    requireRole("admin")(req, res, next as NextFunction);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when user does not have the required role", () => {
    const req = { dbUser: makeUser({ role: "user" }) } as unknown as Request;
    const res = makeRes();
    requireRole("admin")(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when user has the required role", () => {
    const req = { dbUser: makeUser({ role: "admin" }) } as unknown as Request;
    const res = makeRes();
    requireRole("admin")(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next() when user has one of the allowed roles", () => {
    const req = { dbUser: makeUser({ role: "supervisor" }) } as unknown as Request;
    const res = makeRes();
    requireRole("admin", "supervisor")(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not treat supervisor as admin", () => {
    const req = { dbUser: makeUser({ role: "supervisor" }) } as unknown as Request;
    const res = makeRes();
    requireRole("admin")(req, res, next as NextFunction);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("treats legacy customer_service_rep DB value as csr", () => {
    const req = { dbUser: makeUser({ role: "customer_service_rep" }) } as unknown as Request;
    const res = makeRes();
    requireRole("csr")(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
  });
});


describe("normalizeRole", () => {
  it.each([
    ["CSR", "csr"],
    ["customer_service_rep", "csr"],
    ["csr", "csr"],
    ["Admin", "admin"],
    ["supervisor", "supervisor"],
    ["Supervisor", "supervisor"],
    ["admin", "admin"],
    ["tenant_admin", "admin"],
    ["manager", "admin"],
    ["global-admin", "global_admin"],
    ["GlobalAdmin", "global_admin"],
    ["globalAdmin", "global_admin"],
    ["super_admin", "global_admin"],
    ["User", "user"],
    ["unknown", "user"],
    [null, "user"],
    ["Customer-Service-Representative", "csr"],
  ])("normalizes %s to %s", (role, expected) => {
    expect(normalizeRole(role)).toBe(expected);
  });
});

describe("owner-only approval identity", () => {
  const previous = process.env.MYORDER_OWNER_CLERK_ID;

  afterEach(() => {
    if (previous === undefined) delete process.env.MYORDER_OWNER_CLERK_ID;
    else process.env.MYORDER_OWNER_CLERK_ID = previous;
  });

  it("fails closed when the owner identity is not configured", () => {
    delete process.env.MYORDER_OWNER_CLERK_ID;
    expect(isConfiguredAccountOwner({ clerkId: "owner" })).toBe(false);
  });

  it("accepts only the exact configured Clerk identity", () => {
    process.env.MYORDER_OWNER_CLERK_ID = "owner_clerk_id";
    expect(isConfiguredAccountOwner({ clerkId: "owner_clerk_id" })).toBe(true);
    expect(isConfiguredAccountOwner({ clerkId: "other_clerk_id" })).toBe(false);
  });
});
