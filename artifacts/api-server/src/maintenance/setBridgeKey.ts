/**
 * Operator command: set a registered bridge's key from stdin, never printing it.
 *
 *   <key on stdin> | node dist/maintenance-set-bridge-key.mjs --execute \
 *       --tenant-id=1 --bridge-id=3 --actor-id=<admin user id>
 *
 * Typical use: pull the key straight from the bridge host over SSH and pipe it
 * into `docker exec -i deploy-api-1 node .../maintenance-set-bridge-key.mjs ...`.
 */
import { setBridgeKey } from "../lib/print/bridgeKey";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=", 2)[1];
const number = (name: string) => {
  const value = Number(arg(name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name}=<positive integer> is required`);
  return value;
};
if (!process.argv.includes("--execute")) {
  throw new Error("Refusing to run. Required: --execute --tenant-id=<id> --bridge-id=<id> --actor-id=<admin id>, key on stdin");
}
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const result = await setBridgeKey({
  tenantId: number("tenant-id"),
  bridgeId: number("bridge-id"),
  actorId: number("actor-id"),
  key: Buffer.concat(chunks).toString("utf8"),
});
console.log(JSON.stringify(result));
process.exit(0);
