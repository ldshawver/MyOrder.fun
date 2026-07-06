const repair = process.argv.includes("--repair");
const authorityPath = "../../artifacts/api-server/src/lib/inventoryAuthority";
const authority = await import(authorityPath) as {
  collectInventoryReconcileReport: () => Promise<unknown>;
  reconcileInventoryState: () => Promise<unknown>;
};

const report = repair
  ? await authority.reconcileInventoryState()
  : await authority.collectInventoryReconcileReport();

console.log(JSON.stringify({ mode: repair ? "repair" : "read_only", report }, null, 2));

export {};
