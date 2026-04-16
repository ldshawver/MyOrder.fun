import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const DEPLOY_SHA = process.env["DEPLOY_SHA"] ?? "unknown";

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({
    status: "ok",
    sha: DEPLOY_SHA,
    uptime: Math.floor(process.uptime()),
  });
  res.setHeader("X-Deploy-SHA", DEPLOY_SHA);
  res.json(data);
});

export default router;
