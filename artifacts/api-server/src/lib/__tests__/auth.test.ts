import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("@clerk/express", () => ({
  getAuth: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: { select: vi.fn(), insert: vi.fn() },
  usersTable: { clerkId: "clerkId", id: "id", email: "email" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { requireApproved, requireDbUser, requireRole } from "../auth";

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
    isActive: true,
    ...overrides,
  };
}

describe("requireApproved middleware", () => {
  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    next = vi.fn();
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

  it("calls next() for an admin user regardless of status", () => {
    const req = { dbUser: makeUser({ role: "admin", status: "pending" }) } as unknown as Request;
    const res = makeRes();
    requireApproved(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
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
});
