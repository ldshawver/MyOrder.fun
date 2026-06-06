import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import healthRouter from "../health";

describe("health routes", () => {
  const app = express();
  app.use("/", healthRouter);
  app.use("/api", healthRouter);

  it("serves /health", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
    expect(res.body.sha).toBeDefined();
  });

  it("serves /healthz", async () => {
    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("serves /api/health", async () => {
    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("serves /api/healthz", async () => {
    const res = await request(app).get("/api/healthz");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
