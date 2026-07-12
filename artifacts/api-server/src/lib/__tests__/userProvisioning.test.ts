/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { users: [] as Array<Record<string, any>>, tenants: [{ id: 1, slug: "myorder" }], audits: [] as Array<Record<string, any>>, events: [] as Array<Record<string, any>>, failInsert: false };

function chain(rows: any[]) {
  let pred: ((r: any) => boolean) | null = null;
  const c: any = {
    from: () => c,
    where: (p: any) => { pred = typeof p === "function" ? p : null; return c; },
    orderBy: () => c,
    limit: async () => (pred ? rows.filter(pred) : rows).slice(0, 1),
  };
  return c;
}
function eq(col: string, val: any) { return (r: any) => r[col] === val; }
function sql(strings: TemplateStringsArray, ...vals: any[]) {
  const text = strings.join("?");
  if (text.includes("normalized_email") && vals.length) return (r: any) => r.normalizedEmail === vals.at(-1);
  return { text, vals };
}

vi.mock("drizzle-orm", () => ({ eq, sql }));
vi.mock("@clerk/express", () => ({ clerkClient: { users: { getUser: vi.fn() } } }));
vi.mock("../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@workspace/db", () => {
  const usersTable = { id: "id", clerkId: "clerkId", slug: "slug", normalizedEmail: "normalizedEmail", email: "email" };
  const tenantsTable = { id: "id", slug: "slug" };
  const auditLogsTable = {};
  const db: any = {
    execute: vi.fn(async () => ({ rows: [{ id: "evt" }] })),
    select: vi.fn(() => ({ from: (table: any) => chain(table === tenantsTable ? state.tenants : state.users) })),
    insert: vi.fn((table: any) => ({
      values: (v: any) => ({
        returning: async () => {
          if (state.failInsert && table === usersTable) throw new Error("db down");
          const row = { id: state.users.length + 1, role: "user", status: "pending", isActive: true, ...v };
          if (table === usersTable) state.users.push(row); else state.audits.push(row);
          return [row];
        },
      }),
    })),
    update: vi.fn((table: any) => ({ set: (patch: any) => ({ where: (pred: any) => ({ returning: async () => {
      const row = state.users.find(pred) ?? state.users[0];
      if (row) Object.assign(row, patch);
      return row ? [row] : [];
    } }) }) })),
  };
  return { db, usersTable, tenantsTable, auditLogsTable };
});

import { provisionVerifiedClerkUser, normalizeEmail } from "../userProvisioning";

const clerk = (id = "user_1", email = "New@Example.com", status = "verified") => ({
  id,
  emailAddresses: [{ id: "em_1", emailAddress: email, verification: { status } }],
  primaryEmailAddressId: "em_1",
  firstName: "New",
});

beforeEach(() => { state.users = []; state.audits = []; state.failInsert = false; vi.clearAllMocks(); });

describe("Clerk provisioning reconciliation", () => {
  it("verified Clerk user automatically creates internal user", async () => {
    const res = await provisionVerifiedClerkUser({ clerkUser: clerk(), source: "test" });
    expect(res.status).toBe("created");
    expect(state.users[0]).toMatchObject({ clerkId: "user_1", normalizedEmail: "new@example.com", role: "user", status: "approved", tenantId: 1 });
  });
  it("duplicate webhook delivery is idempotent by Clerk id", async () => {
    await provisionVerifiedClerkUser({ clerkUser: clerk(), source: "test" });
    const res = await provisionVerifiedClerkUser({ clerkUser: clerk(), source: "test" });
    expect(res.status).toBe("updated");
    expect(state.users).toHaveLength(1);
  });
  it("out-of-order update before create creates safely", async () => {
    const res = await provisionVerifiedClerkUser({ clerkUser: clerk("user_ooo"), source: "webhook:user.updated", requireVerified: false });
    expect(res.user?.clerkId).toBe("user_ooo");
  });
  it("identity exists but local user missing self-heals", async () => {
    const res = await provisionVerifiedClerkUser({ clerkUser: clerk("user_login"), source: "login_reconciliation" });
    expect(res.status).toBe("created");
  });
  it("local user exists but identity missing can be linked from pending invite", async () => {
    state.users.push({ id: 8, clerkId: "pending_invite:1", email: "new@example.com", normalizedEmail: "new@example.com", role: "csr", status: "approved" });
    const res = await provisionVerifiedClerkUser({ clerkUser: clerk("user_real"), source: "test" });
    expect(res.status).toBe("linked");
    expect(state.users[0]).toMatchObject({ clerkId: "user_real", role: "csr" });
  });
  it("normalized email collision is blocked", async () => {
    state.users.push({ id: 9, clerkId: "user_other", email: "new@example.com", normalizedEmail: "new@example.com", role: "user" });
    const res = await provisionVerifiedClerkUser({ clerkUser: clerk("user_new"), source: "test" });
    expect(res.status).toBe("failed");
    expect(res.error).toBe("normalized_email_collision");
  });
  it("changed Clerk email updates normalized email for same Clerk id", async () => {
    state.users.push({ id: 1, clerkId: "user_1", email: "old@example.com", normalizedEmail: "old@example.com", role: "user" });
    await provisionVerifiedClerkUser({ clerkUser: clerk("user_1", "New@Example.com"), source: "test" });
    expect(state.users[0].normalizedEmail).toBe("new@example.com");
  });
  it("unverified secondary email is ignored when primary is verified", async () => {
    const res = await provisionVerifiedClerkUser({ clerkUser: { ...clerk(), emailAddresses: [{ id: "em_1", emailAddress: "primary@example.com", verification: { status: "verified" } }, { id: "em_2", emailAddress: "evil@example.com", verification: { status: "unverified" } }] }, source: "test" });
    expect(res.user?.normalizedEmail).toBe("primary@example.com");
  });
  it("provisioning database failure is reported without creating user", async () => {
    state.failInsert = true;
    const res = await provisionVerifiedClerkUser({ clerkUser: clerk(), source: "test" });
    expect(res.status).toBe("failed");
  });
  it("retry after provisioning failure succeeds", async () => {
    state.failInsert = true; await provisionVerifiedClerkUser({ clerkUser: clerk(), source: "test" });
    state.failInsert = false; const res = await provisionVerifiedClerkUser({ clerkUser: clerk(), source: "test" });
    expect(res.status).toBe("created");
  });
  it("normalizes emails consistently", () => expect(normalizeEmail(" User@Example.COM ")).toBe("user@example.com"));
});
