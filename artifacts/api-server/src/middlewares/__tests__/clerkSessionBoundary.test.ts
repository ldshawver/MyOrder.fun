import express, { type NextFunction, type Request, type Response } from "express";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";
import { clerkSessionBoundary } from "../clerkSessionBoundary";

function buildApp() {
  const app = express();
  const clerk = vi.fn((_req: Request, res: Response, _next: NextFunction) => {
    res.status(401).json({ error: "Unauthorized" });
  });
  app.use(clerkSessionBoundary(clerk));
  app.post("/api/webhooks/woocommerce", (_req, res) => res.status(202).json({ acceptedByProviderChain: true }));
  return { app, clerk };
}

describe("Clerk session boundary for WooCommerce", () => {
  it("skips Clerk only for the exact provider POST path", async () => {
    const { app, clerk } = buildApp();
    const response = await supertest(app).post("/api/webhooks/woocommerce?delivery=1");
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ acceptedByProviderChain: true });
    expect(clerk).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/webhooks/woocommerce"],
    ["PUT", "/api/webhooks/woocommerce"],
    ["POST", "/api/webhooks/woocommerce/"],
    ["POST", "/api/webhooks/woocommerce/anything"],
    ["POST", "/api/webhooks%2Fwoocommerce"],
    ["POST", "/api/webhooks/paypal"],
    ["GET", "/api/admin/stats"],
    ["GET", "/api/orders"],
    ["GET", "/api/users/me"],
  ])("keeps Clerk for %s %s", async (method, path) => {
    const { app, clerk } = buildApp();
    const client = supertest(app);
    const response = method === "GET" ? await client.get(path)
      : method === "PUT" ? await client.put(path)
        : await client.post(path);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthorized" });
    expect(clerk).toHaveBeenCalledOnce();
  });
});
