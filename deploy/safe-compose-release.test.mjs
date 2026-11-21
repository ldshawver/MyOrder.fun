import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  RELEASE_MODE_VALUE,
  STAGING_MIGRATION_CONFIRMATION,
  classifyMigrationValidatorOutput,
  isVerifiedReleaseMode,
  validateDeployedReleaseContainer,
  validateReleaseBackupArtifact,
  validateReleaseImageMetadata,
  validateReleaseMigrationPlan,
} from "./safe-compose.mjs";

const SHA = "414081c48d8cd889a7344eda6b175c4f98e7896f";
const DAEMON = "90b592a4-aee8-4d61-99a2-1a6a8b58ed55";
const PINNED = "40fccbc3d9464ddfa5574f2cb57b71d0fe3ab833";
const source = readFileSync(new URL("./safe-compose.mjs", import.meta.url), "utf8");

test("verified-release mode is opt-in, staging-only and needs a full non-pinned SHA", () => {
  assert.equal(isVerifiedReleaseMode({ environment: "staging", deploySha: SHA, mode: undefined }), false);
  assert.equal(isVerifiedReleaseMode({ environment: "staging", deploySha: SHA, mode: "" }), false);
  assert.equal(isVerifiedReleaseMode({ environment: "staging", deploySha: SHA, mode: RELEASE_MODE_VALUE }), true);
  assert.throws(() => isVerifiedReleaseMode({ environment: "production", deploySha: SHA, mode: RELEASE_MODE_VALUE }), /staging-only/);
  assert.throws(() => isVerifiedReleaseMode({ environment: "staging", deploySha: "414081c", mode: RELEASE_MODE_VALUE }), /full release SHA/);
  assert.throws(() => isVerifiedReleaseMode({ environment: "staging", deploySha: PINNED, mode: RELEASE_MODE_VALUE }), /pinned candidate/);
  assert.throws(() => isVerifiedReleaseMode({ environment: "staging", deploySha: SHA, mode: "anything" }), /Unknown/);
});

const validatorOutput = (applied, pending) => [
  "[migration-ledger] inventory valid: 58 SQL files",
  ...applied.map(t => `[migration-ledger] APPLIED ${t} sha256=abc`),
  ...pending.map(t => `[migration-ledger] PENDING ${t} sha256=def`),
  `[migration-ledger] recognized lineage preserved: ${applied.length}/${applied.length + pending.length}`,
].join("\n");

test("migration status is read from the release's own validator output", () => {
  const status = classifyMigrationValidatorOutput(validatorOutput(["0000_a", "0001_b"], ["0002_c"]));
  assert.deepEqual(status, { applied: ["0000_a", "0001_b"], pending: ["0002_c"], journalCount: 3 });
  assert.throws(() => classifyMigrationValidatorOutput("[migration-ledger] APPLIED 0000_a"), /recognized staging lineage/);
  assert.throws(() => classifyMigrationValidatorOutput("[migration-ledger] APPLIED 0000_a\n[migration-ledger] recognized lineage preserved: 1/3"), /inconsistent/);
});

test("deploy never runs migrations implicitly; migrate needs confirmation and real pending work", () => {
  assert.equal(validateReleaseMigrationPlan({ action: "up", pending: [] }), true);
  assert.throws(() => validateReleaseMigrationPlan({ action: "up", pending: ["0084_x"] }), /pending staging migration.*0084_x/);
  assert.throws(() => validateReleaseMigrationPlan({ action: "migrate", pending: ["0084_x"], confirmation: "yes" }), /explicit migration confirmation/);
  assert.throws(() => validateReleaseMigrationPlan({ action: "migrate", pending: [], confirmation: STAGING_MIGRATION_CONFIRMATION }), /No pending/);
  assert.equal(validateReleaseMigrationPlan({ action: "migrate", pending: ["0084_x"], confirmation: STAGING_MIGRATION_CONFIRMATION }), true);
  assert.throws(() => validateReleaseMigrationPlan({ action: "up", pending: undefined }), /unavailable/);
});

const image = (service, revision = SHA, extra = {}) => ({
  RepoTags: [`myorder-${service}:${revision}`], Os: "linux", Architecture: "amd64",
  Config: { Labels: { "org.opencontainers.image.revision": revision, "com.myorder.deploy-sha": revision } }, ...extra,
});

test("release images must be built on the staging daemon from the selected commit", () => {
  assert.equal(validateReleaseImageMetadata({ daemonId: DAEMON, image: image("api"), service: "api", revision: SHA }), `myorder-api:${SHA}`);
  assert.throws(() => validateReleaseImageMetadata({ daemonId: "other", image: image("api"), service: "api", revision: SHA }), /daemon identity/);
  assert.throws(() => validateReleaseImageMetadata({ daemonId: DAEMON, image: image("api", PINNED), service: "api", revision: SHA }), /was not built/);
  assert.throws(() => validateReleaseImageMetadata({ daemonId: DAEMON, image: { ...image("api"), Config: { Labels: { "com.myorder.deploy-sha": PINNED, "org.opencontainers.image.revision": SHA } } }, service: "api", revision: SHA }), /labels/);
  assert.throws(() => validateReleaseImageMetadata({ daemonId: DAEMON, image: image("api", SHA, { Architecture: "arm64" }), service: "api", revision: SHA }), /architecture/);
  assert.throws(() => validateReleaseImageMetadata({ daemonId: DAEMON, image: image("db"), service: "db", revision: SHA }), /Unexpected/);
});

test("deployed containers must run the release image and be running", () => {
  const ok = { Config: { Image: `myorder-api:${SHA}`, Labels: { "com.myorder.deploy-sha": SHA } }, State: { Running: true } };
  assert.equal(validateDeployedReleaseContainer({ container: ok, service: "api", revision: SHA }), true);
  assert.throws(() => validateDeployedReleaseContainer({ container: { ...ok, Config: { ...ok.Config, Image: `myorder-api:${PINNED}` } }, service: "api", revision: SHA }), /not running myorder-api/);
  assert.throws(() => validateDeployedReleaseContainer({ container: { ...ok, State: { Running: false } }, service: "api", revision: SHA }), /not running$/);
});

test("pre-migration backups are restricted, non-empty, readable and inside release-backups", () => {
  const good = { backupPath: "/home/serveradmin/release-backups/staging-release-x/staging.dump", size: 10, mode: 0o100600, isFile: true, isSymlink: false, restoreListOk: true };
  assert.equal(validateReleaseBackupArtifact(good), true);
  assert.throws(() => validateReleaseBackupArtifact({ ...good, backupPath: "/tmp/staging.dump" }), /protected release-backups/);
  assert.throws(() => validateReleaseBackupArtifact({ ...good, mode: 0o100644 }), /restricted/);
  assert.throws(() => validateReleaseBackupArtifact({ ...good, size: 0 }), /empty/);
  assert.throws(() => validateReleaseBackupArtifact({ ...good, restoreListOk: false }), /pg_restore/);
});

test("release-mode wiring: preflight precedes mutations, migrate backs up first, pinned path untouched", () => {
  const main = source.slice(source.indexOf("function main()"));
  const release = main.slice(main.indexOf("if (releaseMode) {\n    const revision"));
  assert.ok(main.indexOf("verifyStagingMutationPreflight(prefix, resolved") < main.indexOf("if (releaseMode) {\n    const revision"));
  assert.ok(release.indexOf("createReleaseBackup(") < release.indexOf('pinnedRunArgs("migrate")], { env: pinnedEnv })'));
  assert.ok(release.indexOf("validateReleaseMigrationPlan({ action, pending: migrationStatus.pending })") < release.indexOf("pinnedUpArgs(services)"));
  assert.match(main, /if \(process\.env\.DEPLOY_SHA !== PINNED_CANDIDATE\.sha \|\| process\.env\.DEPLOY_TREE !== PINNED_CANDIDATE\.tree\) throw/);
  assert.match(main, /releaseMode && process\.env\.DEPLOY_SHA !== headSha/);
  // Staging up is still restricted to exactly api + platform in every mode.
  assert.match(main, /environment === "staging" && action === "up" && \(services\.length !== 2/);
});
