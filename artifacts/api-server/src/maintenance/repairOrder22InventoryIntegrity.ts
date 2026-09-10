import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { voidPrelaunchTestOrder, PRELAUNCH_TEST_VOID_REASON } from "../lib/prelaunchTestOrderRecovery";

const execute = process.argv.includes("--execute");
const confirmation = process.argv.find(arg => arg.startsWith("--confirm="))?.split("=", 2)[1];
const actorIdArg = process.argv.find(arg => arg.startsWith("--actor-id="))?.split("=", 2)[1];
const actorId = actorIdArg ? Number(actorIdArg) : null;

if (!execute || confirmation !== PRELAUNCH_TEST_VOID_REASON || !Number.isInteger(actorId) || actorId! <= 0) {
  throw new Error(`Refusing to run. Required: --execute --confirm=${PRELAUNCH_TEST_VOID_REASON} --actor-id=<admin-id>`);
}

const [actor] = await db.select().from(usersTable).where(eq(usersTable.id, actorId!)).limit(1);
if (!actor) throw new Error("Repair actor not found");

const result = await voidPrelaunchTestOrder({
  tenantId: actor.tenantId!,
  orderId: 22,
  idempotencyKey: "prelaunch-test-void-order22-gate1b",
  actor: { id: actor.id, email: actor.email, role: actor.role, ipAddress: "127.0.0.1" },
});
console.log(JSON.stringify({ reason: PRELAUNCH_TEST_VOID_REASON, result }, null, 2));
