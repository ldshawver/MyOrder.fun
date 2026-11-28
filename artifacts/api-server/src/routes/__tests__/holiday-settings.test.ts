import express from "express";
import supertest from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  actor: { id: 1, role: "supervisor", tenantId: 1, email: "staff@example.test", status: "approved", isActive: true, clerkId: "staff", approvedByClerkId: "owner", approvedAt: new Date() },
  writes: vi.fn(),
  load: vi.fn(),
}));

vi.mock("@clerk/express", async importOriginal => ({ ...await importOriginal<typeof import("@clerk/express")>(), getAuth: () => ({ userId: "staff" }) }));

vi.mock("../../lib/auth", async importOriginal => {
  const actual = await importOriginal<typeof import("../../lib/auth")>();
  return {
    ...actual,
    requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    loadDbUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.dbUser = fixtures.actor as never;
      next();
    },
  };
});
vi.mock("../../lib/holidayDecorations", async importOriginal => ({
  ...await importOriginal<typeof import("../../lib/holidayDecorations")>(),
  loadHolidaySettings: fixtures.load,
}));
vi.mock("@workspace/db", async importOriginal => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return { ...actual, db: { ...actual.db, transaction: fixtures.writes } };
});

const settings = (await import("../settings")).default;
const app = express();
app.use(express.json(), settings);
const route = "/admin/settings/holiday-decorations";
const input = { automatic: true, animated: false, disabled: [], manual: "easter", version: 0 };

beforeEach(() => {
  vi.stubEnv("MYORDER_OWNER_CLERK_ID", "owner");
  fixtures.actor = { ...fixtures.actor, role: "supervisor", tenantId: 1 };
  fixtures.writes.mockReset();
  fixtures.load.mockReset().mockImplementation(async (tenantId: number) => ({
    settings: { ...input, manual: tenantId === 1 ? "easter" : "newyear" },
    version: 0, timezone: "America/Los_Angeles",
  }));
});

afterEach(() => vi.unstubAllEnvs());

describe("holiday decoration administration", () => {
  it.each(["supervisor", "admin", "global_admin"])("lets a %s load scoped settings", async role => {
    fixtures.actor.role = role;
    const response = await supertest(app).get(route);
    expect(response.status, response.text).toBe(200);
    expect(fixtures.load).toHaveBeenCalledWith(1);
    expect(response.body.themes).toHaveLength(10);
  });

  it("blocks customers and cross-tenant selectors before accessing settings", async () => {
    expect((await supertest(app).get(route + "?tenantId=2")).status).toBe(403);
    expect((await supertest(app).put(route).send({ ...input, tenantId: 2 })).status).toBe(403);
    fixtures.actor.role = "user";
    expect((await supertest(app).get(route)).status).toBe(403);
    expect((await supertest(app).put(route).send(input)).status).toBe(403);
    expect(fixtures.load).not.toHaveBeenCalled();
    expect(fixtures.writes).not.toHaveBeenCalled();
  });

  it("validates updates, persists settings under the assigned tenant and audits in the same transaction", async () => {
    const audit = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValueOnce({
      values: vi.fn().mockImplementation(values => {
        expect(values).toEqual({ tenantId: 1, preferences: { automatic: true, animated: false, disabled: [], manual: "easter" } });
        return { onConflictDoNothing: () => ({ returning: async () => [{ version: 1 }] }) };
      }),
    }).mockReturnValueOnce({ values: audit });
    fixtures.writes.mockImplementationOnce(callback => callback({ insert }));
    expect((await supertest(app).put(route).send({ ...input, manual: "unknown" })).status).toBe(422);
    const response = await supertest(app).put(route).send(input);
    expect(response.status, response.text).toBe(200);
    expect(response.body.version).toBe(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 1, action: "HOLIDAY_DECORATIONS_UPDATED" }));
  });

  it("returns a conflict for a stale version", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    fixtures.writes.mockImplementation(callback => callback({
      update: () => ({ set: () => ({ where: () => ({ returning }) }) }),
    }));
    expect((await supertest(app).put(route).send({ ...input, version: 4 })).status).toBe(409);
    expect(returning).toHaveBeenCalledOnce();
  });
});
