#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = { staging: "myorder-staging", production: "deploy" };
const ENVIRONMENT = { staging: "staging", production: "production" };
const DATABASE = { staging: "myorder_staging", production: "alavont" };
const WORKTREES_ROOT = "/home/serveradmin/worktrees";
const STAGING_BACKUP_ROOT = "/home/serveradmin/release-backups";
const P0_PATCH_SHA256 = "cd496d318643c3f485a563445ae5d3f59b3f4ea79d991108b2e7c17dd83db54a";
const ROOTS = { production: "/opt/alavont" };
const RELEASE_BASE_SHA = "8744d8e34ab8627555919aec337abde0c3291e0f";
const EXPECTED_DOCKER_DAEMON_ID = "90b592a4-aee8-4d61-99a2-1a6a8b58ed55";
const EXPECTED_ARCH = "amd64";
const PINNED_CANDIDATE = {
  sha: "40fccbc3d9464ddfa5574f2cb57b71d0fe3ab833",
  tree: "76bb2bc969450206f0be4754a6ef95434cd27b4a",
  images: {
    api: { id: "sha256:acafc8bdb7899d2c85b47cc234ac58ad99e854034571ba6634aa51983c6b229b", reference: "myorder-api@sha256:acafc8bdb7899d2c85b47cc234ac58ad99e854034571ba6634aa51983c6b229b" },
    platform: { id: "sha256:fbd2185bca1e471462a41fac0c50595643c84a6e506076311655c792b2a2ca13", reference: "myorder-platform@sha256:fbd2185bca1e471462a41fac0c50595643c84a6e506076311655c792b2a2ca13" },
    migrate: { id: "sha256:878d21dec057bfccbf294465e77627f20e04df6d82bba70f549473aa84454461", reference: "myorder-migrate@sha256:878d21dec057bfccbf294465e77627f20e04df6d82bba70f549473aa84454461" },
  },
};
const PINNED_ROLLBACK = {
  sha: "c549816b2ce647c38fdf4a7c4d7d5e5b0036a8a6",
  tree: "eb3bb038ca02ef94312c08ab8a8899f958ab51f7",
  images: {
    api: { id: "sha256:c88bc44648cb2c953fc3662c0141e8066bf1af97beb413fc4e7557aaeee69a2c", reference: "myorder-api@sha256:c88bc44648cb2c953fc3662c0141e8066bf1af97beb413fc4e7557aaeee69a2c" },
    platform: { id: "sha256:62397f96aa63207aa0b63ab90f1c0bbbcd30df19f0aef142e6931bb1356e829a", reference: "myorder-platform@sha256:62397f96aa63207aa0b63ab90f1c0bbbcd30df19f0aef142e6931bb1356e829a" },
  },
};
const TOOLING_ONLY_PATHS = new Set(["deploy/docker-compose.staging.yml", "deploy/safe-compose.mjs", "deploy/safe-compose.test.mjs"]);
const ACTIONS = new Set(["config", "build", "up", "migrate", "p0", "bootstrap", "stop"]);

export function validatePinnedImageMetadata({ daemonId, expectedDaemonId = EXPECTED_DOCKER_DAEMON_ID, image, expected, revision, architecture = EXPECTED_ARCH }) {
  if (daemonId !== expectedDaemonId) throw new Error("Docker daemon identity does not match the approved staging host");
  if (!image || image.Id !== expected.id) throw new Error("Local image ID does not match the approved artifact");
  if (image.Os !== "linux" || image.Architecture !== architecture) throw new Error("Local image architecture does not match the approved artifact");
  if (image.Config?.Labels?.["org.opencontainers.image.revision"] !== revision || image.Config?.Labels?.["com.myorder.deploy-sha"] !== revision) throw new Error("Local image OCI revision does not match the approved source");
  if (!Array.isArray(image.RepoDigests) || !image.RepoDigests.includes(expected.reference)) throw new Error("Immutable local image digest reference is unavailable");
  return expected.reference;
}

export function validatePinnedComposeImages(config, images) {
  for (const service of ["api", "platform", "migrate"]) {
    if (config?.services?.[service]?.image !== images[service]?.reference) throw new Error(`Resolved ${service} image is not the approved immutable digest`);
  }
  return true;
}

export function pinnedUpArgs(services) {
  return ["up", "--pull", "never", "--no-build", "-d", "--no-deps", ...services];
}

export function pinnedRunArgs(service, entrypoint) {
  return ["run", "--pull", "never", "--rm", "--no-deps", ...(entrypoint ? ["--entrypoint", entrypoint] : []), service];
}

export function validateBuildPolicy({ environment, action, deploySha }) {
  if (environment === "staging" && action === "build" && deploySha === PINNED_CANDIDATE.sha) throw new Error("The approved candidate images are immutable; rebuild is prohibited");
  return true;
}

export function validateActionServices(action, services) {
  if (!ACTIONS.has(action)) throw new Error("Unsupported deployment action");
  if (action === "p0" && services.length !== 0) throw new Error("p0 does not accept service arguments");
  if (action === "stop" && (services.length !== 1 || services[0] !== "api")) {
    throw new Error("stop is restricted to the API service for a controlled migration maintenance window");
  }
  return true;
}

export function validatePlan({ environment, root, project, config, authorization, deploySha, pinnedImages }) {
  if (!(environment in PROJECT)) throw new Error("Unknown deployment environment");
  if (!isApprovedRoot(environment, root)) throw new Error("Unexpected deployment working tree");
  if (project !== PROJECT[environment]) throw new Error("Compose project does not match the selected environment");
  if (config?.name !== PROJECT[environment]) throw new Error("Resolved Compose project does not match the selected environment");
  if (config?.services?.api?.environment?.NODE_ENV !== ENVIRONMENT[environment]) throw new Error("API environment does not match the selected environment");
  const apiEnvironment = config.services.api.environment;
  if (pinnedImages) validatePinnedComposeImages(config, pinnedImages);
  else {
    const imageSha = config.services.api.image?.split(":").at(-1);
    if (!/^[a-f0-9]{40}$/.test(imageSha ?? "") ||
        config.services.api.image !== `myorder-api:${imageSha}` ||
        config.services.platform.image !== `myorder-platform:${imageSha}` ||
        config.services.migrate.image !== `myorder-migrate:${imageSha}` ||
        (deploySha && deploySha !== imageSha)) throw new Error("Compose image SHA does not match the validated release candidate");
  }
  if (environment === "production" && Object.keys(apiEnvironment).some(name => name.startsWith("STAGING_"))) throw new Error("Staging-only settings cannot be attached to production");
  if (environment === "production" && apiEnvironment.WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED !== "true") throw new Error("Production WooCommerce integration policy must be explicitly enabled");
  if (environment === "staging" && (apiEnvironment.PAYPAL_ENVIRONMENT && apiEnvironment.PAYPAL_ENVIRONMENT !== "sandbox" || apiEnvironment.LIVE_PAYMENTS_ENABLED === "true")) throw new Error("Staging cannot enable live payment credentials or mode");
  if (environment === "staging") {
    if (!/^user_[A-Za-z0-9_-]+$/.test(apiEnvironment.MYORDER_OWNER_CLERK_ID ?? "")) throw new Error("Staging owner Clerk configuration is missing or invalid");
    const wooPolicy = apiEnvironment.WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED;
    if (wooPolicy !== "true" && wooPolicy !== "false") throw new Error("Staging WooCommerce external integration policy must be explicit");
    if (wooPolicy === "false" && Object.hasOwn(apiEnvironment, "STAGING_WOOCOMMERCE_ORIGIN")) throw new Error("Disabled staging WooCommerce policy must not render an external store origin");
    if (wooPolicy === "true") validateStagingWooOrigin(apiEnvironment.STAGING_WOOCOMMERCE_ORIGIN);
    if (apiEnvironment.RECEIPT_PRINT_ENABLED === "true" || apiEnvironment.LABEL_PRINT_ENABLED === "true" || apiEnvironment.EMAIL_ENABLED !== "false" || apiEnvironment.SMS_ENABLED !== "false" || apiEnvironment.PUSH_ENABLED !== "false" || apiEnvironment.ORDER_NOTIFICATION_WORKER_ENABLED === "1" || apiEnvironment.UBER_DIRECT_DISPATCH_ENABLED === "true") throw new Error("Staging external side effects must remain disabled during release testing");
  }
  const dbUrl = config.services.api.environment.DATABASE_URL;
  let database;
  let host;
  try {
    const parsed = new URL(dbUrl);
    database = decodeURIComponent(parsed.pathname.slice(1));
    host = parsed.hostname;
  } catch { throw new Error("Invalid API database URL"); }
  if (host !== "db") throw new Error("API database host must be the pinned Compose db service");
  if (database !== DATABASE[environment] || config.services.db.environment.POSTGRES_DB !== DATABASE[environment]) throw new Error("Database target does not match the selected environment");
  let migrationDatabase;
  try { migrationDatabase = new URL(config.services.migrate.environment.DATABASE_URL); } catch { throw new Error("Invalid migration database URL"); }
  if (migrationDatabase.hostname !== "db" || decodeURIComponent(migrationDatabase.pathname.slice(1)) !== DATABASE[environment]) throw new Error("Migration database target does not match the selected environment");
  const expectedNetworks = environment === "staging" ? ["internal"] : null;
  for (const [service, definition] of Object.entries(config.services)) {
    const networkNames = Object.keys(definition.networks ?? {});
    if (environment === "staging" && (networkNames.length !== 1 || networkNames[0] !== expectedNetworks[0])) throw new Error(`Staging ${service} must use only its internal network`);
    if (environment === "production" && networkNames.some(name => !["internal", "external"].includes(name))) throw new Error(`Production ${service} has an unexpected network`);
  }
  const expectedNetworkNames = environment === "staging" ? ["myorder-staging_internal"] : ["deploy_internal", "deploy_external"];
  const actualNetworkNames = Object.values(config.networks ?? {}).map(network => network.name).sort();
  if (actualNetworkNames.length !== expectedNetworkNames.length || actualNetworkNames.some(name => !expectedNetworkNames.includes(name))) throw new Error("Resolved Compose networks do not match the pinned environment");
  const expectedPort = environment === "staging" ? "127.0.0.1:28081:80" : "127.0.0.1:8081:80";
  const [expectedHostIp, expectedHostPort, expectedTargetPort] = expectedPort.split(":");
  if (!(config.services.nginx.ports ?? []).some(port => typeof port === "string"
    ? port.replaceAll("/tcp", "") === expectedPort
    : port.host_ip === expectedHostIp && String(port.published) === expectedHostPort && String(port.target) === expectedTargetPort && (port.protocol ?? "tcp") === "tcp")) throw new Error("Resolved proxy port does not match the pinned environment");
  if (config.volumes?.postgres_data?.name !== `${PROJECT[environment]}_postgres_data`) throw new Error("Resolved database volume does not match the pinned environment");
  if (environment === "production" && authorization !== "DEPLOY-PRODUCTION") throw new Error("Production requires explicit DEPLOY-PRODUCTION authorization");
  if (environment === "staging" && (project === "deploy" || database === "alavont")) throw new Error("Staging cannot target production resources");
  return true;
}

export function validateCandidateIdentity({ root, environment, status, headSha, headTree, deploySha, deployTree, baseInAncestry, worktreeRegistered, toolingSuccessor = false, applicationInAncestry = false, applicationTreeMatches = false, toolingDiffPaths = [] }) {
  if (!isApprovedRoot(environment, root)) throw new Error("Unexpected deployment working tree");
  if (environment === "staging" && worktreeRegistered !== true) throw new Error("Staging source is not a registered Git worktree");
  if (status) throw new Error("Deployment checkout must be clean");
  if (!/^[a-f0-9]{40}$/.test(headSha ?? "") || !/^[a-f0-9]{40}$/.test(headTree ?? "")) throw new Error("Deployment checkout identity is invalid");
  const exactHead = deploySha === headSha && deployTree === headTree;
  const approvedToolingSuccessor = toolingSuccessor && applicationInAncestry && applicationTreeMatches && toolingDiffPaths.length > 0 && toolingDiffPaths.every(file => TOOLING_ONLY_PATHS.has(file));
  if (!exactHead && !approvedToolingSuccessor) throw new Error("Application SHA/tree is not the clean checkout or an approved deployment-tooling-only successor");
  if (environment === "staging" && !baseInAncestry) throw new Error("Deployment candidate is not descended from the authorized release base");
  return deploySha;
}

function isApprovedRoot(environment, root) {
  const resolved = path.resolve(root);
  if (environment === "production") return resolved === ROOTS.production;
  return environment === "staging" && resolved.startsWith(`${WORKTREES_ROOT}/`) && path.dirname(resolved) === WORKTREES_ROOT;
}

export function validateStagingDatabasePreflight({ p0Ready, recognizedLineage, wooExternalEnabled, wooSafeTenantCount }) {
  if (!p0Ready) throw new Error("Staging P0 marker/provenance schema is not verified");
  if (!recognizedLineage) throw new Error("Staging migration lineage is not recognized through 0076");
  if (typeof wooExternalEnabled !== "boolean") throw new Error("Staging WooCommerce external integration policy is not explicit");
  if (wooExternalEnabled && (!Number.isSafeInteger(wooSafeTenantCount) || wooSafeTenantCount < 1)) throw new Error("Staging WooCommerce test integration is missing or required tenant credentials are absent");
  return true;
}

export function validateStagingWooOrigin(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("Staging WooCommerce origin is invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash)
    throw new Error("Staging WooCommerce origin must be a dedicated HTTPS origin");
  return parsed.origin;
}

export function validateContainer({ environment, project, service, labels, envValues = {}, mounts = [], portBindings = {}, networks = {}, composeFile, composeWorkingDir, resolved }) {
  if (labels["com.docker.compose.project"] !== project || labels["com.docker.compose.service"] !== service) throw new Error(`Resolved ${service} container belongs to another project`);
  const sourceFiles = labels["com.docker.compose.project.config_files"]?.split(",").map(value => path.resolve(value.trim())) ?? [];
  const sourceDir = path.resolve(labels["com.docker.compose.project.working_dir"] ?? "");
  if (environment === "production") {
    if (!sourceFiles.includes(path.resolve(composeFile)) || sourceDir !== path.resolve(composeWorkingDir)) throw new Error(`Resolved ${service} container belongs to another production Compose source`);
  } else if (sourceFiles.length !== 1 || path.basename(sourceFiles[0]) !== "docker-compose.staging.yml" || !sourceDir.startsWith("/home/serveradmin/worktrees/") || path.basename(sourceDir) !== "deploy") {
    // Staging may be converging containers created by earlier staging builds;
    // ownership still must be the staging project, and no production checkout
    // or Compose file is accepted as an existing target.
    throw new Error(`Resolved ${service} container is not from a staging Compose source`);
  }
  if (service === "api" && (envValues.NODE_ENV !== ENVIRONMENT[environment] || envValues.DATABASE_URL !== resolved.services.api.environment.DATABASE_URL)) throw new Error("Existing API container environment does not match the selected Compose target");
  if (service === "db") {
    if (envValues.POSTGRES_DB !== DATABASE[environment]) throw new Error("Existing database container is configured for another database");
    const dataMount = mounts.find(mount => mount.Destination === "/var/lib/postgresql/data");
    if (dataMount?.Name !== `${project}_postgres_data`) throw new Error("Database data volume does not match the pinned environment");
  }
  if (service === "nginx") {
    const expected = environment === "production" ? "127.0.0.1:8081" : "127.0.0.1:28081";
    const bindings = Object.entries(portBindings ?? {}).flatMap(([containerPort, rows]) => (rows ?? []).map(row => `${row.HostIp}:${row.HostPort}/${containerPort}`));
    if (!bindings.includes(`${expected}/80/tcp`)) throw new Error("Existing proxy container does not bind the expected environment port");
  }
  const networkNames = Object.keys(networks);
  if (environment === "staging" && (networkNames.length !== 1 || networkNames[0] !== "myorder-staging_internal")) throw new Error("Staging container is attached to an unexpected network");
  if (environment === "production" && networkNames.some(name => !["deploy_internal", "deploy_external"].includes(name))) throw new Error("Production container is attached to an unexpected network");
  return true;
}

function run(command, args, { capture = false, ...options } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: capture ? "pipe" : "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
  return result.stdout ?? "";
}

function verifyImage(expected, revision, daemonId) {
  const raw = run("docker", ["image", "inspect", expected.id, "--format", "{{json .}}"], { capture: true });
  return validatePinnedImageMetadata({ daemonId, image: JSON.parse(raw), expected, revision });
}

function verifyPinnedArtifacts() {
  const daemonId = run("docker", ["info", "--format", "{{.ID}}"], { capture: true }).trim();
  if (daemonId !== EXPECTED_DOCKER_DAEMON_ID) throw new Error("Docker daemon identity does not match the approved staging host");
  const appTree = run("git", ["-C", ROOT, "rev-parse", `${PINNED_CANDIDATE.sha}^{tree}`], { capture: true }).trim();
  if (appTree !== PINNED_CANDIDATE.tree) throw new Error("Pinned candidate source tree identity does not match");
  const rollbackRoot = "/home/serveradmin/worktrees/myorder-pos-rollback-compat";
  const rollbackHead = run("git", ["-C", rollbackRoot, "rev-parse", "HEAD"], { capture: true }).trim();
  const rollbackTree = run("git", ["-C", rollbackRoot, "rev-parse", "HEAD^{tree}"], { capture: true }).trim();
  const rollbackStatus = run("git", ["-C", rollbackRoot, "status", "--porcelain=v1"], { capture: true }).trim();
  if (rollbackHead !== PINNED_ROLLBACK.sha || rollbackTree !== PINNED_ROLLBACK.tree || rollbackStatus) throw new Error("Validated rollback checkout is not exact and clean");
  for (const expected of Object.values(PINNED_CANDIDATE.images)) verifyImage(expected, PINNED_CANDIDATE.sha, daemonId);
  for (const expected of Object.values(PINNED_ROLLBACK.images)) verifyImage(expected, PINNED_ROLLBACK.sha, daemonId);
  return {
    daemonId,
    candidate: PINNED_CANDIDATE,
    rollback: PINNED_ROLLBACK,
    composeEnvironment: {
      MYORDER_API_IMAGE: PINNED_CANDIDATE.images.api.reference,
      MYORDER_PLATFORM_IMAGE: PINNED_CANDIDATE.images.platform.reference,
      MYORDER_MIGRATE_IMAGE: PINNED_CANDIDATE.images.migrate.reference,
    },
  };
}

function verifyDeployedImage(prefix, service, expected, revision) {
  const ids = run("docker", [...prefix, "ps", "--all", "--quiet", service], { capture: true }).trim().split(/\s+/).filter(Boolean);
  if (ids.length !== 1) throw new Error(`Expected one staging ${service} container after deployment`);
  const raw = run("docker", ["inspect", ids[0], "--format", "{{json .}}"], { capture: true });
  const container = JSON.parse(raw);
  if (container.Image !== expected.id || container.Config?.Image !== expected.reference) throw new Error(`Staging ${service} did not start from its approved immutable image`);
  validatePinnedImageMetadata({ daemonId: EXPECTED_DOCKER_DAEMON_ID, image: JSON.parse(run("docker", ["image", "inspect", container.Image, "--format", "{{json .}}"], { capture: true })), expected, revision });
}

function stageQuery(prefix, dbUser, statement) {
  return run("docker", [...prefix, "exec", "-T", "db", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", dbUser, "-d", DATABASE.staging, "-Atc", statement], { capture: true }).trim();
}

function validateStagingBackupEvidence(backupDir, sourceContainer) {
  const root = path.resolve(STAGING_BACKUP_ROOT);
  const resolved = path.resolve(backupDir ?? "");
  if (!resolved.startsWith(`${root}/`)) throw new Error("Verified staging backup evidence is required under the protected release-backups directory");
  const dirStat = lstatSync(resolved);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077) !== 0) throw new Error("Staging backup directory must be a restricted real directory");
  const backupPath = path.join(resolved, "production-snapshot.dump");
  const evidencePath = path.join(resolved, "backup-restore-evidence.txt");
  for (const file of [backupPath, evidencePath]) {
    const fileStat = lstatSync(file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || (fileStat.mode & 0o077) !== 0) throw new Error("Staging backup artifacts must be restricted regular files");
  }
  const evidenceRows = readFileSync(evidencePath, "utf8").split(/\r?\n/).filter(Boolean).map(line => {
    const index = line.indexOf("=");
    if (index < 1) throw new Error("Staging backup evidence is malformed");
    return [line.slice(0, index), line.slice(index + 1)];
  });
  const evidence = Object.fromEntries(evidenceRows);
  if (evidenceRows.length !== Object.keys(evidence).length || evidence.source_container !== sourceContainer || evidence.migration_count_before_rehearsal !== "49" || !/^myorder-release-restore-/.test(evidence.restore_container ?? "") || !/^\d{4}-\d{2}-\d{2}T/.test(evidence.verified_at_utc ?? "")) throw new Error("Verified staging backup evidence does not match this staging database");
  const digest = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
  if (digest !== evidence.backup_sha256) throw new Error("Staging backup checksum does not match its restore evidence");
  return true;
}

function recognizedStagingLineage(prefix, env = process.env) {
  const validator = run("docker", [...prefix, ...pinnedRunArgs("migrate", "pnpm"), "--filter", "@workspace/db", "db:validate-migrations"], { capture: true, env });
  const appliedMigrations = [...validator.matchAll(/\[migration-ledger\] APPLIED ([^ ]+)/g)].map(match => match[1]);
  const hasPendingMigrations = /\[migration-ledger\] PENDING /.test(validator);
  return validator.includes("recognized lineage preserved: 49/51") && appliedMigrations.length === 51 && !hasPendingMigrations && validator.includes("APPLIED 0075_catalogue_variant_attributes ") && validator.includes("APPLIED 0076_tenant_woo_store_url_no_default ");
}

function verifyStagingP0Patch(prefix, resolved) {
  if (resolved.services.api.environment.WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED !== "false") throw new Error("The staging P0 patch action requires external WooCommerce explicitly disabled");
  const dbUser = resolved.services.db.environment.POSTGRES_USER;
  const containerId = run("docker", [...prefix, "ps", "--all", "--quiet", "db"], { capture: true }).trim();
  if (!containerId || containerId.includes("\n")) throw new Error("Expected exactly one staging database container");
  const sourceContainer = run("docker", ["inspect", "--format", "{{.Name}}", containerId], { capture: true }).trim().replace(/^\//, "");
  validateStagingBackupEvidence(process.env.MYORDER_STAGING_BACKUP_DIR, sourceContainer);
  if (!recognizedStagingLineage(prefix)) throw new Error("Staging migration lineage is not recognized through 0076");

  const p0Absent = stageQuery(prefix, dbUser, "SELECT to_regclass('public.myorder_hotfix_migrations') IS NULL AND to_regclass('public.users_owner_approval_provenance_idx') IS NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name IN ('approved_at','approved_by_clerk_id'))");
  if (p0Absent !== "t") throw new Error("Staging P0 objects are not wholly absent; refusing compatibility patch");
  const ledgerFingerprint = () => stageQuery(prefix, dbUser, "SELECT count(*)::text || ':' || md5(coalesce(string_agg(id::text || ':' || hash || ':' || created_at::text, '|' ORDER BY created_at, id), '')) FROM drizzle.__drizzle_migrations");
  const ledgerBefore = ledgerFingerprint();
  if (!ledgerBefore.startsWith("49:")) throw new Error("Staging migration ledger count does not match the recognized 49-row lineage");

  const patchPath = path.join(ROOT, "deploy", "hotfix-owner-approval.sql");
  const patch = readFileSync(patchPath);
  if (createHash("sha256").update(patch).digest("hex") !== P0_PATCH_SHA256) throw new Error("Approved P0 compatibility patch checksum mismatch");
  const applied = spawnSync("docker", [...prefix, "exec", "-i", "db", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", dbUser, "-d", DATABASE.staging], { input: patch, encoding: "utf8" });
  if (applied.error) throw applied.error;
  if (applied.status !== 0) throw new Error(`Approved staging P0 patch failed with status ${applied.status}`);

  const p0Ready = stageQuery(prefix, dbUser, "SELECT (SELECT count(*) FROM public.myorder_hotfix_migrations)=1 AND (SELECT count(*) FROM public.myorder_hotfix_migrations WHERE migration_id='p0_owner_approval_provenance')=1 AND to_regclass('public.users_owner_approval_provenance_idx') IS NOT NULL AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='approved_at' AND data_type='timestamp with time zone' AND is_nullable='YES')=1 AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='approved_by_clerk_id' AND data_type='text' AND is_nullable='YES')=1 AND EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='users_owner_approval_provenance_idx' AND i.indisvalid AND i.indisready AND pg_get_expr(i.indpred, i.indrelid) = '(status = ''approved''::text)')");
  if (p0Ready !== "t") throw new Error("Staging P0 marker/provenance verification failed after patch");
  if (ledgerFingerprint() !== ledgerBefore) throw new Error("Staging Drizzle migration ledger changed during P0 compatibility patch");
  console.log("Staging P0 patch applied and verified; recognized 49-row ledger unchanged.");
}

function verifyStagingMutationPreflight(prefix, resolved, env) {
  const dbUser = resolved.services.db.environment.POSTGRES_USER;
  const markerTableExists = stageQuery(prefix, dbUser, "SELECT to_regclass('public.myorder_hotfix_migrations') IS NOT NULL");
  let p0Ready = false;
  if (markerTableExists === "t") {
    const marker = stageQuery(prefix, dbUser, "SELECT (SELECT count(*) FROM public.myorder_hotfix_migrations WHERE migration_id='p0_owner_approval_provenance')=1 AND to_regclass('public.users_owner_approval_provenance_idx') IS NOT NULL AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='approved_at' AND data_type='timestamp with time zone' AND is_nullable='YES')=1 AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='approved_by_clerk_id' AND data_type='text' AND is_nullable='YES')=1 AND EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='users_owner_approval_provenance_idx' AND i.indisvalid AND i.indisready AND pg_get_expr(i.indpred, i.indrelid) = '(status = ''approved''::text)')");
    p0Ready = marker === "t";
  }
  if (!p0Ready) throw new Error("Staging P0 marker/provenance schema is not verified");
  const wooExternalEnabled = resolved.services.api.environment.WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED === "true";
  let wooSafeTenantCount = null;
  if (wooExternalEnabled) {
    const expectedWooOrigin = validateStagingWooOrigin(resolved.services.api.environment.STAGING_WOOCOMMERCE_ORIGIN);
    const escapedOrigin = expectedWooOrigin.replaceAll("'", "''");
    wooSafeTenantCount = Number(stageQuery(prefix, dbUser, `SELECT count(*) FROM public.admin_settings WHERE wc_store_url='${escapedOrigin}' AND wc_webhook_secret IS NOT NULL AND wc_consumer_key IS NOT NULL AND wc_consumer_secret IS NOT NULL`));
  }
  const recognizedLineage = recognizedStagingLineage(prefix, env);
  validateStagingDatabasePreflight({ p0Ready, recognizedLineage, wooExternalEnabled, wooSafeTenantCount });
}

function main() {
  const [environment, action, ...rest] = process.argv.slice(2);
  if (!ACTIONS.has(action)) throw new Error("Usage: safe-compose.mjs <staging|production> <config|build|up|migrate|p0|bootstrap|stop> [services] [--authorize-production]");
  if (!(environment in PROJECT)) throw new Error("Unknown deployment environment");
  if (action === "p0" && environment !== "staging") throw new Error("The P0 compatibility patch action is staging-only");
  const authorization = rest.includes("--authorize-production") && process.env.PRODUCTION_DEPLOY_CONFIRMATION === "DEPLOY-PRODUCTION" ? "DEPLOY-PRODUCTION" : undefined;
  if (rest.includes("--authorize-production") && !authorization) throw new Error("Production authorization flag and confirmation must both be present");
  if (environment === "production" && !authorization) throw new Error("Production requires explicit authorization before Compose can be resolved");
  if (!isApprovedRoot(environment, ROOT)) throw new Error("Unexpected deployment working tree");
  const headSha = run("git", ["-C", ROOT, "rev-parse", "HEAD"], { capture: true }).trim();
  const headTree = run("git", ["-C", ROOT, "rev-parse", "HEAD^{tree}"], { capture: true }).trim();
  const status = run("git", ["-C", ROOT, "status", "--porcelain=v1"], { capture: true }).trim();
  const worktrees = run("git", ["-C", ROOT, "worktree", "list", "--porcelain"], { capture: true });
  const worktreeRegistered = worktrees.split("\n").some(line => line.startsWith("worktree ") && path.resolve(line.slice("worktree ".length)) === path.resolve(ROOT));
  const baseInAncestry = environment !== "staging" || spawnSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", RELEASE_BASE_SHA, "HEAD"], { stdio: "ignore" }).status === 0;
  const deploySha = process.env.DEPLOY_SHA?.trim();
  const deployTree = process.env.DEPLOY_TREE?.trim();
  const exactToolingCandidate = deploySha === headSha;
  const applicationInAncestry = !exactToolingCandidate && spawnSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", deploySha ?? "", "HEAD"], { stdio: "ignore" }).status === 0;
  const applicationTreeMatches = !exactToolingCandidate && deploySha ? spawnSync("git", ["-C", ROOT, "rev-parse", `${deploySha}^{tree}`], { encoding: "utf8" }).stdout?.trim() === deployTree : false;
  const toolingDiffPaths = !exactToolingCandidate && deploySha ? run("git", ["-C", ROOT, "diff", "--name-only", `${deploySha}..HEAD`], { capture: true }).trim().split("\n").filter(Boolean) : [];
  process.env.DEPLOY_SHA = validateCandidateIdentity({ root: ROOT, environment, status, headSha, headTree, deploySha, deployTree, baseInAncestry, worktreeRegistered, toolingSuccessor: !exactToolingCandidate, applicationInAncestry, applicationTreeMatches, toolingDiffPaths });
  const services = rest.filter(arg => arg !== "--authorize-production");
  validateActionServices(action, services);
  if (services.some(service => !["db", "api", "platform", "nginx"].includes(service))) throw new Error("Service is not in the deployment allowlist");
  if (action === "up" && (!services.length || services.some(service => !["db", "api", "platform", "nginx"].includes(service)))) throw new Error("up requires an explicit allowlisted service list");
  if (environment === "staging" && action === "up" && (services.length !== 2 || !services.includes("api") || !services.includes("platform"))) throw new Error("Pinned staging release up is restricted to the API and platform services");
  if ((action === "migrate" || action === "p0") && services.length) throw new Error(`${action} does not accept service arguments`);
  if ((action === "bootstrap" || action === "build" || action === "config") && services.length) throw new Error(`${action} does not accept service arguments`);

  const project = PROJECT[environment];
  const composeFile = path.join(ROOT, "deploy", environment === "production" ? "docker-compose.yml" : "docker-compose.staging.yml");
  const envFile = environment === "production" ? path.join(ROOT, "deploy", ".env") : process.env.MYORDER_STAGING_ENV_FILE;
  if (typeof envFile !== "string" || !path.isAbsolute(envFile)) throw new Error("MYORDER_STAGING_ENV_FILE must point to the protected staging environment file");
  if (!existsSync(composeFile) || !existsSync(envFile)) throw new Error("Expected Compose file or environment file is missing");
  if (environment === "staging" && (statSync(envFile).mode & 0o077) !== 0) throw new Error("Staging environment file permissions must restrict group and other access");
  const prefix = ["compose", "--project-name", project, "--env-file", envFile, "--file", composeFile];
  const composeEnv = { ...process.env };
  delete composeEnv.MYORDER_API_IMAGE;
  delete composeEnv.MYORDER_PLATFORM_IMAGE;
  delete composeEnv.MYORDER_MIGRATE_IMAGE;
  let resolved = JSON.parse(run("docker", [...prefix, "config", "--format", "json"], { capture: true, env: composeEnv }));
  validatePlan({ environment, root: ROOT, project, config: resolved, authorization, deploySha: process.env.DEPLOY_SHA });
  let pins;
  let pinnedEnv;
  if (environment === "staging" && (action === "up" || action === "migrate")) {
    if (process.env.DEPLOY_SHA !== PINNED_CANDIDATE.sha || process.env.DEPLOY_TREE !== PINNED_CANDIDATE.tree) throw new Error("Pinned local images are approved only for the validated candidate commit/tree");
    pins = verifyPinnedArtifacts();
    pinnedEnv = { ...composeEnv, ...pins.composeEnvironment };
    resolved = JSON.parse(run("docker", [...prefix, "config", "--format", "json"], { capture: true, env: pinnedEnv }));
    validatePlan({ environment, root: ROOT, project, config: resolved, authorization, deploySha: process.env.DEPLOY_SHA, pinnedImages: PINNED_CANDIDATE.images });
  }
  validateBuildPolicy({ environment, action, deploySha: process.env.DEPLOY_SHA });

  if (action === "bootstrap") {
    const existing = ["db", "api", "platform", "nginx"].flatMap(service => run("docker", [...prefix, "ps", "--all", "--quiet", service], { capture: true }).trim().split(/\s+/).filter(Boolean));
    if (existing.length) throw new Error("Bootstrap requires an empty project; existing target containers need normal guarded deployment");
    const projectContainers = run("docker", ["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`], { capture: true }).trim();
    if (projectContainers) throw new Error("Bootstrap refused because project-labeled containers already exist");
    const volume = spawnSync("docker", ["volume", "inspect", `${project}_postgres_data`], { encoding: "utf8", stdio: "ignore" });
    if (volume.status === 0) throw new Error("Bootstrap refused because the environment database volume already exists");
    if (volume.error || volume.status !== 1) throw new Error("Could not safely determine whether the environment database volume exists");
    if (environment === "production" && !authorization) throw new Error("Production bootstrap requires explicit authorization");
    run("docker", [...prefix, "build"]);
    run("docker", [...prefix, "up", "-d", "db"]);
    run("docker", [...prefix, "run", "--rm", "migrate"]);
    run("docker", [...prefix, "up", "-d", "api", "platform", "nginx"]);
    return;
  }

  // Every deployed service container must already belong to this exact
  // project/service pair and have been created from the selected Compose file.
  for (const service of ["db", "api", "platform", "nginx"]) {
    const ids = run("docker", [...prefix, "ps", "--all", "--quiet", service], { capture: true }).trim().split(/\s+/).filter(Boolean);
    if (ids.length !== 1) throw new Error(`Expected exactly one existing ${service} container in the selected project`);
    const labels = JSON.parse(run("docker", ["inspect", "--format", "{{json .Config.Labels}}", ids[0]], { capture: true }));
    const containerData = {};
    if (service === "api" || service === "db") {
      const entries = JSON.parse(run("docker", ["inspect", "--format", "{{json .Config.Env}}", ids[0]], { capture: true }));
      containerData.envValues = Object.fromEntries(entries.map(entry => { const index = entry.indexOf("="); return [entry.slice(0, index), entry.slice(index + 1)]; }));
    }
    if (service === "db") {
      containerData.mounts = JSON.parse(run("docker", ["inspect", "--format", "{{json .Mounts}}", ids[0]], { capture: true }));
    }
    if (service === "nginx") {
      containerData.portBindings = JSON.parse(run("docker", ["inspect", "--format", "{{json .HostConfig.PortBindings}}", ids[0]], { capture: true }));
    }
    containerData.networks = JSON.parse(run("docker", ["inspect", "--format", "{{json .NetworkSettings.Networks}}", ids[0]], { capture: true }));
    validateContainer({ environment, project, service, labels, composeFile, composeWorkingDir: path.join(ROOT, "deploy"), resolved, ...containerData });
  }

  if (environment === "staging" && action === "p0") {
    verifyStagingP0Patch(prefix, resolved);
    return;
  }
  if (environment === "staging" && action !== "config") {
    verifyStagingMutationPreflight(prefix, resolved, pinnedEnv ?? composeEnv);
  }

  if (action === "config") return;
  if (environment === "production" && !authorization) throw new Error("Production action requires explicit authorization");
  if (action === "stop") run("docker", [...prefix, "stop", ...services]);
  if (action === "build") run("docker", [...prefix, "build"]);
  if (action === "up") {
    if (environment === "staging") {
      verifyPinnedArtifacts();
      run("docker", [...prefix, ...pinnedUpArgs(services)], { env: pinnedEnv });
      for (const service of services) verifyDeployedImage(prefix, service, PINNED_CANDIDATE.images[service], PINNED_CANDIDATE.sha);
    } else run("docker", [...prefix, "up", "-d", "--no-deps", ...services]);
  }
  if (action === "migrate") {
    if (environment === "staging") {
      verifyPinnedArtifacts();
      run("docker", [...prefix, ...pinnedRunArgs("migrate")], { env: pinnedEnv });
    } else run("docker", [...prefix, "run", "--rm", "migrate"]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Deployment refused: ${error instanceof Error ? error.message : "unknown error"}`); process.exitCode = 1; }
}
