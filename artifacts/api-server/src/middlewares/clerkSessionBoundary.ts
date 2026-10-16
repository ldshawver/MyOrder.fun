import type { RequestHandler } from "express";

const WOOCOMMERCE_WEBHOOK_PATH = "/api/webhooks/woocommerce";

/**
 * Provider webhooks authenticate their exact raw bytes with their own HMAC.
 * Keep this exception narrower than Express route matching: only the exact
 * POST endpoint may skip an interactive Clerk session.
 */
export function clerkSessionBoundary(clerk: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (req.method === "POST" && req.path === WOOCOMMERCE_WEBHOOK_PATH) {
      next();
      return;
    }
    clerk(req, res, next);
  };
}
