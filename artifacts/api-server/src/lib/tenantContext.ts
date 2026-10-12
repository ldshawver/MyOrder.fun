import type { Request, Response, NextFunction } from "express";
import { normalizeRole } from "./roles";

declare global {
  // Express exposes its request extension point through this namespace.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { authorizedTenantId?: number }
  }
}

/** Resolve tenant authority before any tenant-owned object lookup. */
export function requireTenantContext(req: Request, res: Response, next: NextFunction): void {
  const actor = req.dbUser;
  if (!actor) { res.status(401).json({ error: "Authentication required" }); return; }
  const queryValue = req.query.tenantId;
  const bodyValue = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>).tenantId : undefined;
  const supplied = queryValue ?? bodyValue;
  const selected = supplied === undefined ? undefined : Number(supplied);
  if (supplied !== undefined && (!Number.isSafeInteger(selected) || selected! <= 0 || Array.isArray(supplied))) {
    res.status(400).json({ error: "Invalid tenantId" }); return;
  }
  if (queryValue !== undefined && bodyValue !== undefined && Number(queryValue) !== Number(bodyValue)) {
    res.status(400).json({ error: "Conflicting tenantId" }); return;
  }
  if (normalizeRole(actor.role) === "global_admin") {
    if (selected === undefined && actor.tenantId == null) { res.status(403).json({ error: "Explicit tenantId is required" }); return; }
    req.authorizedTenantId = selected ?? actor.tenantId!;
  } else {
    if (actor.tenantId == null) { res.status(403).json({ error: "Tenant assignment required" }); return; }
    if (selected !== undefined && selected !== actor.tenantId) {
      res.status(403).json({ error: "Tenant assignment does not match" }); return;
    }
    req.authorizedTenantId = actor.tenantId;
  }
  next();
}
