import request from "supertest";
import { describe, expect, it, beforeEach } from "vitest";
import express from "express";
import contractorHubRouter from "../../contractor-hub/routes";
import documentHubRouter from "../routes";
const app = express();
app.use(express.json());
app.use("/api", contractorHubRouter);
app.use("/api", documentHubRouter);
import { testDocumentAssets, testDocumentAuditLogs, testDocumentMetadata } from "../services/store";

describe("Document Hub", () => {
  beforeEach(() => { testDocumentAssets.clear(); testDocumentMetadata.clear(); testDocumentAuditLogs.length = 0; });
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
    expect((await request(app).get(`/api/document-hub/assets/${id}/audit`)).body.auditLogs).toHaveLength(1);
  });

  it("archives finalized Contractor Hub contracts into Document Hub", async () => {
    const res = await request(app).post("/api/contractor-hub/contracts/c-final/archive-final").send({ signerEmail: "signed@example.com" });
    expect(res.status).toBe(201);
    expect(res.body.asset.sourceModule).toBe("contractor_hub");
    expect(res.body.asset.documentType).toBe("signed_contract");
  });
});
