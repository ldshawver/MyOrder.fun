import express from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPublicBrandingForHost: vi.fn() }));
vi.mock("../../config/brandingConfig", () => ({ getPublicBrandingForHost: mocks.getPublicBrandingForHost }));

import publicBrandingRouter from "../public-branding";

const app = express();
app.use(publicBrandingRouter);

describe("GET /public/branding", () => {
  beforeEach(() => {
    mocks.getPublicBrandingForHost.mockReset();
    mocks.getPublicBrandingForHost.mockResolvedValue({ customer: { displayName: "Lucifer Cruz", logoUrl: "/lc-logo.webp" } });
  });

  it("uses the exact Host header, not a forwarded host, query, or body selector", async () => {
    const response = await supertest(app).get("/public/branding?tenantId=999")
      .set("Host", "shop.lucifercruz.com")
      .set("X-Forwarded-Host", "store.example.test")
      .send({ tenantId: 999, businessId: 999 });
    expect(response.status).toBe(200);
    expect(response.body.customer.displayName).toBe("Lucifer Cruz");
    expect(mocks.getPublicBrandingForHost).toHaveBeenCalledWith("shop.lucifercruz.com");
  });

  it("fails closed for malformed and unknown hosts", async () => {
    const malformed = await supertest(app).get("/public/branding").set("Host", "shop.lucifercruz.com/path");
    expect(malformed.status).toBe(400);
    mocks.getPublicBrandingForHost.mockResolvedValueOnce(null);
    const unknown = await supertest(app).get("/public/branding").set("Host", "unknown.example.test");
    expect(unknown.status).toBe(404);
  });
});
