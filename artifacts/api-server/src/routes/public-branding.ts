import { Router, type IRouter } from "express";
import { getPublicBrandingForHost } from "../config/brandingConfig";
import { normalizeStorefrontHost } from "../config/publicStorefrontBranding";
import { installedAppBranding } from "../config/installedAppBranding";

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
  const app = installedAppBranding(branding);
  res.json({ ...branding, customer: { ...branding.customer, faviconUrl: app.faviconUrl }, installedApp: app });
});

router.get("/public/manifest.webmanifest", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Host");
  const host = normalizeStorefrontHost(req.headers.host);
  if (!host) { res.status(400).json({ error: "Invalid storefront host" }); return; }
  const branding = await getPublicBrandingForHost(host);
  if (!branding) { res.status(404).json({ error: "Storefront not configured" }); return; }
  const app = installedAppBranding(branding);
  res.type("application/manifest+json").json({
    id: "/", name: app.name, short_name: app.shortName,
    start_url: "/", scope: "/", display: "standalone",
    background_color: "#ffffff", theme_color: branding.customer.primaryColor,
    icons: [
      { src: app.iconUrl, sizes: app.iconSize, purpose: "any" },
      ...(app.iconSize === "1024x1024" ? [
        { src: "/branding/lucifer-cruz/lc-order-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/branding/lucifer-cruz/lc-order-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      ] : []),
    ],
  });
});

export default router;
