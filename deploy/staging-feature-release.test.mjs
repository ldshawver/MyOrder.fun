import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  STAGING_FEATURE,
  normalizeFeatureImageRefs,
  validateFeatureCheckout,
  validateFeatureComposeImages,
  validateFeatureImageMetadata,
  validateFeatureMutation,
  validateFreshRehearsalEvidence,
  validateStaging0077Ledger,
  validateStagingFeatureTarget,
  validateStagingMigrationValidatorOutput,
  validateStagingRollbackBaseline,
} from "./staging-feature-release-guards.mjs";

const IMAGE = Object.freeze({
  api: `myorder-api@sha256:${"a".repeat(64)}`,
  platform: `myorder-platform@sha256:${"b".repeat(64)}`,
  migrate: `myorder-migrate@sha256:${"c".repeat(64)}`,
});

test("accepts only merged PR 163 identity and the isolated staging target", () => {
  assert.equal(validateStagingFeatureTarget({ environment: "staging", project: "myorder-staging", database: "myorder_staging", databaseHost: "db", composeFile: "/some/worktree/deploy/docker-compose.staging.yml", deploySha: STAGING_FEATURE.sha, deployTree: STAGING_FEATURE.tree }), true);
  for (const overrides of [
    { environment: "production" },
    { project: "deploy" },
    { database: "alavont" },
    { databaseHost: "production-db" },
    { composeFile: "/opt/alavont/deploy/docker-compose.yml" },
    { deploySha: "a".repeat(40) },
    { deployTree: "b".repeat(40) },
  ]) assert.throws(() => validateStagingFeatureTarget({ environment: "staging", project: "myorder-staging", database: "myorder_staging", databaseHost: "db", composeFile: "/tmp/deploy/docker-compose.staging.yml", deploySha: STAGING_FEATURE.sha, deployTree: STAGING_FEATURE.tree, ...overrides }));
});

test("requires a clean registered tooling successor containing no application changes", () => {
  const base = { root: "/home/serveradmin/worktrees/staging-release", headSha: "d".repeat(40), headTree: "e".repeat(40), status: "", registered: true, appAncestor: true, appTree: STAGING_FEATURE.tree, changedPaths: ["deploy/staging-feature-release.mjs"] };
  assert.equal(validateFeatureCheckout(base), true);
  for (const overrides of [
    { root: "/opt/alavont" },
    { status: " M deploy/file" },
    { registered: false },
    { appAncestor: false },
    { appTree: "f".repeat(40) },
    { changedPaths: ["artifacts/api-server/src/index.ts"] },
  ]) assert.throws(() => validateFeatureCheckout({ ...base, ...overrides }));
});

test("accepts only immutable service-specific image refs and source-matched image metadata", () => {
  const refs = normalizeFeatureImageRefs(IMAGE);
  assert.equal(refs.api.reference, IMAGE.api);
  assert.throws(() => normalizeFeatureImageRefs({ ...IMAGE, api: "myorder-api:latest" }), /immutable sha256/);
  assert.throws(() => normalizeFeatureImageRefs({ ...IMAGE, platform: `myorder-api@sha256:${"b".repeat(64)}` }), /repository/);
  const image = { Id: `sha256:${"d".repeat(64)}`, Os: "linux", Architecture: "amd64", RepoDigests: [IMAGE.api], Config: { Labels: { "org.opencontainers.image.revision": STAGING_FEATURE.sha, "com.myorder.deploy-sha": STAGING_FEATURE.sha } } };
  assert.equal(validateFeatureImageMetadata({ daemonId: STAGING_FEATURE.expectedDaemonId, image, expected: refs.api }), image.Id);
  assert.throws(() => validateFeatureImageMetadata({ daemonId: "production-daemon", image, expected: refs.api }), /daemon identity/);
  assert.throws(() => validateFeatureImageMetadata({ daemonId: STAGING_FEATURE.expectedDaemonId, image: { ...image, Architecture: "arm64" }, expected: refs.api }), /architecture/);
  assert.throws(() => validateFeatureImageMetadata({ daemonId: STAGING_FEATURE.expectedDaemonId, image: { ...image, Config: { Labels: { ...image.Config.Labels, "com.myorder.deploy-sha": "a".repeat(40) } } }, expected: refs.api }), /revision labels/);
  assert.throws(() => validateFeatureImageMetadata({ daemonId: STAGING_FEATURE.expectedDaemonId, image: { ...image, RepoDigests: [] }, expected: refs.api }), /immutable digest/);
});

test("requires all three Compose image refs to equal the verified immutable candidate set", () => {
  const config = { services: { api: { image: IMAGE.api, build: { context: ".." } }, platform: { image: IMAGE.platform, build: { context: ".." } }, migrate: { image: IMAGE.migrate, build: { context: ".." } } } };
  assert.equal(validateFeatureComposeImages(config, IMAGE), true);
  for (const service of ["api", "platform", "migrate"]) {
    const changed = structuredClone(config);
    changed.services[service].image = `myorder-${service}:mutable`;
    assert.throws(() => validateFeatureComposeImages(changed, IMAGE));
  }
});

test("fails closed on staging rollback baseline, migration lineage and migration postcondition drift", () => {
  assert.equal(validateStagingRollbackBaseline({ project: STAGING_FEATURE.project, apiId: STAGING_FEATURE.rollback.api, platformId: STAGING_FEATURE.rollback.platform }), true);
  assert.throws(() => validateStagingRollbackBaseline({ project: "deploy", apiId: STAGING_FEATURE.rollback.api, platformId: STAGING_FEATURE.rollback.platform }));
  assert.throws(() => validateStagingRollbackBaseline({ project: STAGING_FEATURE.project, apiId: "sha256:wrong", platformId: STAGING_FEATURE.rollback.platform }));
  const hashes = { hash0075: STAGING_FEATURE.previousMigrationHashes["0075_catalogue_variant_attributes"], hash0076: STAGING_FEATURE.previousMigrationHashes["0076_tenant_woo_store_url_no_default"] };
  assert.equal(validateStaging0077Ledger({ count: 49, has0075: true, has0076: true, has0077: false, ...hashes }), true);
  assert.throws(() => validateStaging0077Ledger({ count: 48, has0075: true, has0076: true, has0077: false, ...hashes }));
  assert.throws(() => validateStaging0077Ledger({ count: 49, has0075: false, has0076: true, has0077: false, ...hashes }));
  assert.throws(() => validateStaging0077Ledger({ count: 49, has0075: true, has0076: true, has0077: true, ...hashes }));
  assert.equal(validateStaging0077Ledger({ count: 50, has0075: true, has0076: true, has0077: true, hash0077: STAGING_FEATURE.migrationHash, schemaApplied: true, ...hashes }), true);
  assert.throws(() => validateStaging0077Ledger({ count: 51, has0075: true, has0076: true, has0077: true, hash0077: STAGING_FEATURE.migrationHash, schemaApplied: true, ...hashes }));
});

test("requires the feature migrator's read-only full-lineage validation before and after 0077", () => {
  const before = [
    "[migration-ledger] journal valid: 52 uniquely numbered executable entries",
    `[migration-ledger] APPLIED 0075_catalogue_variant_attributes sha256=${STAGING_FEATURE.previousMigrationHashes["0075_catalogue_variant_attributes"]}`,
    `[migration-ledger] APPLIED 0076_tenant_woo_store_url_no_default sha256=${STAGING_FEATURE.previousMigrationHashes["0076_tenant_woo_store_url_no_default"]}`,
    `[migration-ledger] PENDING ${STAGING_FEATURE.migrationTag} sha256=${STAGING_FEATURE.migrationHash}`,
    "[migration-ledger] recognized lineage preserved: 49/52",
  ].join("\n");
  const after = before.replace("PENDING 0077", "APPLIED 0077").replace("49/52", "50/52");
  assert.equal(validateStagingMigrationValidatorOutput(before, false), true);
  assert.equal(validateStagingMigrationValidatorOutput(after, true), true);
  assert.throws(() => validateStagingMigrationValidatorOutput(before.replace("sha256=" + STAGING_FEATURE.previousMigrationHashes["0076_tenant_woo_store_url_no_default"], "sha256=wrong"), false));
  assert.throws(() => validateStagingMigrationValidatorOutput(before.replace("49/52", "48/52"), false));
  assert.throws(() => validateStagingMigrationValidatorOutput(after.replace("APPLIED 0077", "PENDING 0077"), true));
});

function backupFixture(overrides = {}) {
  const base = fsFixture();
  const now = Date.parse("2026-10-19T18:00:00Z");
  const evidence = {
    source_container: STAGING_FEATURE.sourceContainer,
    source_project: STAGING_FEATURE.project,
    source_database: STAGING_FEATURE.database,
    backup_sha256: base.checksum,
    restore_image_id: STAGING_FEATURE.restoreImageId,
    restore_project: "disposable-staging-0077",
    restore_network_internal: "true",
    restore_verified: "true",
    migration_0077_rehearsal: "passed",
    restore_schema_0077_verified: "true",
    migration_count_before_rehearsal: "49",
    applied_0075: "true",
    applied_0076: "true",
    applied_0077_before: "false",
    restore_removed: "true",
    verified_at_utc: "2026-10-19T17:45:00Z",
    ...overrides,
  };
  const writeEvidence = (value) => writeFileSync(path.join(base.dir, "backup-restore-evidence.txt"), Object.entries(value).map(([key, entry]) => `${key}=${entry}`).join("\n") + "\n", { mode: 0o600 });
  writeEvidence(evidence);
  return { ...base, now, evidence, writeEvidence };
}

function fsFixture() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "myorder-stage-rehearsal-"));
  const root = path.join(parent, "release-backups");
  const dir = path.join(root, "run");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700); chmodSync(root, 0o700); chmodSync(dir, 0o700);
  const dump = path.join(dir, "staging-snapshot.dump");
  writeFileSync(dump, "fixture backup bytes", { mode: 0o600 });
  return { parent, root, dir, checksum: createHash("sha256").update(readFileSync(dump)).digest("hex") };
}

test("requires a fresh protected backup, verified isolated restore and successful 0077 rehearsal", () => {
  const fixture = backupFixture();
  try {
    const valid = validateFreshRehearsalEvidence({ backupDir: fixture.dir, backupRoot: fixture.root, now: fixture.now });
    assert.equal(valid.checksum, fixture.checksum);
    for (const overrides of [
      { source_container: "deploy-db-1" },
      { source_project: "deploy" },
      { source_database: "alavont" },
      { restore_image_id: "sha256:wrong" },
      { migration_0077_rehearsal: "missing" },
      { restore_network_internal: "false" },
      { restore_removed: "false" },
      { migration_count_before_rehearsal: "48" },
      { verified_at_utc: "2026-10-19T16:00:00Z" },
    ]) {
      fixture.writeEvidence({ ...fixture.evidence, ...overrides });
      assert.throws(() => validateFreshRehearsalEvidence({ backupDir: fixture.dir, backupRoot: fixture.root, now: fixture.now }));
    }
    fixture.writeEvidence({ ...fixture.evidence });
    writeFileSync(path.join(fixture.dir, "staging-snapshot.dump"), "tampered");
    assert.throws(() => validateFreshRehearsalEvidence({ backupDir: fixture.dir, backupRoot: fixture.root, now: fixture.now }), /checksum/);
    assert.throws(() => validateFreshRehearsalEvidence({ backupDir: path.join(fixture.parent, "outside"), backupRoot: fixture.root, now: fixture.now }), /under the protected/);
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
});

test("mutation gates require a staging-only exact target and verified backup before migration", () => {
  const backup = { evidence: { migration_0077_rehearsal: "passed" } };
  assert.equal(validateFeatureMutation({ action: "migrate", environment: "staging", backup }), true);
  assert.throws(() => validateFeatureMutation({ action: "migrate", environment: "staging" }), /fresh verified backup/);
  assert.throws(() => validateFeatureMutation({ action: "migrate", environment: "production", backup }), /staging-only/);
  assert.equal(validateFeatureMutation({ action: "up", environment: "staging", services: ["api", "platform"] }), true);
  assert.throws(() => validateFeatureMutation({ action: "up", environment: "staging", services: ["api", "platform", "nginx"] }), /restricted/);
  assert.equal(validateFeatureMutation({ action: "rollback", environment: "staging", services: ["api", "platform"] }), true);
  assert.throws(() => validateFeatureMutation({ action: "rollback", environment: "production", services: ["api", "platform"] }), /staging-only/);
});

test("rehearsal script is staging-only, internal-networked, read-only to source and never publishes restore ports", () => {
  const script = readFileSync(new URL("../scripts/release/staging-0077-backup-restore-rehearsal.sh", import.meta.url), "utf8");
  assert.match(script, /SOURCE_CONTAINER:-myorder-staging-db-1/);
  assert.match(script, /POSTGRES_IMAGE_ID="sha256:16bc/);
  assert.match(script, /--internal --driver bridge/);
  assert.match(script, /--format=custom/);
  assert.match(script, /--single-transaction/);
  assert.match(script, /docker rm -f "\$RESTORE_CONTAINER"/);
  assert.doesNotMatch(script, /-p 127\.0\.0\.1::5432/);
  assert.match(script, /Production database was detected; refusing/);
  assert.doesNotMatch(script, /alavont.*(pg_dump|migrate)|production-release\.mjs/);
});

test("CLI keeps production controller untouched and mutation commands cannot build/pull/target nginx", () => {
  const source = readFileSync(new URL("./staging-feature-release.mjs", import.meta.url), "utf8");
  assert.match(source, /project-name", STAGING_FEATURE\.project/);
  assert.match(source, /--pull", "never", "--no-build"/);
  assert.match(source, /"api", "platform"/);
  assert.doesNotMatch(source, /project-name", "deploy"|docker-compose\.yml/);
  const oldController = readFileSync(new URL("./safe-compose.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(oldController, /staging-feature-release/);
});

test("rollback is app-only, uses the approved old digests, and keeps 0077 forward-only", () => {
  const source = readFileSync(new URL("./staging-feature-release.mjs", import.meta.url), "utf8");
  const rollback = source.slice(source.indexOf('if (action === "rollback")'), source.indexOf('throw new Error("Unknown staging feature action")'));
  assert.match(rollback, /ledgerState\(prefix, dbUser, true\)/);
  assert.match(rollback, /DEPLOY_SHA: "40fccbc3d9464ddfa5574f2cb57b71d0fe3ab833"/);
  assert.match(rollback, /MYORDER_API_IMAGE: refs\.api/);
  assert.match(rollback, /MYORDER_PLATFORM_IMAGE: refs\.platform/);
  assert.match(rollback, /--no-build.*--no-deps.*"api", "platform"/s);
  assert.match(rollback, /checkRunningFeature\(prefix, normalizedImages\)/);
  assert.doesNotMatch(rollback, /"run".*"migrate"/s);
  assert.match(rollback, /database migration remains forward-only/);
});
