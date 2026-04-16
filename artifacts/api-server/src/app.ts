import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import { clerkMiddleware } from "@clerk/express";
import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

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

// ── Security headers ────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
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

// ── Clerk auth middleware ────────────────────────────────────────────────────
app.use(clerkMiddleware());

// ── API routes ───────────────────────────────────────────────────────────────
app.use("/api", router);

// ── Print worker (background retry loop) ─────────────────────────────────────
import("./lib/printService").then(({ startPrintWorker }) => startPrintWorker()).catch(() => {});

// ── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export default app;
