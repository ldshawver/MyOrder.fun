import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => ({})),
}));

vi.mock("../../middlewares/clerkProxyMiddleware", () => ({
  CLERK_PROXY_PATH: "/api/__clerk",
  clerkProxyMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/printService", () => ({ startPrintWorker: () => {} }));
vi.mock("../../lib/auth", () => {
  const noop = (_req: unknown, _res: unknown, next: () => void) => next();
  return { requireAuth: noop, loadDbUser: noop, requireDbUser: noop, requireApproved: noop, requireRole: () => noop };
});
vi.mock("@workspace/db", () => ({ db: {}, usersTable: {}, tenantsTable: {} }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), and: vi.fn(), or: vi.fn(), ilike: vi.fn(), like: vi.fn(), asc: vi.fn(), desc: vi.fn(), gte: vi.fn(), sql: vi.fn() }));

import supertest from "supertest";
import app from "../../app";
import { buildForwardTwiML, getOutboundCallerId, redactPhone } from "../../lib/luxitPhone";

describe("LUXit emergency PWA and voice fallbacks", () => {
  beforeEach(() => {
    process.env.CALL_FORWARD_TO = "+15551234567";
    process.env.TWILIO_CALLER_ID = "+15557654321";
    process.env.PHONE_ALWAYS_FORWARD = "true";
  });

  it("/healthz passes", async () => {
    const res = await supertest(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("/login loads by redirecting to sign-in", async () => {
    const res = await supertest(app).get("/login");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/sign-in");
  });

  it("/app/inbox returns a health-safe shell, not a blank 500", async () => {
    const res = await supertest(app).get("/app/inbox");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("Conversations could not be loaded safely");
    expect(res.text).toContain("Retry");
  });

  it("voice inbound and forward return valid forwarding TwiML", async () => {
    for (const path of ["/twilio/voice/inbound", "/twilio/voice/forward"]) {
      const res = await supertest(app).post(path).type("form").send({ CallSid: "CA123", CallStatus: "ringing", From: "+15550001111" });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/xml/);
      expect(res.text).toContain("<Response><Dial callerId=\"+15557654321\">+15551234567</Dial></Response>");
    }
  });

  it("voice status callback acknowledges and logs status without TwiML", async () => {
    const res = await supertest(app)
      .post("/twilio/voice/status")
      .type("form")
      .send({ CallSid: "CA123", CallStatus: "completed", From: "+15550001111", To: "+15557654321" });

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
  });

  it("outbound caller helper uses the Twilio number and redacts phone numbers in logs", () => {
    expect(getOutboundCallerId()).toBe("+15557654321");
    expect(buildForwardTwiML({})).toContain("+15551234567");
    expect(redactPhone("+15551234567")).toBe("***4567");
  });
});
