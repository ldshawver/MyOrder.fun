import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, printBridgeProfilesTable, printPrintersTable } from "@workspace/db";
import { authenticatePrintBridgeDiscovery } from "../lib/printBridgeDiscoveryPolicy";

const router: IRouter = Router();
const queueName = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_. -]*$/, "Invalid local CUPS queue name");
const bodySchema = z.object({ printers: z.array(z.object({ queue: queueName, displayName: z.string().trim().min(1).max(128).optional(), receiptCapable: z.boolean().optional(), labelCapable: z.boolean().optional() }).strict()).min(1).max(64), bridgeVersion: z.string().trim().min(1).max(80).optional() }).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, printer] of value.printers.entries()) { if (seen.has(printer.queue)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["printers", index, "queue"], message: "Duplicate queue names are not allowed" }); seen.add(printer.queue); }
});

/** Discovery establishes only what exists. Assignment remains an admin action on the tenant-owned registry. */
router.post("/print-bridge/v1/discovery", async (req, res): Promise<void> => {
  if (process.env.NODE_ENV !== "staging" || req.get("X-MyOrder-Environment") !== "staging") { res.status(403).json({ error: "WRONG_ENVIRONMENT" }); return; }
  const bridgeId = req.get("X-MyOrder-Bridge-ID")?.trim() ?? "";
  const credential = (req.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bridgeId || !credential) { res.status(401).json({ error: "BRIDGE_AUTH_REQUIRED" }); return; }
  const bridges = await db.select().from(printBridgeProfilesTable).where(and(eq(printBridgeProfilesTable.bridgeId, bridgeId), eq(printBridgeProfilesTable.environment, "staging"), eq(printBridgeProfilesTable.isActive, true))).limit(2);
  const bridge = bridges[0];
  if (bridges.length !== 1 || !bridge) { res.status(401).json({ error: "BRIDGE_AUTH_REJECTED" }); return; }
  const auth = authenticatePrintBridgeDiscovery({ nodeEnvironment: process.env.NODE_ENV, requestedEnvironment: req.get("X-MyOrder-Environment"), bridgeEnvironment: bridge.environment, presentedCredential: credential, credentialHash: bridge.credentialHash });
  if (!auth.ok) { res.status(auth.error === "WRONG_ENVIRONMENT" ? 403 : 401).json({ error: auth.error }); return; }
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(422).json({ error: "INVALID_DISCOVERY_PAYLOAD" }); return; }
  const result = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${bridge.tenantId}, ${bridge.id})`);
    const existing = await tx.select().from(printPrintersTable).where(and(eq(printPrintersTable.tenantId, bridge.tenantId), eq(printPrintersTable.bridgeProfileId, bridge.id)));
    const byQueue = new Map(existing.filter(printer => printer.bridgePrinterName).map(printer => [printer.bridgePrinterName!, printer]));
    let created = 0; let reactivated = 0;
    for (const discovered of parsed.data.printers) {
      const printer = byQueue.get(discovered.queue);
      if (printer) {
        if (!printer.isActive) reactivated += 1;
        await tx.update(printPrintersTable).set({ name: discovered.displayName ?? discovered.queue, connectionType: "mac_bridge", bridgeUrl: bridge.bridgeUrl, isActive: true, receiptCapable: discovered.receiptCapable ?? printer.receiptCapable, labelCapable: discovered.labelCapable ?? printer.labelCapable }).where(and(eq(printPrintersTable.tenantId, bridge.tenantId), eq(printPrintersTable.id, printer.id)));
      } else {
        await tx.insert(printPrintersTable).values({ tenantId: bridge.tenantId, locationId: null, routingScope: "general", name: discovered.displayName ?? discovered.queue, role: "unassigned", connectionType: "mac_bridge", bridgeProfileId: bridge.id, bridgeUrl: bridge.bridgeUrl, bridgePrinterName: discovered.queue, apiKey: null, isActive: true, receiptCapable: discovered.receiptCapable ?? true, labelCapable: discovered.labelCapable ?? true });
        created += 1;
      }
    }
    const now = new Date();
    await tx.update(printBridgeProfilesTable).set({ lastHeartbeatAt: now, lastPrinterAvailability: "available", lastPrinterReason: null, lastPrinterCheckedAt: now, bridgeVersion: parsed.data.bridgeVersion ?? bridge.bridgeVersion }).where(and(eq(printBridgeProfilesTable.tenantId, bridge.tenantId), eq(printBridgeProfilesTable.id, bridge.id)));
    // The authenticated bridge has no human user identity. Its heartbeat and
    // discovered queue count are retained on the tenant-owned bridge profile;
    // do not fabricate an audit actor or persist its credential.
    return { count: parsed.data.printers.length, created, reactivated };
  });
  res.json({ ok: true, ...result });
});

export default router;
