import request from "supertest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import express from "express";

vi.mock("../../../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  loadDbUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.dbUser = { id: 1, role: "admin", status: "approved", isActive: true, tenantId: "co1" } as unknown as NonNullable<typeof req.dbUser>;
    next();
  },
  requireDbUser: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireApproved: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireRole: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  normalizeRole: (role: unknown) => {
    const normalized = typeof role === "string" ? role.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
    if (normalized === "global_admin") return "global_admin";
    if (normalized === "admin" || normalized === "tenant_admin" || normalized === "supervisor") return "admin";
    if (normalized === "customer_service_rep" || normalized === "csr") return "customer_service_rep";
    return "user";
  },
}));

import contractorHubRouter from "../routes";
import documentHubRouter from "../../document-hub/routes";
const app = express();
app.use(express.json());
app.use("/api", contractorHubRouter);
app.use("/api", documentHubRouter);
import { canSignContract } from "../permissions/canSignContract";
import { addSigner, testContracts, testSigners, testContractAuditLogs, testWebhookEvents, upsertContract } from "../services/store";
import { getDocumensoConfig, validateDocumensoConfig } from "../documenso/config";

describe("Contractor Hub signing", () => {
  beforeEach(async () => { testContracts.clear(); testSigners.clear(); testContractAuditLogs.length = 0; testWebhookEvents.clear(); await upsertContract({ id: "c1", companyId: "co1", approvedProposalContractorUserId: "contractor_user" }); });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.MYPAYLINK_DOCUMENSO_ENABLED; delete process.env.MYPAYLINK_DOCUMENSO_API_KEY; delete process.env.MyPayLink_DOCUMENSO_API_KEY; });

  it("generates signing email with public route that API can resolve", async () => {
    const res = await request(app).post("/api/contractor-hub/contracts/c1/send-signing-email").send({ email: "signer@example.com", name: "Signer" });
    expect(res.status).toBe(200);
    expect(res.body.email.html).toContain("View in PayLink");
    const url = new URL(res.body.signingUrl);
    expect(url.pathname).toMatch(/^\/sign\/contracts\//);
    const apiRes = await request(app).get(`/api/signing/contracts/${url.pathname.split('/').pop()}`);
    expect(apiRes.status).toBe(200);
    expect(apiRes.body.canSign).toBe(true);
  });

  it("authorizes admins, approved contractors, delegated signers, replacements, Documenso recipients, and valid tokens without company access", async () => {
    const delegated = await addSigner({ contractId: "c1", email: "delegate@example.com", signerType: "delegated", isDelegated: true, userId: "delegate_user" });
    const replacement = await addSigner({ contractId: "c1", email: "replace@example.com", signerType: "replacement", isDelegated: true, replacesSignerId: delegated.signer.id });
    const documenso = await addSigner({ contractId: "c1", email: "doc@example.com", documensoRecipientId: "recipient_1", signerType: "documenso" });
    expect(await canSignContract({ contractId: "c1", role: "admin", companyId: "co1" })).toBe(true);
    expect(await canSignContract({ contractId: "c1", userId: "contractor_user" })).toBe(true);
    expect(await canSignContract({ contractId: "c1", userId: "delegate_user" })).toBe(true);
    expect(await canSignContract({ contractId: "c1", email: "replace@example.com" })).toBe(true);
    expect(await canSignContract({ contractId: "c1", documensoRecipientId: "recipient_1" })).toBe(true);
    expect(await canSignContract({ contractId: "c1", signingToken: replacement.token })).toBe(true);
    expect(await canSignContract({ contractId: "c1", signingToken: documenso.token, companyId: "wrong" })).toBe(true);
    expect(await canSignContract({ contractId: "c1", userId: "invalid" })).toBe(false);
  });

  it("rejects expired signing tokens", async () => {
    const expired = await addSigner({ contractId: "c1", email: "old@example.com", signingTokenExpiresAt: new Date(Date.now() - 1000) });
    expect(await canSignContract({ contractId: "c1", signingToken: expired.token })).toBe(false);
  });

  it("normalizes Documenso env and reports missing config clearly", () => {
    process.env.MYPAYLINK_DOCUMENSO_ENABLED = "true";
    expect(validateDocumensoConfig().ok).toBe(false);
    process.env.MyPayLink_DOCUMENSO_API_KEY = "legacy";
    expect(getDocumensoConfig().apiKey).toBe("legacy");
    expect(validateDocumensoConfig().ok).toBe(true);
  });

  it("creates and syncs a Documenso document when configured", async () => {
    process.env.MYPAYLINK_DOCUMENSO_ENABLED = "true";
    process.env.MYPAYLINK_DOCUMENSO_API_KEY = "test_key";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/recipients")) return Response.json({ recipients: [] });
      if (url.endsWith("/send")) return Response.json({ id: "doc_test", status: "sent" });
      if (url.includes("/documents/doc_test")) return Response.json({ id: "doc_test", status: "completed" });
      return Response.json({ id: "doc_test", status: "created" });
    }));
    const create = await request(app).post("/api/contractor-hub/contracts/c1/documenso/create").send();
    expect(create.status).toBe(201);
    const sync = await request(app).post("/api/contractor-hub/contracts/c1/documenso/sync").send({ status: "completed" });
    expect(sync.body.status).toBe("completed");
  });

  it("handles duplicate Documenso webhook events idempotently", async () => {
    const signer = await addSigner({ contractId: "c1", email: "doc@example.com", documensoRecipientId: "recipient_1", signerType: "documenso" });
    const payload = { eventId: "evt_1", contractId: "c1", recipientId: "recipient_1", status: "completed" };
    const first = await request(app).post("/api/contractor-hub/documenso/webhook").send(payload);
    const second = await request(app).post("/api/contractor-hub/documenso/webhook").send(payload);
    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    const contract = await request(app).get("/api/contractor-hub/contracts/c1");
    expect(contract.body.signers.find((s: { id: string; status: string }) => s.id === signer.signer.id)?.status).toBe("signed");
  });

});
