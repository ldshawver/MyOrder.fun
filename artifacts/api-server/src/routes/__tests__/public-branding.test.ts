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

  it("serves the Lucifer Cruz install name and exact icon without forwarded tenant selection", async () => {
    const response = await supertest(app).get("/public/manifest.webmanifest?tenantId=999")
      .set("Host", "myorder.fun").set("X-Forwarded-Host", "other.test");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/manifest+json");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body).toMatchObject({ name: "Lucifer Cruz Order", short_name: "LC Order", start_url: "/", scope: "/" });
    expect(response.body.icons[0].src).toContain("LC-Order_Icon-iOS-Default-1024@1x.png");
    expect(response.body.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(["1024x1024", "192x192", "512x512"]);
    expect(mocks.getPublicBrandingForHost).toHaveBeenCalledWith("myorder.fun");
  });

  it("keeps another tenant's install identity and fails closed for unknown hosts", async () => {
    mocks.getPublicBrandingForHost.mockResolvedValueOnce({ customer: { displayName: "Other Shop", logoUrl: "/other.png" } });
    const other = await supertest(app).get("/public/manifest.webmanifest").set("Host", "other.test");
    expect(other.body.name).toBe("Other Shop");
    expect(other.body.icons[0].src).toBe("/other.png");
    mocks.getPublicBrandingForHost.mockResolvedValueOnce(null);
    expect((await supertest(app).get("/public/manifest.webmanifest").set("Host", "unknown.test")).status).toBe(404);
    expect((await supertest(app).get("/public/manifest.webmanifest").set("Host", "bad.test/path")).status).toBe(400);
  });
});
