import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

const mocks = vi.hoisted(() => {
  const state = {
    insertRows: [{ id: "evt_1" }] as unknown[],
    userUpdatePatches: [] as Array<Record<string, unknown>>,
  };
  return {
    state,
    verify: vi.fn(),
    execute: vi.fn(),
    update: vi.fn(),
    ensureProvisioningSchema: vi.fn(),
    provisionVerifiedClerkUser: vi.fn(),
    makeCorrelationId: vi.fn(),
    syncUserToClerk: vi.fn(),
  };
});

vi.mock("svix", () => ({
  Webhook: class {
    verify = mocks.verify;
  },
}));

vi.mock("@workspace/db", () => ({
  db: {
    execute: mocks.execute,
    update: mocks.update,
  },
  usersTable: { clerkId: "clerkId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ text: strings.join("?"), values })),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../lib/userProvisioning", () => ({
  ensureProvisioningSchema: mocks.ensureProvisioningSchema,
  provisionVerifiedClerkUser: mocks.provisionVerifiedClerkUser,
  makeCorrelationId: mocks.makeCorrelationId,
}));

vi.mock("../../lib/clerkSync", () => ({
  syncUserToClerk: mocks.syncUserToClerk,
}));

import webhooksRouter from "../webhooks";

const originalWebhookSecret = process.env.CLERK_WEBHOOK_SECRET;

function queryText(query: unknown): string {
  return typeof query === "object" && query !== null && "text" in query
    ? String((query as { text: unknown }).text)
    : String(query);
}

function processedEventUpdates(): unknown[][] {
  return mocks.execute.mock.calls.filter(([query]) => queryText(query).includes("UPDATE clerk_webhook_events SET status='processed'"));
}

function failedEventUpdates(): unknown[][] {
  return mocks.execute.mock.calls.filter(([query]) => queryText(query).includes("UPDATE clerk_webhook_events SET status='failed'"));
}

function buildApp() {
  const app = express();
  app.use(express.raw({ type: "*/*" }));
  app.use("/api", webhooksRouter);
  return app;
}

function clerkUser(id = "user_1", status = "verified") {
  return {
    id,
    emailAddresses: [{ id: "email_1", emailAddress: `${id}@example.test`, verification: { status } }],
    primaryEmailAddressId: "email_1",
  };
}

async function postWebhook(event: { type: string; data: Record<string, unknown> }, eventId = "evt_1") {
  mocks.verify.mockReturnValueOnce(event);
  return supertest(buildApp())
    .post("/api/webhooks/clerk")
    .set("svix-id", eventId)
    .set("svix-timestamp", "1")
    .set("svix-signature", "sig_test")
    .set("content-type", "application/json")
    .send(Buffer.from("{}"));
}

beforeEach(() => {
  process.env.CLERK_WEBHOOK_SECRET = "whsec_test_local";
  mocks.state.insertRows = [{ id: "evt_1" }];
  mocks.state.userUpdatePatches = [];
  mocks.verify.mockReset();
  mocks.execute.mockReset();
  mocks.update.mockReset();
  mocks.ensureProvisioningSchema.mockReset();
  mocks.provisionVerifiedClerkUser.mockReset();
  mocks.makeCorrelationId.mockReset();
  mocks.syncUserToClerk.mockReset();
  mocks.ensureProvisioningSchema.mockResolvedValue(undefined);
  mocks.makeCorrelationId.mockReturnValue("wh_test");
  mocks.provisionVerifiedClerkUser.mockResolvedValue({
    status: "created",
    user: { status: "approved", role: "user" },
    correlationId: "wh_test",
  });
  mocks.syncUserToClerk.mockResolvedValue(undefined);
  mocks.execute.mockImplementation(async (query: unknown) => {
    if (queryText(query).includes("INSERT INTO clerk_webhook_events")) {
      return { rows: mocks.state.insertRows };
    }
    return { rows: [] };
  });
  mocks.update.mockImplementation(() => ({
    set: (patch: Record<string, unknown>) => {
      mocks.state.userUpdatePatches.push(patch);
      return { where: vi.fn(async () => []) };
    },
  }));
});

afterEach(() => {
  if (originalWebhookSecret === undefined) {
    delete process.env.CLERK_WEBHOOK_SECRET;
  } else {
    process.env.CLERK_WEBHOOK_SECRET = originalWebhookSecret;
  }
});

describe("Clerk webhook route", () => {
  it("provisions verified user.created events with the verified-identity requirement", async () => {
    const res = await postWebhook({ type: "user.created", data: clerkUser("user_created") });

    expect(res.status).toBe(200);
    expect(mocks.provisionVerifiedClerkUser).toHaveBeenCalledWith(expect.objectContaining({
      clerkUser: expect.objectContaining({ id: "user_created" }),
      source: "webhook:user.created",
      correlationId: "wh_test",
      requireVerified: true,
    }));
    expect(mocks.syncUserToClerk).toHaveBeenCalledWith("user_created", { status: "approved", role: "user" });
    expect(processedEventUpdates()).toHaveLength(1);
  });

  it("provisions verified user.updated events with the verified-identity requirement", async () => {
    const res = await postWebhook({ type: "user.updated", data: clerkUser("user_updated") });

    expect(res.status).toBe(200);
    expect(mocks.provisionVerifiedClerkUser).toHaveBeenCalledWith(expect.objectContaining({
      clerkUser: expect.objectContaining({ id: "user_updated" }),
      source: "webhook:user.updated",
      requireVerified: true,
    }));
    expect(mocks.syncUserToClerk).toHaveBeenCalledWith("user_updated", { status: "approved", role: "user" });
    expect(processedEventUpdates()).toHaveLength(1);
  });

  it("does not relax verification for an unverified user.updated event", async () => {
    mocks.provisionVerifiedClerkUser.mockResolvedValueOnce({
      status: "skipped",
      user: null,
      correlationId: "wh_test",
      error: "email_not_verified",
    });

    const res = await postWebhook({ type: "user.updated", data: clerkUser("user_unverified", "unverified") });

    expect(res.status).toBe(200);
    expect(mocks.provisionVerifiedClerkUser).toHaveBeenCalledWith(expect.objectContaining({
      source: "webhook:user.updated",
      requireVerified: true,
    }));
    expect(mocks.syncUserToClerk).not.toHaveBeenCalled();
    expect(processedEventUpdates()).toHaveLength(1);
    expect(failedEventUpdates()).toHaveLength(0);
  });

  it.each(["email.created", "email.updated"] as const)("%s does not provision users and is marked processed", async (type) => {
    const res = await postWebhook({ type, data: { id: "email_evt_1", user_id: "user_email" } });

    expect(res.status).toBe(200);
    expect(mocks.provisionVerifiedClerkUser).not.toHaveBeenCalled();
    expect(mocks.syncUserToClerk).not.toHaveBeenCalled();
    expect(processedEventUpdates()).toHaveLength(1);
  });

  it("does not repeat provisioning for duplicate webhook event ids", async () => {
    mocks.state.insertRows = [];

    const res = await postWebhook({ type: "user.created", data: clerkUser("user_duplicate") }, "evt_duplicate");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: true, correlationId: "wh_test" });
    expect(mocks.provisionVerifiedClerkUser).not.toHaveBeenCalled();
    expect(mocks.syncUserToClerk).not.toHaveBeenCalled();
    expect(processedEventUpdates()).toHaveLength(0);
  });

  it("rejects invalid signatures before schema checks or provisioning", async () => {
    mocks.verify.mockImplementationOnce(() => {
      throw new Error("invalid signature");
    });

    const res = await supertest(buildApp())
      .post("/api/webhooks/clerk")
      .set("svix-id", "evt_bad")
      .set("svix-timestamp", "1")
      .set("svix-signature", "sig_bad")
      .set("content-type", "application/json")
      .send(Buffer.from("{}"));

    expect(res.status).toBe(400);
    expect(mocks.ensureProvisioningSchema).not.toHaveBeenCalled();
    expect(mocks.provisionVerifiedClerkUser).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("marks deleted Clerk users inactive without provisioning", async () => {
    const res = await postWebhook({ type: "user.deleted", data: { id: "user_deleted" } });

    expect(res.status).toBe(200);
    expect(mocks.provisionVerifiedClerkUser).not.toHaveBeenCalled();
    expect(mocks.state.userUpdatePatches[0]).toMatchObject({
      identityStatus: "deactivated",
      provisioningStatus: "identity_missing",
      isActive: false,
    });
    expect(processedEventUpdates()).toHaveLength(1);
  });
});
