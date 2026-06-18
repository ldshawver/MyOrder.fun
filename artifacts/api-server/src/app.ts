import express, { type Express, type ErrorRequestHandler, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import { clerkMiddleware } from "@clerk/express";
import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import healthRouter from "./routes/health";
import twilioVoiceRouter from "./routes/twilio-voice";
import { logger } from "./lib/logger";
import { submitOnboardingRequestHandler } from "./routes/onboarding";

const app: Express = express();
app.set("trust proxy", 1);

// ── Structured request logging ──────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// ── Clerk proxy (must come before body parsers — streams raw bytes) ──────────
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// ── Global rate limiting ────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

const mfaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "MFA attempts rate-limited. Try again in 1 minute." },
});

const onboardingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Onboarding request rate-limited." },
});

app.use("/api", globalLimiter);
app.use("/api/admin/mfa", mfaLimiter);
app.use("/api/onboarding/request", onboardingLimiter);

// ── Security headers + deploy SHA ───────────────────────────────────────────
const DEPLOY_SHA = process.env["DEPLOY_SHA"] ?? "unknown";

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-Deploy-SHA", DEPLOY_SHA);
  if (req.path.startsWith("/plasmic-host")) {
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self' https://studio.plasmic.app https://*.plasmic.app");
  } else {
    res.setHeader("X-Frame-Options", "DENY");
  }
  next();
});

// ── CORS ────────────────────────────────────────────────────────────────────
app.use(cors({ credentials: true, origin: true }));

// ── Raw body for Clerk webhooks (must precede the JSON parser) ───────────────
app.use("/api/webhooks/clerk", express.raw({ type: "application/json" }));

// ── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── JSON body-parse error → JSON 400 (must come right after body parsers) ────
app.use((err: unknown, req: Request, res: Response, next: NextFunction): void => {
  if (
    err &&
    typeof err === "object" &&
    "type" in err &&
    (err as { type?: string }).type === "entity.parse.failed"
  ) {
    res.status(400).json({
      error: "Invalid JSON body",
      detail: (err as { message?: string }).message,
      requestId: req.id,
    });
    return;
  }
  next(err);
});

// ── Public health checks (must remain unauthenticated for LB/proxy probes) ──
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});
app.use("/api", healthRouter);


// ── LUXit emergency PWA/voice public fallbacks ──────────────────────────────
function sendLuxitFallbackShell(res: Response): void {
  res
    .status(200)
    .setHeader("Content-Type", "text/html; charset=utf-8")
    .setHeader("Cache-Control", "no-store, max-age=0")
    .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LUXit Inbox</title>
  <style>body{margin:0;background:#0A0000;color:#C0C0C0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{max-width:560px;border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:28px;background:rgba(255,255,255,.04);box-shadow:0 20px 80px rgba(139,0,0,.25)}h1{font-size:18px;letter-spacing:.2em;text-transform:uppercase}p{color:#999;line-height:1.6}.btn{display:inline-block;margin-top:14px;padding:12px 16px;border-radius:12px;background:#8B0000;color:#fff;text-decoration:none;text-transform:uppercase;font-size:12px;letter-spacing:.16em}</style>
</head>
<body><main class="wrap"><section class="card"><h1>LUXit Inbox</h1><p>The inbox shell is online. Conversations could not be loaded safely, so no local messages were cleared. Please retry in a moment.</p><a class="btn" href="/app/inbox" onclick="location.reload();return false;">Retry</a></section></main><script>if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.update&&r.update())).catch(()=>{});}</script></body>
</html>`);
}

app.use(twilioVoiceRouter);
app.get("/login", (_req, res) => res.redirect(302, "/sign-in"));
app.get(["/app", "/app/", "/app/inbox"], (req, res) => {
  try {
    req.log?.info({ path: req.originalUrl }, "LUXit inbox fallback shell served");
    sendLuxitFallbackShell(res);
  } catch (err) {
    logger.error({ err, path: req.originalUrl }, "LUXit inbox fallback shell failed");
    if (!res.headersSent) sendLuxitFallbackShell(res);
  }
});

// Public access-request form. Mount this before Clerk so brand-new visitors
// can request access even when they have no session or a stale Clerk cookie.
app.post("/api/onboarding/request", submitOnboardingRequestHandler);

// ── Clerk auth middleware ────────────────────────────────────────────────────
// Key priority: docker-compose passes CLERK_PUBLISHABLE_KEY to the API container.
// Replit dev uses PUBLIC_KEY / NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY secrets.
// proxyUrl must match the frontend's VITE_CLERK_PROXY_URL so the SDK correctly
// validates JWTs issued through the proxy (required for custom domain / proxy setup).
const _clerkPubKey =
  process.env.CLERK_PUBLISHABLE_KEY ||
  process.env.VITE_CLERK_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
  process.env.PUBLIC_KEY;
const _clerkProxyUrl =
  process.env.CLERK_PROXY_URL ||
  process.env.VITE_CLERK_PROXY_URL;
app.use(clerkMiddleware({
  publishableKey: _clerkPubKey,
  ...(process.env.NODE_ENV === "production" && _clerkProxyUrl
    ? { proxyUrl: _clerkProxyUrl }
    : {}),
}));

// ── Test-only routes (exercise the real middleware chain in vitest) ─────────
// These are mounted ONLY when NODE_ENV === "test" so they cannot be hit in
// production. They sit before the auth-gated routers so tests can verify the
// global JSON error contract end-to-end.
if (process.env["NODE_ENV"] === "test") {
  app.get("/api/__contract/sync-throw", () => {
    throw new Error("sync boom");
  });
  app.get("/api/__contract/async-throw", async () => {
    await Promise.resolve();
    throw new Error("async boom");
  });
  app.get("/api/__contract/custom-status", () => {
    const e = new Error("teapot") as Error & { status: number };
    e.status = 418;
    throw e;
  });
  // Mount a known prefix that has NO sub-routes so unknown paths under it
  // fall straight through to the /api JSON 404 handler (bypassing every
  // auth-gated subrouter).
  app.use("/api/__contract/known-prefix", express.Router());
}

// ── API routes ───────────────────────────────────────────────────────────────
app.use("/api", router);

// ── Print worker (background retry loop) ─────────────────────────────────────
import("./lib/printService").then(({ startPrintWorker }) => startPrintWorker()).catch(() => {});

// ── /api/* JSON 404 (always JSON, even if a static fallback is added later) ──
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

// ── Generic 404 (non-/api paths) ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

// ── Global JSON error handler (4-arg signature; catches sync + async throws) ─
const jsonErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const status =
    typeof (err as { status?: number; statusCode?: number }).status === "number"
      ? (err as { status: number }).status
      : typeof (err as { statusCode?: number }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;

  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Internal Server Error";

  // Log with the request-scoped logger so we keep request id correlation.
  if (req.log) {
    req.log.error({ err, status }, "request failed");
  } else {
    logger.error({ err, status }, "request failed");
  }

  if (res.headersSent) {
    // Express will close the connection; nothing more we can do safely.
    return;
  }

  const body: Record<string, unknown> = {
    error: message,
    requestId: req.id,
  };
  if (process.env["NODE_ENV"] !== "production" && err instanceof Error && err.stack) {
    body["stack"] = err.stack;
  }

  res.status(status).json(body);
};
app.use(jsonErrorHandler);

export default app;
