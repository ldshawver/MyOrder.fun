#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  STAGING_FEATURE,
  normalizeFeatureImageRefs,
  validateFeatureCheckout,
  validateFeatureComposeImages,
  validateFeatureImageMetadata,
  validateFeatureMutation,
  validateFreshRehearsalEvidence,
  validateStaging0077Ledger,
  validateStagingMigrationValidatorOutput,
  validateStagingFeatureTarget,
} from "./staging-feature-release-guards.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = process.env.MYORDER_STAGING_ENV_FILE;
const COMPOSE_FILE = path.join(ROOT, "deploy/docker-compose.staging.yml");
const imageEnv = {
  api: "MYORDER_API_IMAGE",
  platform: "MYORDER_PLATFORM_IMAGE",
  migrate: "MYORDER_MIGRATE_IMAGE",
};
const featureImageInputEnv = {
  api: "MYORDER_STAGING_FEATURE_API_IMAGE",
  platform: "MYORDER_STAGING_FEATURE_PLATFORM_IMAGE",
  migrate: "MYORDER_STAGING_FEATURE_MIGRATE_IMAGE",
};

function run(command, args, { capture = true, env = process.env, input } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", input, stdio: capture ? "pipe" : "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
  return result.stdout ?? "";
}

function checkedCheckout() {
  const headSha = run("git", ["-C", ROOT, "rev-parse", "HEAD"]).trim();
  const headTree = run("git", ["-C", ROOT, "rev-parse", "HEAD^{tree}"]).trim();
  const status = run("git", ["-C", ROOT, "status", "--porcelain=v1"]).trim();
  const registered = run("git", ["-C", ROOT, "worktree", "list", "--porcelain"])
    .split("\n").some(line => line.startsWith("worktree ") && path.resolve(line.slice(9)) === ROOT);
  const appAncestor = spawnSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", STAGING_FEATURE.sha, "HEAD"], { stdio: "ignore" }).status === 0;
  let appTree = "";
  if (appAncestor) appTree = run("git", ["-C", ROOT, "rev-parse", `${STAGING_FEATURE.sha}^{tree}`]).trim();
  const changedPaths = appAncestor ? run("git", ["-C", ROOT, "diff", "--name-only", `${STAGING_FEATURE.sha}..HEAD`]).trim().split("\n").filter(Boolean) : [];
  return validateFeatureCheckout({ root: ROOT, headSha, headTree, status, registered, appAncestor, appTree, changedPaths });
}

function verifyMigrationSource() {
  const migration = path.join(ROOT, "lib/db/drizzle/0077_catalogue_inventory_reconciliation.sql");
  const digest = createHash("sha256").update(readFileSync(migration)).digest("hex");
  if (digest !== STAGING_FEATURE.migrationHash) throw new Error("Migration 0077 source checksum differs from the reviewed feature commit");
}

function environmentAndCompose(refs) {
  if (typeof ENV_FILE !== "string" || !path.isAbsolute(ENV_FILE) || !existsSync(ENV_FILE)) throw new Error("MYORDER_STAGING_ENV_FILE must point to the protected staging environment file");
  const envStat = lstatSync(ENV_FILE);
  if (!envStat.isFile() || envStat.isSymbolicLink() || (envStat.mode & 0o077) !== 0) throw new Error("Staging environment file permissions must restrict group and other access");
  const prefix = ["compose", "--project-name", STAGING_FEATURE.project, "--env-file", ENV_FILE, "--file", COMPOSE_FILE];
  const env = { ...process.env, DEPLOY_SHA: STAGING_FEATURE.sha, DEPLOY_TREE: STAGING_FEATURE.tree };
  for (const key of Object.values(imageEnv)) delete env[key];
  if (refs) Object.assign(env, Object.fromEntries(Object.entries(imageEnv).map(([service, key]) => [key, refs[service]])));
  const config = JSON.parse(run("docker", [...prefix, "config", "--format", "json"], { env }));
  const apiDb = new URL(config.services.api.environment.DATABASE_URL);
  validateStagingFeatureTarget({
    environment: "staging", project: config.name, database: decodeURIComponent(apiDb.pathname.slice(1)),
    databaseHost: apiDb.hostname, composeFile: COMPOSE_FILE, deploySha: STAGING_FEATURE.sha, deployTree: STAGING_FEATURE.tree,
  });
  if (config.services.db.environment.POSTGRES_DB !== STAGING_FEATURE.database) throw new Error("Staging Compose database service target differs from the pinned database");
  const migrationDb = new URL(config.services.migrate.environment.DATABASE_URL);
  if (migrationDb.hostname !== "db" || decodeURIComponent(migrationDb.pathname.slice(1)) !== STAGING_FEATURE.database) throw new Error("Migration service is not bound to the staging database");
  const configuredNetworkNames = Object.values(config.networks ?? {}).map(network => network.name);
  if (configuredNetworkNames.length !== 1 || configuredNetworkNames[0] !== "myorder-staging_internal") throw new Error("Staging Compose must use only the pinned internal network");
  for (const [service, definition] of Object.entries(config.services)) {
    const attached = Object.keys(definition.networks ?? {});
    if (attached.length !== 1 || attached[0] !== "internal") throw new Error(`Staging ${service} must use only its internal network`);
  }
  if (config.volumes?.postgres_data?.name !== "myorder-staging_postgres_data") throw new Error("Staging Compose database volume does not match its pinned volume");
  const ports = config.services.nginx.ports ?? [];
  if (!ports.some(port => typeof port === "string" ? port.replaceAll("/tcp", "") === "127.0.0.1:28081:80" : port.host_ip === "127.0.0.1" && String(port.published) === "28081" && String(port.target) === "80")) throw new Error("Staging nginx must bind only the pinned staging proxy port");
  const api = config.services.api.environment;
  if (api.NODE_ENV !== "staging" || api.WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED !== "false" || api.LIVE_PAYMENTS_ENABLED === "true" || api.PAYMENT_MODE === "live" || api.PAYPAL_ENVIRONMENT === "live" || api.RECEIPT_PRINT_ENABLED === "true" || api.LABEL_PRINT_ENABLED === "true" || api.EMAIL_ENABLED !== "false" || api.SMS_ENABLED !== "false" || api.PUSH_ENABLED !== "false" || api.ORDER_NOTIFICATION_WORKER_ENABLED === "1" || api.UBER_DIRECT_DISPATCH_ENABLED === "true") throw new Error("Staging feature release requires side effects and external integrations disabled");
  validateFeatureComposeImages(config, refs);
  return { prefix, env, config };
}

function featureRefs() {
  const refs = Object.fromEntries(Object.entries(featureImageInputEnv).map(([service, key]) => [service, process.env[key]]));
  normalizeFeatureImageRefs(refs);
  return refs;
}

function verifiedImages(refs, revision = STAGING_FEATURE.sha) {
  const daemonId = run("docker", ["info", "--format", "{{.ID}}"]).trim();
  if (daemonId !== STAGING_FEATURE.expectedDaemonId) throw new Error("Docker daemon identity does not match the staging host");
  const normalized = normalizeFeatureImageRefs(refs);
  for (const service of ["api", "platform", "migrate"]) {
    const image = JSON.parse(run("docker", ["image", "inspect", normalized[service].reference, "--format", "{{json .}}"]));
    normalized[service].id = validateFeatureImageMetadata({ daemonId, image, expected: normalized[service], revision });
  }
  return normalized;
}

function stagingService(prefix, service) {
  const ids = run("docker", [...prefix, "ps", "--quiet", service]).trim().split(/\s+/).filter(Boolean);
  if (ids.length !== 1) throw new Error(`Expected exactly one ${service} service in the staging Compose project`);
  const data = JSON.parse(run("docker", ["inspect", "--format", "{{json .}}", ids[0]]));
  if (data.Config?.Labels?.["com.docker.compose.project"] !== STAGING_FEATURE.project || data.Config?.Labels?.["com.docker.compose.service"] !== service) throw new Error(`Resolved ${service} container is not owned by the staging project`);
  return data;
}

function verifyLiveRollback(prefix, permittedCurrentImages = null) {
  const api = stagingService(prefix, "api");
  const platform = stagingService(prefix, "platform");
  const database = stagingService(prefix, "db");
  const nginx = stagingService(prefix, "nginx");
  if (database.Name !== `/${STAGING_FEATURE.sourceContainer}`) throw new Error("Live staging database container name differs from the pinned source");
  const dbEnvironment = database.Config?.Env ?? [];
  if (!dbEnvironment.includes("POSTGRES_DB=myorder_staging") || dbEnvironment.includes("POSTGRES_DB=alavont")) throw new Error("Live database container is not configured for staging");
  if (database.Image !== STAGING_FEATURE.databaseImageId || nginx.Image !== STAGING_FEATURE.nginxImageId || nginx.Config?.Image !== "nginx:alpine") throw new Error("Staging DB or nginx image differs from the reviewed baseline");
  const dbVolume = (database.Mounts ?? []).find(mount => mount.Destination === "/var/lib/postgresql/data");
  if (dbVolume?.Name !== "myorder-staging_postgres_data") throw new Error("Staging database is not using its pinned persistent volume");
  const nginxBindings = Object.values(nginx.HostConfig?.PortBindings ?? {}).flat().map(binding => `${binding.HostIp}:${binding.HostPort}`);
  if (nginxBindings.length !== 1 || nginxBindings[0] !== "127.0.0.1:28081") throw new Error("Staging nginx does not bind only the expected staging proxy port");
  if (Object.values(database.HostConfig?.PortBindings ?? {}).flat().length !== 0) throw new Error("Staging database must not publish a host port");
  for (const container of [api, platform, database, nginx]) {
    const networks = Object.keys(container.NetworkSettings?.Networks ?? {});
    if (networks.length !== 1 || networks[0] !== "myorder-staging_internal") throw new Error("Staging service is attached to a non-staging network");
    if (container.State?.Health?.Status !== "healthy") throw new Error("A running staging service is not healthy");
  }
  const serviceImages = [[api, "api"], [platform, "platform"]];
  const serviceBaselines = new Map(serviceImages.map(([container, service]) => [service, container.Image === STAGING_FEATURE.rollback[service]]));
  const serviceFeatures = new Map(serviceImages.map(([container, service]) => [service, Boolean(permittedCurrentImages && container.Image === permittedCurrentImages[service].id)]));
  const allBaseline = [...serviceBaselines.values()].every(Boolean);
  const allAllowedForRollback = serviceImages.every(([, service]) => serviceBaselines.get(service) || serviceFeatures.get(service));
  if (!allBaseline && !(permittedCurrentImages && allAllowedForRollback)) throw new Error("Live staging image baseline differs from the approved rollback or selected feature images");
  const rollbackRefs = {
    api: { id: STAGING_FEATURE.rollback.api, reference: `myorder-api@${STAGING_FEATURE.rollback.api}` },
    platform: { id: STAGING_FEATURE.rollback.platform, reference: `myorder-platform@${STAGING_FEATURE.rollback.platform}` },
  };
  const daemonId = run("docker", ["info", "--format", "{{.ID}}"] ).trim();
  if (daemonId !== STAGING_FEATURE.expectedDaemonId) throw new Error("Docker daemon identity does not match the staging host");
  for (const [container, service] of serviceImages) {
    const isServiceBaseline = serviceBaselines.get(service);
    const expectedRevision = isServiceBaseline ? STAGING_FEATURE.rollbackRevision : STAGING_FEATURE.sha;
    if (container.Config?.Labels?.["org.opencontainers.image.revision"] !== expectedRevision) throw new Error(`Live staging ${service} revision label is not approved`);
    const expected = isServiceBaseline ? rollbackRefs[service] : permittedCurrentImages[service];
    if (container.Config?.Image !== expected.reference) throw new Error(`Live staging ${service} Compose reference is not immutable and approved`);
    if (isServiceBaseline) {
      const image = JSON.parse(run("docker", ["image", "inspect", expected.id, "--format", "{{json .}}"]));
      if (image.Id !== expected.id || image.Os !== "linux" || image.Architecture !== STAGING_FEATURE.arch || !image.RepoDigests?.includes(expected.reference) || image.Config?.Labels?.["org.opencontainers.image.revision"] !== STAGING_FEATURE.rollbackRevision) throw new Error(`Staging ${service} rollback artifact identity is unavailable`);
    }
  }
  return { api, platform, database, nginx };
}

function query(prefix, user, sql) {
  return run("docker", [...prefix, "exec", "-T", "db", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", STAGING_FEATURE.database, "-Atc", sql]).trim();
}

function ledgerState(prefix, user, applied) {
  const sql = `SELECT count(*)::text || ':' ||
    coalesce((SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=${STAGING_FEATURE.previousMigrationTimestamps["0075_catalogue_variant_attributes"]}),'') || ':' ||
    coalesce((SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=${STAGING_FEATURE.previousMigrationTimestamps["0076_tenant_woo_store_url_no_default"]}),'') || ':' ||
    coalesce((SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=${STAGING_FEATURE.migrationTimestamp}),'')`;
  const [count, hash0075, hash0076, hash0077] = query(prefix, user, sql).split(":");
  validateStaging0077Ledger({ count: Number(count), has0075: Boolean(hash0075), has0076: Boolean(hash0076), has0077: Boolean(hash0077), hash0075, hash0076, hash0077: hash0077 || undefined, schemaApplied: applied });
}

function runMigrationValidator(prefix, env, applied) {
  const output = run("docker", [...prefix, "run", "--pull", "never", "--rm", "--no-deps", "migrate", "pnpm", "--filter", "@workspace/db", "db:validate-migrations"], { env });
  validateStagingMigrationValidatorOutput(output, applied);
}

function validateFeatureBackup() {
  return validateFreshRehearsalEvidence({ backupDir: process.env.MYORDER_STAGING_BACKUP_DIR });
}

function verifyReconciledSchema(prefix, dbUser) {
  const result = query(prefix, dbUser, `SELECT to_regclass('public.catalogue_inventory_reconciliation_events') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='catalogue_inventory_reconciliation_immutable' AND NOT tgisinternal)
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='catalogue_product_inventory_model_guard' AND NOT tgisinternal)
    AND to_regprocedure('public.block_live_inventory_model_change()') IS NOT NULL`);
  if (result !== "t") throw new Error("Migration 0077 schema objects did not verify after application");
}

function checkRunningFeature(prefix, normalizedRefs) {
  for (const service of ["api", "platform"]) {
    const container = stagingService(prefix, service);
    const image = normalizedRefs[service];
    // Compose stores the manifest digest in Config.Image while Docker .Image
    // is the image config ID, so both identities must agree.
    if (container.Image !== image.id || container.Config?.Image !== image.reference) throw new Error(`Staging ${service} is not running its selected immutable digest`);
  }
  const db = stagingService(prefix, "db");
  const nginx = stagingService(prefix, "nginx");
  if (db.Image !== STAGING_FEATURE.databaseImageId || nginx.Image !== STAGING_FEATURE.nginxImageId) throw new Error("Feature rollout changed the staging DB or nginx image");
}

function main() {
  const [action, ...args] = process.argv.slice(2);
  if (args.length) throw new Error("Usage: staging-feature-release.mjs <verify|migrate|up|rollback>");
  checkedCheckout();
  verifyMigrationSource();
  const refs = action === "rollback" ? {
    api: `myorder-api@${STAGING_FEATURE.rollback.api}`,
    platform: `myorder-platform@${STAGING_FEATURE.rollback.platform}`,
    migrate: `myorder-migrate@${STAGING_FEATURE.rollback.migrate}`,
  } : featureRefs();
  const compose = environmentAndCompose(refs);
  const { prefix, env, config } = compose;
  const dbUser = config.services.db.environment.POSTGRES_USER;
  if (!dbUser) throw new Error("Staging database user is missing from protected Compose configuration");
  const normalizedImages = verifiedImages(refs, action === "rollback" ? "40fccbc3d9464ddfa5574f2cb57b71d0fe3ab833" : STAGING_FEATURE.sha);
  const backup = action === "migrate" ? validateFeatureBackup() : undefined;
  validateFeatureMutation({ action, environment: "staging", services: action === "up" || action === "rollback" ? ["api", "platform"] : [], backup });
  verifyLiveRollback(prefix, action === "rollback" ? normalizedImages : null);

  if (action === "verify") {
    ledgerState(prefix, dbUser, false);
    runMigrationValidator(prefix, env, false);
    console.log("Staging target, frozen feature identity, immutable image metadata, rollback baseline, and pre-0077 ledger verified.");
    return;
  }
  if (action === "migrate") {
    ledgerState(prefix, dbUser, false);
    runMigrationValidator(prefix, env, false);
    run("docker", [...prefix, "run", "--pull", "never", "--rm", "--no-deps", "migrate"], { env });
    ledgerState(prefix, dbUser, true);
    runMigrationValidator(prefix, env, true);
    verifyReconciledSchema(prefix, dbUser);
    console.log("Staging migration 0077 applied and verified; no application containers were replaced.");
    return;
  }
  if (action === "up") {
    ledgerState(prefix, dbUser, true);
    runMigrationValidator(prefix, env, true);
    verifyReconciledSchema(prefix, dbUser);
    run("docker", [...prefix, "up", "--pull", "never", "--no-build", "-d", "--no-deps", "api", "platform"], { env });
    checkRunningFeature(prefix, normalizeFeatureImageRefs(refs));
    console.log("Staging API and Platform started from the selected immutable feature images.");
    return;
  }
  if (action === "rollback") {
    ledgerState(prefix, dbUser, true);
    verifyReconciledSchema(prefix, dbUser);
    const rollbackEnv = {
      ...env,
      DEPLOY_SHA: "40fccbc3d9464ddfa5574f2cb57b71d0fe3ab833",
      DEPLOY_TREE: "76bb2bc969450206f0be4754a6ef95434cd27b4a",
      MYORDER_API_IMAGE: refs.api,
      MYORDER_PLATFORM_IMAGE: refs.platform,
      MYORDER_MIGRATE_IMAGE: refs.migrate,
    };
    run("docker", [...prefix, "up", "--pull", "never", "--no-build", "-d", "--no-deps", "api", "platform"], { env: rollbackEnv });
    checkRunningFeature(prefix, normalizedImages);
    console.log("Staging application images rolled back to the approved 40fcc baseline; database migration remains forward-only.");
    return;
  }
  throw new Error("Unknown staging feature action");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Staging feature release refused: ${error instanceof Error ? error.message : "unknown error"}`); process.exitCode = 1; }
}
