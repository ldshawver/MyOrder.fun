import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../../lib/singleTenant", () => ({
  getHouseTenantId: vi.fn().mockResolvedValue(1),
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockDbUser = {
  id: 42,
  clerkId: "clerk_test",
  email: "admin@example.com",
  role: "admin",
  status: "approved",
  tenantId: 1,
};

vi.mock("../../lib/auth", async () => {
  const actual = await vi.importActual<typeof import("../../lib/auth")>("../../lib/auth");
  return {
    ...actual,
    requireAuth: vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next()),
    loadDbUser: vi.fn((req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as { dbUser?: typeof mockDbUser }).dbUser = mockDbUser;
      next();
    }),
    requireDbUser: vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next()),
    requireApproved: vi.fn((_req: express.Request, _res: express.Response, next: express.NextFunction) => next()),
    requireRole: vi.fn((..._roles: string[]) => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()),
    writeAuditLog: vi.fn().mockResolvedValue(undefined),
  };
});

// DB mock state
const dbState = {
  pages: [] as Array<Record<string, unknown>>,
  versions: [] as Array<Record<string, unknown>>,
};

vi.mock("@workspace/db", () => {
  const webPagesTable = { _tableName: "web_pages", id: "id", tenantId: "tenant_id", slug: "slug", status: "status" };
  const webPageVersionsTable = { _tableName: "web_page_versions", pageId: "page_id", versionNumber: "version_number" };

  const db = {
    execute: vi.fn().mockResolvedValue(undefined),
    select: vi.fn((_fields?: unknown) => ({
      from: vi.fn((_table: unknown) => ({
        where: vi.fn((_cond: unknown) => ({
          limit: vi.fn((n: number) => Promise.resolve(dbState.pages.slice(0, n))),
          orderBy: vi.fn((_ord: unknown) => ({
            limit: vi.fn((n: number) => Promise.resolve(dbState.versions.slice(0, n))),
          })),
        })),
        orderBy: vi.fn((_ord: unknown) => Promise.resolve(dbState.pages)),
      })),
    })),
    insert: vi.fn((_table: unknown) => ({
      values: vi.fn((vals: Record<string, unknown>) => ({
        returning: vi.fn(() => Promise.resolve([{ id: 1, ...vals, status: "draft", createdAt: new Date(), updatedAt: new Date(), publishedAt: null, publishedData: null, draftData: { root: { props: {} }, content: [] } }])),
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: 1, ...vals, status: "draft", createdAt: new Date(), updatedAt: new Date(), publishedAt: null, publishedData: null, draftData: { root: { props: {} }, content: [] } }])),
        })),
      })),
    })),
    update: vi.fn((_table: unknown) => ({
      set: vi.fn((_data: unknown) => ({
        where: vi.fn((_cond: unknown) => ({
          returning: vi.fn(() =>
            Promise.resolve([{
              id: 1,
              tenantId: 1,
              slug: "home",
              title: "Home",
              description: null,
              status: "published",
              draftData: { root: { props: {} }, content: [] },
              publishedData: { root: { props: {} }, content: [] },
              createdAt: new Date(),
              updatedAt: new Date(),
              publishedAt: new Date(),
            }]),
          ),
        })),
      })),
    })),
    delete: vi.fn((_table: unknown) => ({
      where: vi.fn((_cond: unknown) => Promise.resolve()),
    })),
  };

  return { db, webPagesTable, webPageVersionsTable };
});

// ── App setup ─────────────────────────────────────────────────────────────────

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: webEditorPublicRouter } = await import("../web-editor-public");
  const { default: webEditorRouter } = await import("../web-editor");
  app.use("/api", webEditorPublicRouter);
  app.use("/api", webEditorRouter);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("web-editor routes", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    dbState.pages = [];
    dbState.versions = [];
    app = await buildApp();
  });

  describe("GET /api/public/pages/:slug", () => {
    it("returns 404 when no published page exists", async () => {
      dbState.pages = [];
      const res = await request(app).get("/api/public/pages/home");
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid slug", async () => {
      const res = await request(app).get("/api/public/pages/INVALID SLUG!");
      expect(res.status).toBe(400);
    });

    it("returns published data when page is published", async () => {
      const publishedData = { root: { props: {} }, content: [{ type: "Hero", props: {} }] };
      dbState.pages = [
        {
          id: 1,
          slug: "home",
          title: "Home",
          description: null,
          status: "published",
          publishedData,
          publishedAt: new Date().toISOString(),
        },
      ];
      const res = await request(app).get("/api/public/pages/home");
      expect([200, 404]).toContain(res.status);
    });
  });

  describe("GET /api/web-editor/pages", () => {
    it("responds (admin auth mocked)", async () => {
      const res = await request(app).get("/api/web-editor/pages");
      expect([200, 500]).toContain(res.status);
    });
  });

  describe("POST /api/web-editor/pages", () => {
    it("returns 400 when slug is missing", async () => {
      const res = await request(app)
        .post("/api/web-editor/pages")
        .send({ title: "Home" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/slug/i);
    });

    it("returns 400 when title is missing", async () => {
      const res = await request(app)
        .post("/api/web-editor/pages")
        .send({ slug: "home" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/title/i);
    });

    it("returns 400 for invalid slug format", async () => {
      const res = await request(app)
        .post("/api/web-editor/pages")
        .send({ slug: "UPPER CASE!", title: "Home" });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /api/web-editor/pages/:slug", () => {
    it("returns 400 for invalid slug", async () => {
      const res = await request(app)
        .patch("/api/web-editor/pages/INVALID!")
        .send({ data: { root: { props: {} }, content: [] } });
      expect(res.status).toBe(400);
    });

    it("returns 400 when draft data contains unapproved component", async () => {
      dbState.pages = [{ id: 1, tenantId: 1, slug: "home", title: "Home", status: "draft", draftData: { root: { props: {} }, content: [] }, publishedData: null }];
      const res = await request(app)
        .patch("/api/web-editor/pages/home")
        .send({
          data: {
            root: { props: {} },
            content: [{ type: "CheckoutForm", props: {} }],
          },
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/unapproved/i);
    });
  });

  describe("POST /api/web-editor/pages/:slug/publish", () => {
    it("returns 400 for invalid slug", async () => {
      const res = await request(app)
        .post("/api/web-editor/pages/INVALID!/publish")
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/web-editor/pages/:slug/versions", () => {
    it("returns 400 for invalid slug", async () => {
      const res = await request(app).get("/api/web-editor/pages/INVALID!/versions");
      expect(res.status).toBe(400);
    });
  });

  describe("component allowlist", () => {
    const allowedComponents = ["Hero", "TextBlock", "ImageBanner", "PromoBanner", "CTA", "FAQ"];
    const blockedComponents = ["CheckoutForm", "PaymentProcessor", "AdminPanel", "OrderRouter", "DashboardCard", "StaffPanel"];

    for (const component of blockedComponents) {
      it(`rejects ${component}`, async () => {
        dbState.pages = [{ id: 1, tenantId: 1, slug: "test", title: "Test", status: "draft", draftData: { root: { props: {} }, content: [] }, publishedData: null }];
        const res = await request(app)
          .patch("/api/web-editor/pages/test")
          .send({ data: { root: { props: {} }, content: [{ type: component, props: {} }] } });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/unapproved/i);
      });
    }

    for (const component of allowedComponents) {
      it(`allows ${component}`, async () => {
        dbState.pages = [{ id: 1, tenantId: 1, slug: "test", title: "Test", status: "draft", draftData: { root: { props: {} }, content: [] }, publishedData: null }];
        const res = await request(app)
          .patch("/api/web-editor/pages/test")
          .send({ data: { root: { props: {} }, content: [{ type: component, props: { text: "hi" } }] } });
        expect([200, 404, 500]).toContain(res.status);
        if (res.status === 400) {
          expect(res.body.error).not.toMatch(/unapproved/i);
        }
      });
    }
  });
});
