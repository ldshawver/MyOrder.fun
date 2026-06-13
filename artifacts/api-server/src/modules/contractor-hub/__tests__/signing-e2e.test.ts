import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import contractorHubRouter from "../routes";
import documentHubRouter from "../../document-hub/routes";
import { testContracts, testSigners, testContractAuditLogs, testWebhookEvents, upsertContract } from "../services/store";
import { testDocumentAssets, testDocumentAuditLogs, testDocumentMetadata } from "../../document-hub/services/store";

const app = express();
app.use(express.json());
app.use("/api", contractorHubRouter);
app.use("/api", documentHubRouter);

describe("Contractor signing lifecycle E2E", () => {
  beforeEach(async () => {
    testContracts.clear();
    testSigners.clear(); testContractAuditLogs.length = 0; testWebhookEvents.clear();
    testDocumentAssets.clear();
    testDocumentMetadata.clear();
    testDocumentAuditLogs.length = 0;
    await upsertContract({ id: "proposal_contract_1", companyId: "co1", title: "Approved Proposal Contract", approvedProposalContractorUserId: "contractor_user", status: "generated" });
  });

  it("opens token link, completes signing, marks contract signed, archives PDF, and exposes download/print/audit", async () => {
    const email = await request(app).post("/api/contractor-hub/contracts/proposal_contract_1/send-signing-email").send({ email: "contractor@example.com", name: "Contractor" });
    expect(email.status).toBe(200);
    const token = new URL(email.body.signingUrl).pathname.split("/").pop();
    expect(token).toBeTruthy();

    const publicSigning = await request(app).get(`/api/signing/contracts/${token}`);
    expect(publicSigning.status).toBe(200);
    expect(publicSigning.body.canSign).toBe(true);

    const completed = await request(app).post(`/api/signing/contracts/${token}/complete`).send();
    expect(completed.status).toBe(200);
    expect(completed.body.signer.status).toBe("signed");
    expect(completed.body.asset.documentType).toBe("signed_contract");

    const contract = await request(app).get("/api/contractor-hub/contracts/proposal_contract_1");
    expect(contract.body.contract.status).toBe("fully_signed");

    const docs = await request(app).get("/api/document-hub/assets?q=signed_contract");
    expect(docs.body.assets).toHaveLength(1);
    const assetId = docs.body.assets[0].id;
    expect((await request(app).get(`/api/document-hub/assets/${assetId}/download`)).status).toBe(200);
    expect((await request(app).get(`/api/document-hub/assets/${assetId}/print`)).status).toBe(200);
    expect((await request(app).get(`/api/document-hub/assets/${assetId}/audit`)).body.auditLogs.length).toBeGreaterThan(0);
  });
});
