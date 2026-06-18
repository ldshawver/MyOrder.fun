import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, adminSettingsTable, customerDisclaimerAcceptancesTable } from "@workspace/db";
import { normalizeRole } from "./roles";

const STAFF_ROLES = new Set(["global_admin", "admin", "supervisor", "csr"]);

export type DisclaimerProtectedMutation =
  | "orders.create"
  | "payments.tokenize"
  | "payments.apply_credit"
  | "payments.confirm";

export function requireCurrentCustomerDisclaimerAcceptance(action: DisclaimerProtectedMutation) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const actor = req.dbUser;
    if (!actor) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const role = normalizeRole(actor.role);
    if (STAFF_ROLES.has(role)) {
      next();
      return;
    }

    if (role !== "user") {
      res.status(403).json({ error: "Forbidden: unsupported customer role" });
      return;
    }

    if (actor.tenantId == null) {
      res.status(403).json({ error: "Customer disclaimer requires a tenant assignment" });
      return;
    }

    const [settings] = await db
      .select()
      .from(adminSettingsTable)
      .where(eq(adminSettingsTable.tenantId, actor.tenantId))
      .limit(1);

    if (!settings) {
      res.status(428).json({
        error: "Current customer disclaimer must be accepted before this action",
        code: "DISCLAIMER_ACCEPTANCE_REQUIRED",
        action,
      });
      return;
    }

    const currentVersion = settings.customerDisclaimerVersion ?? 1;
    const [acceptance] = await db
      .select()
      .from(customerDisclaimerAcceptancesTable)
      .where(and(
        eq(customerDisclaimerAcceptancesTable.tenantId, actor.tenantId),
        eq(customerDisclaimerAcceptancesTable.userId, actor.id),
        eq(customerDisclaimerAcceptancesTable.disclaimerVersion, currentVersion),
      ))
      .limit(1);

    if (!acceptance) {
      res.status(428).json({
        error: "Current customer disclaimer must be accepted before this action",
        code: "DISCLAIMER_ACCEPTANCE_REQUIRED",
        action,
        version: currentVersion,
      });
      return;
    }

    next();
  };
}
