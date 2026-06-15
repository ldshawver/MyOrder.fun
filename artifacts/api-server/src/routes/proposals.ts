import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth, loadDbUser, requireDbUser, requireApproved } from "../lib/auth";

const router: IRouter = Router();
const authChain = [requireAuth, loadDbUser, requireDbUser, requireApproved] as const;

function sendRemovedProposalsResponse(_req: Request, res: Response): void {
  res.json({
    proposals: [],
    status: "removed",
    message: "Contractor proposals are not part of this POS deployment. Use Orders, Catalog, and Inventory for POS operations.",
  });
}

router.get("/proposals", ...authChain, sendRemovedProposalsResponse);
router.get("/contractor/proposals", ...authChain, sendRemovedProposalsResponse);
router.get("/admin/proposals", ...authChain, sendRemovedProposalsResponse);

export default router;
