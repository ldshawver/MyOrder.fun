import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import onboardingRouter from "./onboarding";
import tenantsRouter from "./tenants";
import catalogRouter from "./catalog";
import ordersRouter from "./orders";
import auditRouter from "./audit";
import notificationsRouter from "./notifications";
import adminRouter from "./admin";
import aiRouter from "./ai";
import paymentsRouter from "./payments";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usersRouter);
router.use(onboardingRouter);
router.use(tenantsRouter);
router.use(catalogRouter);
router.use(ordersRouter);
router.use(auditRouter);
router.use(notificationsRouter);
router.use(adminRouter);
router.use(aiRouter);
router.use(paymentsRouter);

export default router;
