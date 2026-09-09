import { and, eq, isNull } from "drizzle-orm";
import { auditLogsTable, db, taxConfigurationsTable } from "@workspace/db";

export const TENANT_TAX_CONFIGURATION_REPAIR_REASON = "TENANT_TAX_CONFIGURATION_REPAIR" as const;
const TARGET_TENANT_ID = 1;
const ACCEPTED_CONFIG = {
  locationId: null,
  jurisdiction: "Sacramento, California",
  rate: "0.08750000",
  sourcingRule: "tenant",
  effectiveFrom: "2026-04-01",
  effectiveUntil: null,
  sourceName: "California Department of Tax and Fee Administration",
  sourceUrl: "https://www.cdtfa.ca.gov/taxes-and-fees/rates.aspx",
} as const;

type RepairActor = { id: number; email?: string | null; role: string; ipAddress?: string | null };

export class TenantTaxConfigurationRepairError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "TenantTaxConfigurationRepairError"; }
}

function assertActor(actor: RepairActor): void {
  if (!Number.isInteger(actor.id) || actor.id <= 0 || !["global_admin", "admin", "supervisor"].includes(actor.role)) {
    throw new TenantTaxConfigurationRepairError(403, "Global admin, admin, or supervisor permission is required");
  }
}

/**
 * Production-safe, narrowly scoped repair for the known missing tenant-wide
 * configuration. It is intentionally not a generic tax configuration writer.
 */
export async function repairTenantTaxConfiguration(actor: RepairActor) {
  assertActor(actor);
  return db.transaction(async tx => {
    const existing = await tx.select().from(taxConfigurationsTable).where(and(
      eq(taxConfigurationsTable.tenantId, TARGET_TENANT_ID),
      isNull(taxConfigurationsTable.locationId),
      eq(taxConfigurationsTable.sourcingRule, "tenant"),
      eq(taxConfigurationsTable.effectiveFrom, ACCEPTED_CONFIG.effectiveFrom),
    )).limit(2);

    if (existing.length > 1) throw new TenantTaxConfigurationRepairError(409, "Contradictory tenant-wide tax configurations already exist");
    if (existing.length === 1) {
      const current = existing[0];
      if (String(current.rate) !== ACCEPTED_CONFIG.rate || current.jurisdiction !== ACCEPTED_CONFIG.jurisdiction || current.sourceUrl !== ACCEPTED_CONFIG.sourceUrl) {
        throw new TenantTaxConfigurationRepairError(409, "Existing tenant-wide tax configuration conflicts with the accepted source-of-truth configuration");
      }
      return { id: current.id, idempotent: true };
    }

    const [created] = await tx.insert(taxConfigurationsTable).values({
      tenantId: TARGET_TENANT_ID,
      ...ACCEPTED_CONFIG,
      verifiedAt: new Date(),
      verifiedByUserId: actor.id,
    }).returning({ id: taxConfigurationsTable.id });
    if (!created) throw new TenantTaxConfigurationRepairError(500, "Tax configuration repair did not create a row");

    await tx.insert(auditLogsTable).values({
      tenantId: TARGET_TENANT_ID,
      actorId: actor.id,
      actorEmail: actor.email ?? "",
      actorRole: actor.role,
      action: TENANT_TAX_CONFIGURATION_REPAIR_REASON,
      resourceType: "tax_configuration",
      resourceId: String(created.id),
      metadata: { reason: TENANT_TAX_CONFIGURATION_REPAIR_REASON, config: ACCEPTED_CONFIG },
      ipAddress: actor.ipAddress ?? null,
    });
    return { id: created.id, idempotent: false };
  });
}
