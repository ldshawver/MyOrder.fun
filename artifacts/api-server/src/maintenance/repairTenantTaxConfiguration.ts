import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { repairTenantTaxConfiguration, TENANT_TAX_CONFIGURATION_REPAIR_REASON } from "../lib/tenantTaxConfigurationRepair";

const execute = process.argv.includes("--execute");
const confirmation = process.argv.find(arg => arg.startsWith("--confirm="))?.split("=", 2)[1];
const actorIdArg = process.argv.find(arg => arg.startsWith("--actor-id="))?.split("=", 2)[1];
const actorId = actorIdArg ? Number(actorIdArg) : null;

if (!execute || confirmation !== TENANT_TAX_CONFIGURATION_REPAIR_REASON || !Number.isInteger(actorId) || actorId <= 0) {
  throw new Error(`Refusing to run. Required: --execute --confirm=${TENANT_TAX_CONFIGURATION_REPAIR_REASON} --actor-id=<global-admin-or-supervisor-id>`);
}

const [actor] = await db.select().from(usersTable).where(eq(usersTable.id, actorId)).limit(1);
if (!actor) throw new Error("Repair actor not found");
const result = await repairTenantTaxConfiguration({ id: actor.id, email: actor.email, role: actor.role, ipAddress: "127.0.0.1" });
console.log(JSON.stringify({ reason: TENANT_TAX_CONFIGURATION_REPAIR_REASON, result }, null, 2));
