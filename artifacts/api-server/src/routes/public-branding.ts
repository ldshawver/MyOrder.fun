import { Router, type IRouter } from "express";
import { getPublicBrandingForHost } from "../config/brandingConfig";
import { normalizeStorefrontHost } from "../config/publicStorefrontBranding";

const router: IRouter = Router();

/**
 * Public storefront presentation is selected only from the exact configured
 * storefront URL. X-Forwarded-Host is intentionally ignored: nginx provides
 * the sanitized Host header for proxied requests and an untrusted forwarding
 * header must never select a tenant.
 */
router.get("/public/branding", async (req, res): Promise<void> => {
  const host = normalizeStorefrontHost(req.headers.host);
  if (!host) {
    res.status(400).setHeader("Cache-Control", "no-store").json({ error: "Invalid storefront host" });
    return;
  }
  const branding = await getPublicBrandingForHost(host);
  if (!branding) {
    res.status(404).setHeader("Cache-Control", "no-store").json({ error: "Storefront not configured" });
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Host");
  res.json(branding);
});

export default router;
