import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const STAGING_FEATURE = Object.freeze({
  sha: "46fc27944bf7069c8e833a9688280849363a8cc6",
  tree: "c4b0cab124a8fab09a2087bfdda83c44ea37055f",
  project: "myorder-staging",
  database: "myorder_staging",
  sourceContainer: "myorder-staging-db-1",
  rollbackRevision: "40fccbc3d9464ddfa5574f2cb57b71d0fe3ab833",
  expectedLedgerBefore: 49,
  migrationTimestamp: "1792440000000",
  previousMigrationTimestamps: Object.freeze({ "0075_catalogue_variant_attributes": "1790985600002", "0076_tenant_woo_store_url_no_default": "1791358517378" }),
  migrationTag: "0077_catalogue_inventory_reconciliation",
  migrationHash: "29b98289bd97b1c4781495a93d3d034f03a0daa503a96adfda035d2a3aeecd6b",
  previousMigrationHashes: Object.freeze({
    "0075_catalogue_variant_attributes": "b6491e32ca4e8ae65dfbaab5e33398465fdd747a23765726253852b8f2fc509a",
    "0076_tenant_woo_store_url_no_default": "99b25cd808d54c1f5d6d957701b64561bd948a3cb4c06aab0000b047ede66e73",
  }),
  backupRoot: "/home/serveradmin/release-backups",
  restoreImageId: "sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229",
  databaseImageId: "sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229",
  nginxImageId: "sha256:8b1e78743a03dbb2c95171cc58639fef29abc8816598e27fb910ed2e621e589a",
  expectedDaemonId: "90b592a4-aee8-4d61-99a2-1a6a8b58ed55",
  arch: "amd64",
  rollback: Object.freeze({
    api: "sha256:acafc8bdb7899d2c85b47cc234ac58ad99e854034571ba6634aa51983c6b229b",
    platform: "sha256:fbd2185bca1e471462a41fac0c50595643c84a6e506076311655c792b2a2ca13",
    migrate: "sha256:878d21dec057bfccbf294465e77627f20e04df6d82bba70f549473aa84454461",
  }),
});

const DIGEST_REF = /^myorder-(api|platform|migrate)@sha256:([a-f0-9]{64})$/;
const SOURCE_TOOLING_PATHS = new Set([
  "deploy/STAGING-0077-RELEASE.md",
  "deploy/staging-feature-release-guards.mjs",
  "deploy/staging-feature-release.mjs",
  "deploy/staging-feature-release.test.mjs",
  "scripts/release/staging-0077-backup-restore-rehearsal.sh",
]);

export function validateStagingFeatureTarget({ environment, project, database, databaseHost, composeFile, deploySha, deployTree }) {
  if (environment !== "staging") throw new Error("Feature release path is staging-only");
  if (project !== STAGING_FEATURE.project || database !== STAGING_FEATURE.database || databaseHost !== "db") throw new Error("Staging target identity does not match the pinned project/database");
  if (path.basename(composeFile ?? "") !== "docker-compose.staging.yml") throw new Error("Feature release requires the staging Compose file");
  if (deploySha !== STAGING_FEATURE.sha || deployTree !== STAGING_FEATURE.tree) throw new Error("Feature source commit/tree does not match merged PR #163");
  return true;
}

export function validateFeatureCheckout({ root, headSha, headTree, status, registered, appAncestor, appTree, changedPaths }) {
  const resolved = path.resolve(root ?? "");
  if (!resolved.startsWith("/home/serveradmin/worktrees/") || path.dirname(resolved) !== "/home/serveradmin/worktrees") throw new Error("Feature release must run from a registered staging tooling worktree");
  if (registered !== true || status) throw new Error("Feature release worktree must be registered and clean");
  if (appAncestor !== true || appTree !== STAGING_FEATURE.tree) throw new Error("Merged application source identity is unavailable or mismatched");
  if (!/^[a-f0-9]{40}$/.test(headSha ?? "") || !/^[a-f0-9]{40}$/.test(headTree ?? "")) throw new Error("Tooling checkout identity is invalid");
  if (!changedPaths.length || changedPaths.some(file => !SOURCE_TOOLING_PATHS.has(file))) throw new Error("Tooling successor contains changes outside the reviewed staging-only allowlist");
  return true;
}

export function normalizeFeatureImageRefs(refs) {
  const expectedRepos = { api: "api", platform: "platform", migrate: "migrate" };
  const normalized = {};
  for (const service of Object.keys(expectedRepos)) {
    const ref = refs?.[service];
    const match = DIGEST_REF.exec(ref ?? "");
    if (!match || match[1] !== expectedRepos[service]) throw new Error(`Feature ${service} image must use its approved repository and immutable sha256 digest`);
    normalized[service] = { reference: ref, manifestDigest: `sha256:${match[2]}` };
  }
  return normalized;
}

export function validateFeatureImageMetadata({ daemonId, image, expected, revision = STAGING_FEATURE.sha, architecture = STAGING_FEATURE.arch }) {
  if (daemonId !== STAGING_FEATURE.expectedDaemonId) throw new Error("Docker daemon identity does not match the staging host");
  if (!image || image.Os !== "linux" || image.Architecture !== architecture) throw new Error("Feature image OS/architecture is not approved");
  const labels = image.Config?.Labels ?? {};
  if (labels["org.opencontainers.image.revision"] !== revision || labels["com.myorder.deploy-sha"] !== revision) throw new Error("Feature image revision labels do not match the merged source commit");
  if (!Array.isArray(image.RepoDigests) || !image.RepoDigests.includes(expected.reference)) throw new Error("Feature image is not available by the requested immutable digest");
  if (!/^sha256:[a-f0-9]{64}$/.test(image.Id ?? "")) throw new Error("Feature image config identity is invalid");
  return image.Id;
}

export function validateFeatureComposeImages(config, refs) {
  const pinned = normalizeFeatureImageRefs(refs);
  for (const service of ["api", "platform", "migrate"]) {
    if (config?.services?.[service]?.image !== pinned[service].reference) throw new Error(`Staging Compose ${service} image differs from the pinned immutable digest`);
  }
  return true;
}

export function validateStagingRollbackBaseline({ project, apiId, platformId, databaseId = STAGING_FEATURE.databaseImageId, nginxId = STAGING_FEATURE.nginxImageId }) {
  if (project !== STAGING_FEATURE.project || apiId !== STAGING_FEATURE.rollback.api || platformId !== STAGING_FEATURE.rollback.platform || databaseId !== STAGING_FEATURE.databaseImageId || nginxId !== STAGING_FEATURE.nginxImageId) throw new Error("Live staging rollback baseline differs from the verified staging candidate");
  return true;
}

export function validateStaging0077Ledger({ count, has0075, has0076, has0077, hash0075, hash0076, hash0077, schemaApplied = false }) {
  const validPreviousHashes = hash0075 === STAGING_FEATURE.previousMigrationHashes["0075_catalogue_variant_attributes"] && hash0076 === STAGING_FEATURE.previousMigrationHashes["0076_tenant_woo_store_url_no_default"];
  if (schemaApplied) {
    if (count !== STAGING_FEATURE.expectedLedgerBefore + 1 || has0077 !== true || !has0075 || !has0076 || !validPreviousHashes || hash0077 !== STAGING_FEATURE.migrationHash) throw new Error("Staging migration ledger does not show exactly migration 0077 after the approved lineage");
  } else if (count !== STAGING_FEATURE.expectedLedgerBefore || has0077 || !has0075 || !has0076 || !validPreviousHashes || hash0077) {
    throw new Error("Staging migration ledger is not the recognized pre-0077 lineage");
  }
  return true;
}

export function validateStagingMigrationValidatorOutput(output, applied) {
  const expectedCount = applied ? "50/52" : "49/52";
  const state = applied ? "APPLIED" : "PENDING";
  const validatorOutput = String(output ?? "");
  if (!validatorOutput.includes("journal valid: 52 uniquely numbered executable entries") || !validatorOutput.includes(`recognized lineage preserved: ${expectedCount}`)) throw new Error("Staging full migration validator does not recognize the pinned ledger lineage");
  for (const [tag, hash] of Object.entries(STAGING_FEATURE.previousMigrationHashes)) {
    if (!validatorOutput.includes(`[migration-ledger] APPLIED ${tag} sha256=${hash}`)) throw new Error(`Staging migration validator did not confirm ${tag}`);
  }
  const candidate = `[migration-ledger] ${state} ${STAGING_FEATURE.migrationTag} sha256=${STAGING_FEATURE.migrationHash}`;
  if (!validatorOutput.includes(candidate)) throw new Error(`Staging migration validator did not report migration 0077 ${state.toLowerCase()}`);
  const pendingLines = validatorOutput.split(/\r?\n/).filter(line => line.includes("[migration-ledger] PENDING "));
  if (!applied && (pendingLines.length !== 1 || !pendingLines[0].includes(`PENDING ${STAGING_FEATURE.migrationTag} sha256=${STAGING_FEATURE.migrationHash}`))) throw new Error("Migration 0077 must be the only pending staging migration");
  if (applied && pendingLines.length !== 0) throw new Error("Unexpected pending migrations remain after migration 0077");
  for (const number of ["0068", "0069", "0070", "0071", "0072", "0073", "0074", "0075", "0076"]) {
    if (new RegExp(`\\[migration-ledger\\] PENDING ${number}_`).test(validatorOutput)) throw new Error(`Staging migration validator reports an unexpected pending migration ${number}`);
  }
  if (applied && new RegExp(`\\[migration-ledger\\] PENDING ${STAGING_FEATURE.migrationTag}`).test(validatorOutput)) throw new Error("Staging migration 0077 remains pending after migration");
  return true;
}

export function validateFreshRehearsalEvidence({ backupDir, backupRoot = STAGING_FEATURE.backupRoot, now = Date.now(), sourceContainer = STAGING_FEATURE.sourceContainer, maxAgeMs = 60 * 60 * 1000 }) {
  const root = path.resolve(backupRoot);
  const dir = path.resolve(backupDir ?? "");
  if (!dir.startsWith(`${root}/`)) throw new Error("Fresh staging backup evidence must be under the protected release-backups directory");
  const dirStat = lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077) !== 0 || dirStat.uid !== process.getuid?.() || realpathSync(dir) !== dir) throw new Error("Staging backup directory must be a restricted real directory owned by the operator");
  const dumpPath = path.join(dir, "staging-snapshot.dump");
  const evidencePath = path.join(dir, "backup-restore-evidence.txt");
  for (const file of [dumpPath, evidencePath]) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("Staging backup artifacts must be restricted regular files owned by the operator");
  }
  if (lstatSync(dumpPath).size === 0) throw new Error("Staging backup dump is empty");
  const rows = readFileSync(evidencePath, "utf8").split(/\r?\n/).filter(Boolean).map(line => {
    const split = line.indexOf("=");
    if (split < 1) throw new Error("Staging backup evidence is malformed");
    return [line.slice(0, split), line.slice(split + 1)];
  });
  const evidence = Object.fromEntries(rows);
  if (rows.length !== Object.keys(evidence).length) throw new Error("Staging backup evidence contains duplicate keys");
  if (evidence.source_container !== sourceContainer || evidence.source_project !== STAGING_FEATURE.project || evidence.source_database !== STAGING_FEATURE.database) throw new Error("Backup evidence is not from the pinned staging database");
  if (evidence.restore_image_id !== STAGING_FEATURE.restoreImageId) throw new Error("Isolated restore PostgreSQL image differs from the verified staging database image");
  if (evidence.migration_count_before_rehearsal !== String(STAGING_FEATURE.expectedLedgerBefore) || evidence.applied_0075 !== "true" || evidence.applied_0076 !== "true" || evidence.applied_0077_before !== "false") throw new Error("Backup evidence does not match the pre-0077 migration lineage");
  if (evidence.restore_network_internal !== "true" || evidence.restore_project !== "disposable-staging-0077" || evidence.restore_verified !== "true" || evidence.migration_0077_rehearsal !== "passed" || evidence.restore_schema_0077_verified !== "true" || evidence.restore_removed !== "true") throw new Error("Isolated restore and migration 0077 rehearsal evidence is incomplete");
  const verifiedAt = Date.parse(evidence.verified_at_utc ?? "");
  if (!Number.isFinite(verifiedAt) || verifiedAt > now || now - verifiedAt > maxAgeMs) throw new Error("Staging backup and isolated rehearsal evidence is missing or stale");
  const checksum = createHash("sha256").update(readFileSync(dumpPath)).digest("hex");
  if (checksum !== evidence.backup_sha256) throw new Error("Staging backup checksum does not match its restore evidence");
  return { verifiedAt, checksum, evidence };
}

export function validateFeatureMutation({ action, environment, services = [], backup }) {
  if (environment !== "staging") throw new Error("Feature migration/deployment action is staging-only");
  if (!new Set(["verify", "migrate", "up", "rollback"]).has(action)) throw new Error("Unsupported staging feature release action");
  if (action === "migrate" && (!backup || backup.evidence?.migration_0077_rehearsal !== "passed")) throw new Error("Migration 0077 requires a fresh verified backup and isolated restore rehearsal");
  if ((action === "up" || action === "rollback") && (services.length !== 2 || !services.includes("api") || !services.includes("platform"))) throw new Error("Feature rollout/rollback is restricted to API and Platform");
  if (services.some(service => !["api", "platform"].includes(service))) throw new Error("Only API and Platform are allowed for feature rollout/rollback");
  return true;
}

export function validateRehearsalMigrationFile(filePath, expectedSha256) {
  const bytes = readFileSync(filePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Migration 0077 checksum differs from the reviewed feature source");
  return digest;
}
