/**
 * Clerk Frontend API Proxy Middleware
 *
 * Proxies Clerk Frontend API requests through your domain, enabling Clerk
 * authentication on custom domains and .replit.app deployments without
 * requiring CNAME DNS configuration.
 *
 * See: https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi
 *
 * IMPORTANT:
 * - Only active in production (Clerk proxying doesn't work for dev instances)
 * - Must be mounted BEFORE express.json() middleware
 *
 * Usage in app.ts:
 *   import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
 *   app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
 */

import { createProxyMiddleware } from "http-proxy-middleware";
import type { RequestHandler, Request, Response, NextFunction } from "express";
import https from "https";
import { URL } from "url";

const CLERK_FAPI = "https://frontend-api.clerk.dev";
export const CLERK_PROXY_PATH = "/api/__clerk";

/**
 * Manually handles the oauth_callback route to avoid nginx
 * "upstream sent too big header" errors.
 *
 * http-proxy-middleware forwards ALL Clerk response headers verbatim,
 * including large JWT Set-Cookie values that exceed nginx's proxy_buffer_size.
 * This handler uses a raw https.request, forwarding only the essential
 * headers (Location, Set-Cookie, Content-Type) back to the client.
 */
function oauthCallbackHandler(secretKey: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.url.startsWith("/v1/oauth_callback")) {
      return next();
    }

    const protocol = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host || "";
    const proxyUrl = `${protocol}://${host}${CLERK_PROXY_PATH}`;

    const xff = req.headers["x-forwarded-for"];
    const clientIp =
      (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "";

    const target = new URL(CLERK_FAPI);
    const options: https.RequestOptions = {
      hostname: target.hostname,
      port: 443,
      path: req.url,
      method: req.method,
      headers: {
        host: target.hostname,
        "clerk-proxy-url": proxyUrl,
        "clerk-secret-key": secretKey,
        ...(clientIp ? { "x-forwarded-for": clientIp } : {}),
      },
    };

    const proxyReq = https.request(options, (proxyRes) => {
      const status = proxyRes.statusCode ?? 502;

      const forwardHeaders: Record<string, string | string[]> = {};
      const setCookies = proxyRes.headers["set-cookie"];
      if (setCookies) forwardHeaders["set-cookie"] = setCookies;
      const location = proxyRes.headers["location"];
      if (location) forwardHeaders["location"] = location;
      const contentType = proxyRes.headers["content-type"];
      if (contentType) forwardHeaders["content-type"] = contentType;

      res.writeHead(status, forwardHeaders);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on("error", (err) => {
      console.error("[clerkProxy] oauth_callback upstream error:", err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: "Bad Gateway", detail: err.message });
      }
    });

    req.pipe(proxyReq, { end: true });
  };
}

export function clerkProxyMiddleware(): RequestHandler {
  if (process.env.NODE_ENV !== "production") {
    return (_req, _res, next) => next();
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return (_req, _res, next) => next();
  }

  const oauthHandler = oauthCallbackHandler(secretKey);

  const generalProxy = createProxyMiddleware({
    target: CLERK_FAPI,
    changeOrigin: true,
    pathRewrite: (path: string) =>
      path.replace(new RegExp(`^${CLERK_PROXY_PATH}`), ""),
    on: {
      proxyReq: (proxyReq, req) => {
        const protocol = req.headers["x-forwarded-proto"] || "https";
        const host = req.headers.host || "";
        const proxyUrl = `${protocol}://${host}${CLERK_PROXY_PATH}`;

        proxyReq.setHeader("Clerk-Proxy-Url", proxyUrl);
        proxyReq.setHeader("Clerk-Secret-Key", secretKey);

        const xff = req.headers["x-forwarded-for"];
        const clientIp =
          (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim() ||
          req.socket?.remoteAddress ||
          "";
        if (clientIp) {
          proxyReq.setHeader("X-Forwarded-For", clientIp);
        }
      },
    },
  }) as RequestHandler;

  return (req: Request, res: Response, next: NextFunction) => {
    oauthHandler(req, res, () => {
      generalProxy(req, res, next);
    });
  };
}
