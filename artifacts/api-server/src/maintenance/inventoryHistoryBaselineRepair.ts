import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  applyInventoryHistoryBaselineRepair,
  INVENTORY_HISTORY_BASELINE_REPAIR,
  type InventoryHistoryCountEvidence,
  previewInventoryHistoryBaselineRepair,
} from "../lib/inventoryHistoryBaselineRepair";

const argument = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const tenantId = Number(argument("tenant-id"));
const productId = Number(argument("product-id"));
const inputPath = argument("input");
if (!Number.isInteger(tenantId) || tenantId <= 0 || !Number.isInteger(productId) || productId <= 0 || !inputPath) {
  throw new Error("Required: --tenant-id=<id> --product-id=<id> --input=<reviewed-evidence.json>");
}
const evidence = JSON.parse(await readFile(inputPath, "utf8")) as InventoryHistoryCountEvidence[];
const preview = await previewInventoryHistoryBaselineRepair(tenantId, productId, evidence);

if (!process.argv.includes("--execute")) {
  console.log(JSON.stringify({ mode: "preview", ...preview }, null, 2));
  process.exit(0);
}
const confirmation = argument("confirm"); const fingerprint = argument("fingerprint"); const reason = argument("reason"); const actorId = Number(argument("actor-id"));
if (confirmation !== INVENTORY_HISTORY_BASELINE_REPAIR || fingerprint !== preview.fingerprint || !reason || !Number.isInteger(actorId) || actorId <= 0) {
  throw new Error(`Refusing execution. Required: --execute --confirm=${INVENTORY_HISTORY_BASELINE_REPAIR} --fingerprint=<current-preview> --reason=<reviewed-reason> --actor-id=<admin-id>`);
}
if (preview.blockers.length) throw new Error(`Refusing execution: ${preview.blockers.join(" ")}`);
const actorResult = await db.execute(sql`SELECT id,role FROM users WHERE id=${actorId} AND tenant_id=${tenantId} AND is_active=true LIMIT 1`);
const actor = (Array.isArray(actorResult) ? actorResult : actorResult.rows ?? [])[0] as { id?: number; role?: string } | undefined;
if (!actor?.id || !actor.role) throw new Error("Active tenant repair actor was not found");
const idempotencyKey = argument("idempotency-key");
if (!idempotencyKey) throw new Error("Execution requires --idempotency-key=<uuid>");
const result = await applyInventoryHistoryBaselineRepair({ tenantId, productId, evidence, previewFingerprint: fingerprint,
  idempotencyKey, reason, actor: { id: Number(actor.id), role: actor.role } });
console.log(JSON.stringify({ mode: "executed", ...result }, null, 2));
