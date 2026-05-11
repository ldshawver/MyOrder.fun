import { Router, type IRouter, type Request, type Response } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const DEPLOY_SHA = process.env["DEPLOY_SHA"] ?? "unknown";

const sendHealth = (_req: Request, res: Response) => {
  const data = HealthCheckResponse.parse({
    status: "ok",
    sha: DEPLOY_SHA,
    uptime: Math.floor(process.uptime()),
  });
  res.setHeader("X-Deploy-SHA", DEPLOY_SHA);
  res.json(data);
};

router.get("/health", sendHealth);
router.get("/healthz", sendHealth);

export default router;
