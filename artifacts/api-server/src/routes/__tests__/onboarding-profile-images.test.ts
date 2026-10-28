import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const uploadFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock("../../lib/profileImageStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/profileImageStore")>();
  return {
    ...actual,
    storeTemporaryProfileImage: vi.fn(async (...args: Parameters<typeof actual.storeTemporaryProfileImage>) => {
      if (uploadFailure.enabled) throw new Error("Profile image storage is unavailable.");
      return actual.storeTemporaryProfileImage(...args);
    }),
  };
});

vi.mock("@workspace/db", () => {
  const usersTable = { avatarUrl: "users.avatarUrl" };
  const onboardingRequestsTable = { id: "onboarding.id", createdAt: "onboarding.createdAt", contactEmail: "onboarding.contactEmail" };
  const tenantsTable = {};
  const auditLogsTable = {};
  return {
    db: {
      select: () => ({ from: async () => [] }),
      execute: async () => [],
      transaction: async (work: (tx: unknown) => unknown) => work({}),
      insert: () => ({ values: () => ({ returning: async () => [] }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    }, usersTable, onboardingRequestsTable, tenantsTable, auditLogsTable,
  };
});
vi.mock("../../lib/auth", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { requireAuth: pass, loadDbUser: pass, requireDbUser: pass, requireApproved: pass, requireRecentOwnerAuth: pass };
});
vi.mock("../../lib/roles", () => ({ requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }), desc: (value: unknown) => value,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

let tempRoot = "";
let app: express.Express;
beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "myorder-upload-route-"));
  process.env.PROFILE_IMAGE_DIR = tempRoot;
  process.env.PROFILE_IMAGE_BINDING_KEY = "test-binding-key";
  const { default: onboardingRouter } = await import("../onboarding");
  app = express();
  app.use(express.json());
  app.use("/api", onboardingRouter);
});
afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  delete process.env.PROFILE_IMAGE_DIR;
  delete process.env.PROFILE_IMAGE_BINDING_KEY;
});

async function png() {
  return sharp({ create: { width: 12, height: 12, channels: 3, background: "#a10024" } }).png().toBuffer();
}

describe("POST /api/profile-images", () => {
  it("requires both an email and an image", async () => {
    const response = await supertest(app).post("/api/profile-images").field("email", "person@example.com");
    expect(response.status).toBe(400);
  });

  it("rejects malformed bytes even when the filename and MIME claim PNG", async () => {
    const response = await supertest(app).post("/api/profile-images").field("email", "person@example.com")
      .attach("file", Buffer.from("not an image"), { filename: "profile.png", contentType: "image/png" });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/valid image/i);
  });

  it("rejects content type mismatches and oversized uploads", async () => {
    const mismatch = await supertest(app).post("/api/profile-images").field("email", "person@example.com")
      .attach("file", await png(), { filename: "profile.jpg", contentType: "image/jpeg" });
    expect(mismatch.status).toBe(400);
    const oversized = await supertest(app).post("/api/profile-images").field("email", "person@example.com")
      .attach("file", Buffer.alloc(3 * 1024 * 1024 + 1), { filename: "profile.png", contentType: "image/png" });
    expect(oversized.status).toBe(413);
  });

  it("reports storage failures without returning an upload id or creating a usable image", async () => {
    uploadFailure.enabled = true;
    try {
      const response = await supertest(app).post("/api/profile-images").field("email", "person@example.com")
        .attach("file", await png(), { filename: "profile.png", contentType: "image/png" });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "Profile image storage is unavailable." });
      expect(response.body.uploadId).toBeUndefined();
    } finally { uploadFailure.enabled = false; }
  });

  it("stores a validated image under an opaque name and serves sanitized WebP with safe headers", async () => {
    const upload = await supertest(app).post("/api/profile-images").field("email", "person@example.com")
      .attach("file", await png(), { filename: "untrusted-name.png", contentType: "image/png" });
    expect(upload.status).toBe(201);
    expect(upload.body.uploadId).toMatch(/^[0-9a-f-]{36}$/i);
    const response = await supertest(app).get(`/api/profile-images/${upload.body.uploadId}`);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^image\/webp/);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("sandbox");
    expect(response.headers["content-disposition"]).toContain("profile.webp");
  });
});
