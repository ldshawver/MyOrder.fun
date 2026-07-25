import express from "express";
import supertest from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const proxyHandler = vi.hoisted(() =>
  vi.fn((_req, res) => {
    res.status(204).end();
  }),
);

vi.mock("http-proxy-middleware", () => ({
  createProxyMiddleware: vi.fn(() => proxyHandler),
}));

import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
} from "../clerkProxyMiddleware";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  CLERK_PROXY_URL: process.env.CLERK_PROXY_URL,
  VITE_CLERK_PROXY_URL: process.env.VITE_CLERK_PROXY_URL,
};

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function createApp() {
  const app = express();
  app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
  app.use(CLERK_PROXY_PATH, (_req, res) => {
    res.status(418).json({ proxied: false });
  });
  return app;
}

afterEach(() => {
  restoreEnv("NODE_ENV");
  restoreEnv("CLERK_SECRET_KEY");
  restoreEnv("CLERK_PROXY_URL");
  restoreEnv("VITE_CLERK_PROXY_URL");
  proxyHandler.mockClear();
});

describe("clerkProxyMiddleware", () => {
  it("proxies Clerk bootstrap requests in development when proxy configuration is explicit", async () => {
    process.env.NODE_ENV = "development";
    process.env.CLERK_SECRET_KEY = "test-secret";
    process.env.CLERK_PROXY_URL = "https://dev.example.test/api/__clerk";

    const response = await supertest(createApp()).get(
      `${CLERK_PROXY_PATH}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`,
    );

    expect(response.status).toBe(204);
    expect(proxyHandler).toHaveBeenCalledOnce();
  });

  it("proxies in development when the secret key itself is explicitly configured", async () => {
    process.env.NODE_ENV = "development";
    process.env.CLERK_SECRET_KEY = "test-secret";
    delete process.env.CLERK_PROXY_URL;
    delete process.env.VITE_CLERK_PROXY_URL;

    const response = await supertest(createApp()).get(
      `${CLERK_PROXY_PATH}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`,
    );

    expect(response.status).toBe(204);
    expect(proxyHandler).toHaveBeenCalledOnce();
  });

  it("falls through in development when no proxy configuration is present", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_PROXY_URL;
    delete process.env.VITE_CLERK_PROXY_URL;

    const response = await supertest(createApp()).get(
      `${CLERK_PROXY_PATH}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`,
    );

    expect(response.status).toBe(418);
    expect(proxyHandler).not.toHaveBeenCalled();
  });

  it("does not proxy without the secret required by the Clerk upstream", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.CLERK_SECRET_KEY;
    process.env.CLERK_PROXY_URL = "https://dev.example.test/api/__clerk";

    const response = await supertest(createApp()).get(
      `${CLERK_PROXY_PATH}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`,
    );

    expect(response.status).toBe(418);
    expect(proxyHandler).not.toHaveBeenCalled();
  });
});
