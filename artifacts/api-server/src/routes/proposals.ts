import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth, loadDbUser, requireDbUser, requireApproved } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

function sendRemovedProposalsResponse(_req: Request, res: Response): void {
  res.json({
    proposals: [],
    status: "removed",
    message: "Contractor proposals are not part of this POS deployment. Use Orders, Catalog, and Inventory for POS operations.",
  });
}

router.get("/proposals", sendRemovedProposalsResponse);
router.get("/contractor/proposals", sendRemovedProposalsResponse);
router.get("/admin/proposals", sendRemovedProposalsResponse);

export default router;
