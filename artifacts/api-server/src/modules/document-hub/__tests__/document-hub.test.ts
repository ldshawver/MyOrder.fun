import request from "supertest";
import { describe, expect, it, beforeEach, vi } from "vitest";
import express from "express";

const authState = vi.hoisted(() => ({
  actor: { id: 1, role: "admin", status: "approved", isActive: true, tenantId: "co1" as string | null, email: "admin@example.com" },
  authenticated: true,
}));

vi.mock("../../../lib/auth", () => ({
  requireAuth: (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!authState.authenticated) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  },
  loadDbUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.dbUser = authState.actor as unknown as NonNullable<typeof req.dbUser>;
    next();
  },
  requireDbUser: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireApproved: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  normalizeRole: (role: unknown) => {
    const normalized = typeof role === "string" ? role.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
    if (normalized === "global_admin") return "global_admin";
    if (normalized === "admin" || normalized === "tenant_admin" || normalized === "supervisor") return "admin";
    if (normalized === "customer_service_rep" || normalized === "csr") return "customer_service_rep";
    return "user";
  },
}));

import contractorHubRouter from "../../contractor-hub/routes";
import documentHubRouter from "../routes";
const app = express();
app.use(express.json());
app.use("/api", contractorHubRouter);
app.use("/api", documentHubRouter);
import { testDocumentAssets, testDocumentAuditLogs, testDocumentMetadata, testDocumentPermissions } from "../services/store";

describe("Document Hub", () => {
  beforeEach(() => {
    authState.authenticated = true;
    authState.actor = { id: 1, role: "admin", status: "approved", isActive: true, tenantId: "co1", email: "admin@example.com" };
    testDocumentAssets.clear();
    testDocumentMetadata.clear();
    testDocumentPermissions.length = 0;
    testDocumentAuditLogs.length = 0;
  });
  it("uploads, views, downloads, prints, edits metadata, versions, archives, and audits a document", async () => {
    const created = await request(app).post("/api/document-hub/assets").send({ companyId: "co1", title: "W-9", fileName: "w9.pdf", documentType: "W-9" });
    expect(created.status).toBe(201);
    const id = created.body.asset.id;
    expect((await request(app).get(`/api/document-hub/assets/${id}`)).status).toBe(200);
    expect((await request(app).get(`/api/document-hub/assets/${id}/download`)).body.downloadUrl).toContain(id);
    expect((await request(app).get(`/api/document-hub/assets/${id}/print`)).body.printUrl).toContain(id);
    expect((await request(app).patch(`/api/document-hub/assets/${id}/metadata`).send({ category: "tax_forms" })).body.metadata.category).toBe("tax_forms");
    expect((await request(app).post(`/api/document-hub/assets/${id}/versions`).send({ changeSummary: "new final" })).body.version.versionNumber).toBe(2);
    expect((await request(app).post(`/api/document-hub/assets/${id}/archive`).send()).body.asset.isArchived).toBe(true);
    expect((await request(app).get(`/api/document-hub/assets/${id}/audit`)).body.auditLogs.length).toBeGreaterThan(0);
  });

  it("archives finalized Contractor Hub contracts into Document Hub", async () => {
    const res = await request(app).post("/api/contractor-hub/contracts/c-final/archive-final").send({ signerEmail: "signed@example.com" });
    expect(res.status).toBe(201);
    expect(res.body.asset.sourceModule).toBe("contractor_hub");
    expect(res.body.asset.documentType).toBe("signed_contract");
  });

  it("denies unauthenticated, normal user, CSR, and unpermitted supervisor access", async () => {
    const created = await request(app).post("/api/document-hub/assets").send({ companyId: "co1", title: "Payroll", fileName: "payroll.pdf", documentType: "payroll" });
    const id = created.body.asset.id;

    authState.authenticated = false;
    expect((await request(app).get("/api/document-hub/assets")).status).toBe(401);

    authState.authenticated = true;
    authState.actor = { id: 2, role: "user", status: "approved", isActive: true, tenantId: "co1", email: "user@example.com" };
    expect((await request(app).get(`/api/document-hub/assets/${id}`)).status).toBe(403);

    authState.actor = { id: 3, role: "csr", status: "approved", isActive: true, tenantId: "co1", email: "csr@example.com" };
    expect((await request(app).get(`/api/document-hub/assets/${id}`)).status).toBe(403);

    authState.actor = { id: 4, role: "supervisor", status: "approved", isActive: true, tenantId: "co1", email: "supervisor@example.com" };
    expect((await request(app).get(`/api/document-hub/assets/${id}`)).status).toBe(403);
  });

  it("allows supervisors only on explicitly permitted operational routes and denies management routes", async () => {
    const created = await request(app).post("/api/document-hub/assets").send({ companyId: "co1", title: "Shift SOP", fileName: "sop.pdf", documentType: "operations" });
    const id = created.body.asset.id;
    testDocumentPermissions.push({
      id: "perm_1",
      documentAssetId: id,
      companyId: "co1",
      userId: null,
      role: "supervisor",
      permissionView: true,
      permissionDownload: true,
      permissionPrint: true,
      permissionEditMetadata: false,
      permissionDelete: false,
      permissionShare: false,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    authState.actor = { id: 4, role: "supervisor", status: "approved", isActive: true, tenantId: "co1", email: "supervisor@example.com" };
    expect((await request(app).get(`/api/document-hub/assets/${id}`)).status).toBe(200);
    expect((await request(app).get(`/api/document-hub/assets/${id}/download`)).status).toBe(200);
    expect((await request(app).get(`/api/document-hub/assets/${id}/print`)).status).toBe(200);
    expect((await request(app).post(`/api/document-hub/assets/${id}/versions`).send({ changeSummary: "new" })).status).toBe(403);
    expect((await request(app).post(`/api/document-hub/assets/${id}/archive`).send()).status).toBe(403);
    expect((await request(app).get(`/api/document-hub/assets/${id}/audit`)).status).toBe(403);
    expect((await request(app).post("/api/document-hub/assets").send({ companyId: "co1", title: "Nope", fileName: "nope.pdf", documentType: "operations" })).status).toBe(403);
  });

  it("tenant admins cannot access other-tenant documents while global admins can", async () => {
    authState.actor = { id: 9, role: "global_admin", status: "approved", isActive: true, tenantId: null, email: "global@example.com" };
    const otherTenant = await request(app).post("/api/document-hub/assets").send({ companyId: "co2", title: "Other Tenant", fileName: "other.pdf", documentType: "business" });
    const id = otherTenant.body.asset.id;

    authState.actor = { id: 1, role: "tenant_admin", status: "approved", isActive: true, tenantId: "co1", email: "tenant@example.com" };
    expect((await request(app).get(`/api/document-hub/assets/${id}`)).status).toBe(403);
    expect((await request(app).get("/api/document-hub/assets")).body.assets).toHaveLength(0);

    authState.actor = { id: 9, role: "global_admin", status: "approved", isActive: true, tenantId: null, email: "global@example.com" };
    expect((await request(app).get(`/api/document-hub/assets/${id}`)).status).toBe(200);
  });

  it("audits archive, version, download, and print actions without storing raw document contents", async () => {
    const created = await request(app).post("/api/document-hub/assets").send({ companyId: "co1", title: "Policy", fileName: "policy.pdf", documentType: "business" });
    const id = created.body.asset.id;
    await request(app).get(`/api/document-hub/assets/${id}/download`);
    await request(app).get(`/api/document-hub/assets/${id}/print`);
    await request(app).post(`/api/document-hub/assets/${id}/versions`).send({ changeSummary: "updated policy" });
    await request(app).post(`/api/document-hub/assets/${id}/archive`).send();

    const actions = testDocumentAuditLogs.map((log) => log.action);
    expect(actions).toEqual(expect.arrayContaining(["downloaded", "printed", "version_created", "archived"]));
    const sensitiveAuditPayloads = testDocumentAuditLogs
      .filter((log) => ["downloaded", "printed", "version_created", "archived"].includes(log.action))
      .map((log) => JSON.stringify(log.afterJson ?? {}));
    expect(sensitiveAuditPayloads.every((payload) => !payload.includes("raw") && !payload.includes("base64") && !payload.includes("storageKey"))).toBe(true);
  });
});
