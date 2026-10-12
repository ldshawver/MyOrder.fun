#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FROZEN_RELEASE = Object.freeze({
  sha: "65a85f2f82daf9f30a07f1a2de13092d5be80360",
  tree: "0411a10aa3326308bc480ff2fd15ecca037419bf",
});
export const ROLLBACK_SHA = "579cce225c0f9e7bee41a4c226d43e5ba5c86606";
export const PRODUCTION = Object.freeze({
  root: "/opt/alavont",
  project: "deploy",
  database: "alavont",
  dbService: "db",
  apiService: "api",
  safeServices: ["db", "api", "platform", "nginx", "migrate"],
});

export const PRODUCTION_STEPS = Object.freeze([
  "validate",
  "build",
  "validate-lineage",
  "verify-writer-inventory",
  "stop-writers",
  "verify-writers-stopped",
  "snapshot",
  "verify-snapshot",
  "restore-rehearsal",
  "migrate",
  "verify-migration",
  "start-api",
  "verify-api",
  "start-platform-proxy",
  "smoke",
]);

export const EXPECTED_PRODUCTION_MIGRATIONS = Object.freeze([
  "0068_print_jobs_document_job_types",
  "0069_inventory_tenant_quantity_foundation",
  "0070_catalogue_products_options_reorder",
  "0071_refund_state_constraint_reconciliation",
  "0072_order_created_notifications",
  "0073_admin_settings_tenant_uniqueness",
  "0074_tenant_slug_case_insensitive_unique",
]);

export function assertRelease({
  sha,
  tree,
  releaseRoot,
  archivePath,
  archiveSha256,
}) {
  if (sha !== FROZEN_RELEASE.sha || tree !== FROZEN_RELEASE.tree)
    throw new Error("Release identity is not the frozen Release 1 commit/tree");
  const expectedRoot = path.join(
    PRODUCTION.root,
    "releases",
    FROZEN_RELEASE.sha,
  );
  if (path.resolve(releaseRoot) !== expectedRoot)
    throw new Error(
      "Production release directory does not match the pinned release SHA",
    );
  const incomingRoot = path.join(PRODUCTION.root, "incoming") + path.sep;
  if (!path.resolve(archivePath).startsWith(incomingRoot))
    throw new Error(
      "Release archive must be in the production incoming directory",
    );
  if (!/^[a-f0-9]{64}$/.test(archiveSha256))
    throw new Error("Invalid release archive checksum");
  return true;
}

export function assertProductionConfig(config, expected) {
  if (config?.name !== PRODUCTION.project)
    throw new Error("Production Compose project mismatch");
  const api = config.services?.api?.environment ?? {};
  const db = config.services?.db?.environment ?? {};
  const migrationUrl = config.services?.migrate?.environment?.DATABASE_URL;
  const apiUrl = api.DATABASE_URL;
  for (const [label, raw] of [
    ["API", apiUrl],
    ["migration", migrationUrl],
  ]) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`${label} database URL is invalid`);
    }
    if (
      parsed.hostname !== "db" ||
      decodeURIComponent(parsed.pathname.slice(1)) !== PRODUCTION.database
    )
      throw new Error(
        `${label} does not target the production database service`,
      );
  }
  if (api.NODE_ENV !== "production" || db.POSTGRES_DB !== PRODUCTION.database)
    throw new Error("Production environment/database mismatch");
  if (db.POSTGRES_USER !== "alavont_user")
    throw new Error("Production PostgreSQL role mismatch");
  for (const name of [
    "DATABASE_URL",
    "CLERK_SECRET_KEY",
    "CLERK_PUBLISHABLE_KEY",
    "SESSION_SECRET",
    "SETTINGS_ENC_KEY",
  ]) {
    if (typeof api[name] !== "string" || api[name].trim() === "")
      throw new Error(`Required production setting is missing: ${name}`);
  }
  if (
    typeof db.POSTGRES_PASSWORD !== "string" ||
    db.POSTGRES_PASSWORD.trim() === ""
  )
    throw new Error("Production PostgreSQL password setting is missing");
  if (
    api.PAYMENT_MODE !== "disabled" ||
    [
      api.PAYPAL_ENVIRONMENT,
      api.PAYPAL_CLIENT_ID,
      api.PAYPAL_CLIENT_SECRET,
      api.PAYPAL_WEBHOOK_ID,
    ].some((value) => String(value ?? "").trim() !== "")
  ) {
    throw new Error(
      "Release 1 production online payments must remain fail-closed until production PayPal is explicitly configured",
    );
  }
  if (
    String(api.UBER_DIRECT_DISPATCH_ENABLED ?? "false").toLowerCase() === "true"
  )
    throw new Error("Production automatic Uber dispatch must remain disabled");
  if (config.volumes?.postgres_data?.name !== "deploy_postgres_data")
    throw new Error("Production database volume mismatch");
  if (
    !(config.services.nginx.ports ?? []).some(
      (port) =>
        port === "127.0.0.1:8081:80" ||
        (port.host_ip === "127.0.0.1" &&
          String(port.published) === "8081" &&
          String(port.target) === "80"),
    )
  )
    throw new Error("Production proxy binding mismatch");
  const networkNames = Object.values(config.networks ?? {})
    .map((network) => network.name)
    .sort();
  if (
    JSON.stringify(networkNames) !==
    JSON.stringify(["deploy_external", "deploy_internal"])
  )
    throw new Error("Production Compose network names mismatch");
  if (expected?.apiImage && config.services.api.image !== expected.apiImage)
    throw new Error("API image does not match frozen release SHA");
  if (
    expected?.platformImage &&
    config.services.platform.image !== expected.platformImage
  )
    throw new Error("Platform image does not match frozen release SHA");
  return true;
}

/** Sequential deployment state machine. Each action is awaited; any failure prevents all later actions. */
export async function executeProductionSequence(actions) {
  for (const name of PRODUCTION_STEPS) {
    if (typeof actions[name] !== "function")
      throw new Error(`Missing production deployment action: ${name}`);
    await actions[name]();
  }
}

export function mayRestoreRollbackApi({ apiStopAttempted, migrationStarted }) {
  return apiStopAttempted === true && migrationStarted === false;
}

export function assertNoEncryptedProductionPayPalSettings(count) {
  if (count !== 0)
    throw new Error(
      "Production has tenant PayPal configuration; refusing this release until provider readiness is reviewed",
    );
  return true;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${path.basename(command)} failed with status ${result.status}`,
    );
  return result.stdout ?? "";
}

function sha256File(filename) {
  const hash = createHash("sha256");
  const input = createReadStream(filename);
  return new Promise((resolve, reject) => {
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function assertRealFilesystemPath(filename, expectedType) {
  const absolute = path.resolve(filename);
  const root = path.parse(absolute).root;
  const segments = path
    .relative(root, absolute)
    .split(path.sep)
    .filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const info = lstatSync(current);
    if (info.isSymbolicLink())
      throw new Error(`Deployment path contains a symlink: ${current}`);
    if (index < segments.length - 1 && !info.isDirectory())
      throw new Error(`Deployment path parent is not a directory: ${current}`);
  }
  const leaf = lstatSync(absolute);
  if (expectedType === "directory" && !leaf.isDirectory())
    throw new Error(`Deployment path is not a directory: ${absolute}`);
  if (expectedType === "file" && !leaf.isFile())
    throw new Error(`Deployment path is not a regular file: ${absolute}`);
  if (realpathSync(absolute) !== absolute)
    throw new Error(
      `Deployment path does not resolve to its pinned location: ${absolute}`,
    );
  return absolute;
}

function assertProductionFilesystemLayout({
  controlRoot,
  envFile,
  overlayFile,
  archivePath,
  toolingSha,
}) {
  assertRealFilesystemPath(PRODUCTION.root, "directory");
  for (const directory of ["incoming", "releases", "control", "shared"])
    assertRealFilesystemPath(
      path.join(PRODUCTION.root, directory),
      "directory",
    );
  if (controlRoot !== path.join(PRODUCTION.root, "control", toolingSha))
    throw new Error(
      "Deployment controller is outside its versioned production control directory",
    );
  assertRealFilesystemPath(controlRoot, "directory");
  assertRealFilesystemPath(envFile, "file");
  assertRealFilesystemPath(overlayFile, "file");
  assertRealFilesystemPath(archivePath, "file");
}

function composeArgs(releaseRoot, envFile, overlayFile) {
  return [
    "compose",
    "--project-name",
    PRODUCTION.project,
    "--env-file",
    envFile,
    "--file",
    path.join(releaseRoot, "deploy/docker-compose.yml"),
    "--file",
    overlayFile,
  ];
}

function validateComposeRuntimeConfig(releaseRoot, envFile, overlayFile) {
  const args = composeArgs(releaseRoot, envFile, overlayFile);
  const output = run("docker", [...args, "config", "--format", "json"], {
    env: { ...process.env, DEPLOY_SHA: FROZEN_RELEASE.sha },
  });
  const config = JSON.parse(output);
  assertProductionConfig(config, {
    apiImage: `myorder-api:${FROZEN_RELEASE.sha}`,
    platformImage: `myorder-platform:${FROZEN_RELEASE.sha}`,
  });
  if (
    config.services.api.volumes?.some((value) =>
      (typeof value === "string"
        ? value.split(":")[0]
        : value.source
      )?.startsWith("/opt/alavont/releases/"),
    )
  )
    throw new Error(
      "Application writable data cannot be mounted from a disposable release directory",
    );
  if (
    !config.services.api.volumes?.some((value) =>
      typeof value === "string"
        ? value.includes(
            "/opt/alavont/shared/print-assets:/var/lib/myorder/print-assets",
          )
        : value.source === "/opt/alavont/shared/print-assets" &&
          value.target === "/var/lib/myorder/print-assets",
    )
  )
    throw new Error("Persistent print asset mount is missing");
  return { args, config };
}

function query(compose, sql, env = {}) {
  return run(
    "docker",
    [
      ...compose.args,
      "exec",
      "-T",
      "db",
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      String(compose.config.services.db.environment.POSTGRES_USER),
      "-d",
      PRODUCTION.database,
      "-Atc",
      sql,
    ],
    { env: { ...process.env, DEPLOY_SHA: FROZEN_RELEASE.sha, ...env } },
  ).trim();
}

function verifyWriterSet(compose) {
  const rows = run("docker", [
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${PRODUCTION.project}`,
  ])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const observed = [];
  const idsByService = new Map();
  for (const id of rows) {
    const inspected = JSON.parse(run("docker", ["inspect", id]));
    const container = inspected[0];
    const labels = container.Config.Labels ?? {};
    if (labels["com.docker.compose.project"] !== PRODUCTION.project) continue;
    const service = labels["com.docker.compose.service"];
    observed.push(service);
    idsByService.set(service, {
      id,
      restartCount: container.RestartCount,
      oomKilled: container.State?.OOMKilled,
      running: container.State?.Running,
      image: container.Config?.Image,
    });
  }
  const expected = ["api", "db", "migrate", "nginx", "platform"].sort();
  if (JSON.stringify(observed.sort()) !== JSON.stringify(expected))
    throw new Error(
      `Unexpected production project services; expected ${expected.join(",")}`,
    );
  if (idsByService.get("api")?.image !== `myorder-api:${ROLLBACK_SHA}`)
    throw new Error("Current production API is not the recorded rollback SHA");
  if (
    idsByService.get("platform")?.image !== `myorder-platform:${ROLLBACK_SHA}`
  )
    throw new Error(
      "Current production platform is not the recorded rollback SHA",
    );
  if (idsByService.get("migrate")?.running)
    throw new Error("A production migration container is already running");
  for (const id of run("docker", ["ps", "--all", "--quiet"])
    .trim()
    .split(/\s+/)
    .filter(Boolean)) {
    const inspected = JSON.parse(run("docker", ["inspect", id]))[0];
    const container = inspected.Config ?? {};
    const env = Object.fromEntries(
      (container.Env ?? []).map((item) => {
        const pos = item.indexOf("=");
        return [item.slice(0, pos), item.slice(pos + 1)];
      }),
    );
    const rawUrl = env.DATABASE_URL;
    if (!rawUrl) continue;
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      continue;
    }
    const networkNames = Object.keys(inspected.NetworkSettings?.Networks ?? {});
    const targetDb = decodeURIComponent(parsed.pathname.slice(1));
    const project = container.Labels?.["com.docker.compose.project"];
    const service = container.Labels?.["com.docker.compose.service"];
    if (
      targetDb === PRODUCTION.database &&
      parsed.hostname === "db" &&
      networkNames.includes("deploy_internal") &&
      !(project === PRODUCTION.project && ["api", "migrate"].includes(service))
    ) {
      throw new Error(
        `Unapproved database writer container is attached to production: ${container.Name ?? "unknown"}`,
      );
    }
    if (
      targetDb === PRODUCTION.database &&
      parsed.hostname === "db" &&
      networkNames.includes("deploy_internal") &&
      project === PRODUCTION.project &&
      service === "migrate" &&
      inspected.State?.Running
    )
      throw new Error("A production migration container is already running");
  }
  const externalWriters = run(
    "sh",
    [
      "-lc",
      "systemctl list-units --all --type=service --no-legend --plain | awk 'tolower($0) ~ /(myorder|alavont).*active/ {print $1}'; systemctl list-timers --all --no-legend --plain | awk 'tolower($0) ~ /(myorder|alavont)/ {print $1}'; grep -RIlE '/opt/alavont|myorder|alavont' /etc/crontab /etc/cron.d /etc/cron.hourly /etc/cron.daily /var/spool/cron/crontabs 2>/dev/null | grep -vE '/(certbot|logrotate|e2scrub|sysstat)' || true",
    ],
    { encoding: "utf8" },
  ).trim();
  if (externalWriters)
    throw new Error(
      `Potential external production writer/scheduler exists: ${externalWriters}`,
    );
  return idsByService;
}

function stopAndVerifyWriters(compose) {
  const apiId = run("docker", [
    ...compose.args,
    "ps",
    "--all",
    "--quiet",
    "api",
  ]).trim();
  if (!apiId)
    throw new Error(
      "Production API container disappeared during writer shutdown",
    );
  const running = run("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    apiId,
  ]).trim();
  if (running !== "false")
    throw new Error("Production API writer did not stop");
  const nginxId = run("docker", [
    ...compose.args,
    "ps",
    "--all",
    "--quiet",
    "nginx",
  ]).trim();
  if (
    !nginxId ||
    run("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      nginxId,
    ]).trim() !== "false"
  )
    throw new Error(
      "Production ingress proxy did not stop; refusing snapshot/migration",
    );
  const sessions = query(
    compose,
    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid <> pg_backend_pid() AND backend_type='client backend'",
  );
  if (sessions !== "0")
    throw new Error(
      `Production database still has ${sessions} client connections; refusing snapshot/migration`,
    );
}

function verifyProductionPayPalDisabled(compose) {
  if (compose.config.services.api.environment.PAYMENT_MODE !== "disabled")
    throw new Error("Production PayPal mode is not disabled");
  const encryptedSettings = query(
    compose,
    "SELECT count(*) FROM admin_settings WHERE merchant_processor_config IS NOT NULL AND merchant_processor_config::jsonb ? 'paypalRuntimeCiphertext'",
  );
  assertNoEncryptedProductionPayPalSettings(Number(encryptedSettings));
}

function safePrintAssetsCopy(compose, sharedRoot) {
  const apiId = run("docker", [
    ...compose.args,
    "ps",
    "--all",
    "--quiet",
    "api",
  ]).trim();
  if (!apiId)
    throw new Error(
      "Existing API container missing; cannot preserve print assets",
    );
  const destination = path.join(sharedRoot, "print-assets");
  if (existsSync(destination))
    assertRealFilesystemPath(destination, "directory");
  mkdirSync(destination, { recursive: true, mode: 0o750 });
  chmodSync(destination, 0o750);
  const temp = path.join(sharedRoot, `.print-assets-import-${process.pid}`);
  if (existsSync(temp))
    throw new Error("Print-asset import temporary path already exists");
  mkdirSync(temp, { mode: 0o700 });
  try {
    const copied = spawnSync(
      "docker",
      ["cp", `${apiId}:/var/lib/myorder/print-assets/.`, temp],
      { encoding: "utf8" },
    );
    if (copied.status !== 0) {
      rmSync(temp, { recursive: true, force: true });
      if (
        /could not find the file|no such file or directory/i.test(
          copied.stderr ?? "",
        )
      )
        return;
      throw new Error(
        "Could not safely inspect existing print assets in the stopped API container",
      );
    }
    const entries = run("find", [temp, "-type", "l", "-print"]).trim();
    if (entries)
      throw new Error("Unexpected symlink in existing print asset tree");
    const result = run("node", [
      "-e",
      `const fs=require('node:fs'),p=require('node:path'),crypto=require('node:crypto');const src=${JSON.stringify(temp)},dst=${JSON.stringify(destination)};function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const s=p.join(d,e.name),r=p.relative(src,s),t=p.join(dst,r);if(e.isDirectory()){fs.mkdirSync(t,{recursive:true,mode:0o750});walk(s)}else if(e.isFile()){const b=fs.readFileSync(s),h=crypto.createHash('sha256').update(b).digest('hex');if(!/^\\d+\\/[a-f0-9]{64}\\.(png|jpg|webp)$/.test(r))throw Error('unexpected asset path');if(fs.existsSync(t)){if(!fs.readFileSync(t).equals(b))throw Error('existing print asset differs')}else{fs.mkdirSync(p.dirname(t),{recursive:true,mode:0o750});fs.writeFileSync(t,b,{flag:'wx',mode:0o640})}if(!r.includes(h))throw Error('asset content hash mismatch')}}}walk(src)`,
    ]);
    void result;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function createSnapshot(compose, backupRoot) {
  const releaseRoot = path.join(
    PRODUCTION.root,
    "releases",
    FROZEN_RELEASE.sha,
  );
  if (path.resolve(backupRoot).startsWith(releaseRoot + path.sep))
    throw new Error("Snapshot path cannot be inside the disposable release");
  assertRealFilesystemPath(path.dirname(backupRoot), "directory");
  if (existsSync(backupRoot)) assertRealFilesystemPath(backupRoot, "directory");
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  assertRealFilesystemPath(backupRoot, "directory");
  const stat = statSync(backupRoot);
  if ((stat.mode & 0o077) !== 0)
    throw new Error(
      "Snapshot directory permissions must deny group/other access",
    );
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "")
    .replaceAll("-", "")
    .replace(/\.\d{3}/, "");
  const archive = path.join(
    backupRoot,
    `alavont-before-${FROZEN_RELEASE.sha}-${stamp}.dump`,
  );
  const partial = `${archive}.partial`;
  const dbUser = String(compose.config.services.db.environment.POSTGRES_USER);
  const identity = query(
    compose,
    `SELECT current_database() || '|' || current_user || '|' || current_setting('server_version')`,
  );
  if (!identity.startsWith(`${PRODUCTION.database}|${dbUser}|`))
    throw new Error("Snapshot database identity mismatch");
  const ledger = query(
    compose,
    "SELECT id || '|' || hash || '|' || created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at,id",
  );
  if (ledger.split("\n").length !== 42)
    throw new Error(
      "Expected the recognized 42-row pre-release production ledger",
    );
  const counts = query(
    compose,
    "SELECT 'orders='||(SELECT count(*) FROM orders)||';inventory_transaction_log='||(SELECT count(*) FROM inventory_transaction_log)||';inventory_reservations='||(SELECT count(*) FROM inventory_reservations)||';inventory_balances='||(SELECT count(*) FROM inventory_balances)||';catalog_items='||(SELECT count(*) FROM catalog_items)||';order_items='||(SELECT count(*) FROM order_items)",
  );
  const fd = openSync(partial, "wx", 0o600);
  try {
    const result = spawnSync(
      "docker",
      [
        ...compose.args,
        "exec",
        "-T",
        "db",
        "pg_dump",
        "-U",
        dbUser,
        "-d",
        PRODUCTION.database,
        "--format=custom",
        "--no-owner",
        "--no-acl",
      ],
      {
        env: { ...process.env, DEPLOY_SHA: FROZEN_RELEASE.sha },
        stdio: ["ignore", fd, "pipe"],
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`pg_dump failed with status ${result.status}`);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
  if (statSync(partial).size === 0)
    throw new Error("Production snapshot archive is empty");
  const tocFd = openSync(`${archive}.toc`, "wx", 0o600);
  const tocInputFd = openSync(partial, "r");
  const toc = spawnSync(
    "docker",
    [...compose.args, "exec", "-T", "db", "pg_restore", "--list", "-"],
    {
      env: { ...process.env, DEPLOY_SHA: FROZEN_RELEASE.sha },
      stdio: [tocInputFd, tocFd, "pipe"],
    },
  );
  closeSync(tocInputFd);
  closeSync(tocFd);
  if (toc.error || toc.status !== 0 || statSync(`${archive}.toc`).size === 0)
    throw new Error("Production snapshot archive inspection failed");
  const digest = createHash("sha256")
    .update(readFileSync(partial))
    .digest("hex");
  writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(
    `${archive}.metadata.json`,
    `${JSON.stringify({ sourceSha: ROLLBACK_SHA, targetSha: FROZEN_RELEASE.sha, targetTree: FROZEN_RELEASE.tree, productionProject: PRODUCTION.project, database: PRODUCTION.database, databaseIdentity: identity, ledgerRows: 42, ledger, representativeCounts: counts, archiveSha256: digest, capturedAt: new Date().toISOString() }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  chmodSync(partial, 0o600);
  renameSync(partial, archive);
  return { archive, digest, ledger, identity, counts };
}

function restoreSnapshotInIsolation(snapshot) {
  const name = `myorder-release1-restore-${process.pid}-${Date.now()}`;
  if (spawnSync("docker", ["inspect", name], { stdio: "ignore" }).status === 0)
    throw new Error("Unique isolated recovery container name already exists");
  run("docker", [
    "run",
    "--detach",
    "--rm",
    "--network",
    "none",
    "--pull=never",
    "--name",
    name,
    "--label",
    "com.myorder.recovery-test=true",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e",
    "POSTGRES_DB=alavont_recovery",
    "postgres:16-alpine",
  ]);
  const started = true;
  try {
    let ready = false;
    for (let i = 0; i < 45; i++) {
      const check = spawnSync(
        "docker",
        [
          "exec",
          name,
          "pg_isready",
          "-U",
          "postgres",
          "-d",
          "alavont_recovery",
        ],
        { stdio: "ignore" },
      );
      if (check.status === 0) {
        ready = true;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    if (!ready)
      throw new Error("Isolated recovery database did not become ready");
    const fd = openSync(snapshot.archive, "r");
    const result = spawnSync(
      "docker",
      [
        "exec",
        "-i",
        name,
        "pg_restore",
        "-U",
        "postgres",
        "-d",
        "alavont_recovery",
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
      ],
      { stdio: [fd, "pipe", "pipe"] },
    );
    closeSync(fd);
    if (result.error || result.status !== 0)
      throw new Error("Isolated database restore failed");
    const expectedLedger = snapshot.ledger;
    const recoveredLedger = run("docker", [
      "exec",
      name,
      "psql",
      "-U",
      "postgres",
      "-d",
      "alavont_recovery",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      "SELECT id || '|' || hash || '|' || created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at,id",
    ]);
    if (recoveredLedger.trim() !== expectedLedger.trim())
      throw new Error(
        "Isolated restore migration ledger differs from snapshot source",
      );
    const invariantSql = `SELECT
      (SELECT count(*) FROM drizzle.__drizzle_migrations)=42
      AND to_regclass('public.orders') IS NOT NULL
      AND to_regclass('public.inventory_transaction_log') IS NOT NULL
      AND to_regclass('public.inventory_reservations') IS NOT NULL
      AND to_regclass('public.inventory_balances') IS NOT NULL
      AND to_regclass('public.admin_settings') IS NOT NULL
      AND to_regclass('public.tenants') IS NOT NULL
      AND to_regclass('public.print_jobs') IS NOT NULL
      AND to_regclass('public.admin_settings_tenant_id_unique_idx') IS NULL
      AND to_regclass('public.tenants_slug_ci_unique_idx') IS NULL
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='catalog_items_tenant_id_id_unique' AND indexdef LIKE 'CREATE UNIQUE INDEX% (tenant_id, id)')
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='inventory_locations_tenant_id_id_unique' AND indexdef LIKE 'CREATE UNIQUE INDEX% (tenant_id, id)')
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='orders_tenant_id_id_unique' AND indexdef LIKE 'CREATE UNIQUE INDEX% (tenant_id, id)')
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='users_tenant_id_id_unique' AND indexdef LIKE 'CREATE UNIQUE INDEX% (tenant_id, id)')
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='tenants_slug_unique' AND indexdef LIKE 'CREATE UNIQUE INDEX% (slug)')
      AND NOT EXISTS (SELECT 1 FROM admin_settings GROUP BY tenant_id HAVING count(*) > 1)
      AND NOT EXISTS (SELECT 1 FROM tenants GROUP BY lower(slug) HAVING count(*) > 1)`;
    const invariant = run("docker", [
      "exec",
      name,
      "psql",
      "-U",
      "postgres",
      "-d",
      "alavont_recovery",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      invariantSql,
    ]);
    if (invariant.trim() !== "t")
      throw new Error("Isolated restore pre-release schema invariants failed");
    const counts = run("docker", [
      "exec",
      name,
      "psql",
      "-U",
      "postgres",
      "-d",
      "alavont_recovery",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      "SELECT 'orders='||(SELECT count(*) FROM orders)||';inventory_transaction_log='||(SELECT count(*) FROM inventory_transaction_log)||';inventory_reservations='||(SELECT count(*) FROM inventory_reservations)||';inventory_balances='||(SELECT count(*) FROM inventory_balances)||';catalog_items='||(SELECT count(*) FROM catalog_items)||';order_items='||(SELECT count(*) FROM order_items)",
    ]);
    if (counts.trim() !== snapshot.counts.trim())
      throw new Error(
        "Restored representative table counts differ from snapshot metadata",
      );
    const isolation = JSON.parse(run("docker", ["inspect", name]))[0];
    if (
      isolation.HostConfig.NetworkMode !== "none" ||
      isolation.Config.Labels?.["com.myorder.recovery-test"] !== "true" ||
      isolation.Mounts?.length !== 1 ||
      isolation.Mounts[0].Destination !== "/var/lib/postgresql/data"
    )
      throw new Error(
        "Recovery database isolation label/network/volume mismatch",
      );
    return { counts: counts.trim(), ledgerRows: 42, isolated: true };
  } finally {
    if (started) {
      const inspected = spawnSync("docker", ["inspect", name], {
        encoding: "utf8",
      });
      if (inspected.status === 0) {
        const container = JSON.parse(inspected.stdout)[0];
        if (
          container.Config.Labels?.["com.myorder.recovery-test"] !== "true" ||
          container.HostConfig.NetworkMode !== "none"
        )
          throw new Error(
            "Refusing to remove a container that is not the isolated recovery clone",
          );
        run("docker", ["stop", name]);
      }
    }
  }
}

function verifyMigration(compose) {
  const expected = EXPECTED_PRODUCTION_MIGRATIONS;
  const actual = query(
    compose,
    "SELECT substring(hash from 1 for 0) || id::text FROM drizzle.__drizzle_migrations ORDER BY created_at,id",
  );
  if (actual.split("\n").length !== 49)
    throw new Error("Production migration ledger count is not 49");
  const journal = JSON.parse(
    readFileSync(
      path.join(compose.releaseRoot, "lib/db/drizzle/meta/_journal.json"),
      "utf8",
    ),
  );
  if (
    expected.some((tag) => !journal.entries.some((entry) => entry.tag === tag))
  )
    throw new Error("Expected Release 1 migration missing from journal");
  const validator = run(
    "docker",
    [
      ...compose.args,
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "pnpm",
      "migrate",
      "--filter",
      "@workspace/db",
      "db:validate-migrations",
    ],
    { env: { ...process.env, DEPLOY_SHA: FROZEN_RELEASE.sha } },
  );
  for (const tag of expected)
    if (!validator.includes(`APPLIED ${tag} `))
      throw new Error(`Post-migration validator did not confirm ${tag}`);
  if (!validator.includes("production prefix preserved: 49/49"))
    throw new Error(
      "Post-migration validator did not confirm the complete production prefix",
    );
  const checks = query(
    compose,
    "SELECT (SELECT indisvalid AND indisready FROM pg_index WHERE indexrelid='public.admin_settings_tenant_id_unique_idx'::regclass) AND (SELECT indisvalid AND indisready FROM pg_index WHERE indexrelid='public.tenants_slug_ci_unique_idx'::regclass)",
  );
  if (checks !== "t")
    throw new Error(
      "Required Release 1 unique indexes are not valid and ready",
    );
}

function validatePendingLineage(compose) {
  const expected = EXPECTED_PRODUCTION_MIGRATIONS;
  const output = run(
    "docker",
    [
      ...compose.args,
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "pnpm",
      "migrate",
      "--filter",
      "@workspace/db",
      "db:validate-migrations",
    ],
    { env: { ...process.env, DEPLOY_SHA: FROZEN_RELEASE.sha } },
  );
  const pending = [
    ...output.matchAll(/\[migration-ledger\] PENDING ([^ ]+)/g),
  ].map((match) => match[1]);
  if (JSON.stringify(pending) !== JSON.stringify(expected))
    throw new Error(
      `Production pending migration sequence differs from expected Release 1 path: ${pending.join(",")}`,
    );
  if (!output.includes("production prefix preserved: 42/49"))
    throw new Error(
      "Production lineage validator did not recognize the exact 42-row prefix",
    );
}

async function waitFor(url, expectedSha, attempts = 45) {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url).catch(() => null);
    if (res?.ok) {
      const body = await res.json().catch(() => ({}));
      if (body.sha === expectedSha) return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `Health endpoint did not report expected release SHA: ${url}`,
  );
}

async function waitForApiContainer(compose, expectedSha, attempts = 45) {
  const apiId = run("docker", [
    ...compose.args,
    "ps",
    "--all",
    "--quiet",
    "api",
  ]).trim();
  if (!apiId) throw new Error("Production API container is missing");
  const probe = `fetch('http://127.0.0.1:8080/healthz').then(async r=>{const b=await r.json();if(!r.ok||b.sha!==${JSON.stringify(expectedSha)})process.exit(1)}).catch(()=>process.exit(1))`;
  for (let i = 0; i < attempts; i++) {
    const result = spawnSync("docker", ["exec", apiId, "node", "-e", probe], {
      stdio: "ignore",
    });
    if (result.status === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    "Production API container did not report the expected release SHA while ingress was stopped",
  );
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (command !== "deploy")
    throw new Error(
      "Usage: production-release.mjs deploy --release-sha SHA --release-tree TREE --archive PATH --archive-sha SHA256 --tooling-sha SHA --authorized",
    );
  const get = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (
    !args.includes("--authorized") ||
    process.env.PRODUCTION_DEPLOY_CONFIRMATION !== "DEPLOY-PRODUCTION"
  )
    throw new Error(
      "Production requires explicit protected-workflow authorization",
    );
  const sha = get("--release-sha");
  const tree = get("--release-tree");
  const archivePath = get("--archive");
  const archiveSha256 = get("--archive-sha");
  const toolingSha = get("--tooling-sha");
  const releaseRoot = path.join(PRODUCTION.root, "releases", String(sha));
  assertRelease({ sha, tree, releaseRoot, archivePath, archiveSha256 });
  if (!/^[a-f0-9]{40}$/.test(toolingSha ?? ""))
    throw new Error("Invalid deployment tooling SHA");
  const controlRoot = path.join(PRODUCTION.root, "control", toolingSha);
  const overlayFile = path.join(controlRoot, "production-runtime-overlay.yml");
  const envFile = path.join(PRODUCTION.root, "deploy/.env");
  assertProductionFilesystemLayout({
    controlRoot,
    envFile,
    overlayFile,
    archivePath,
    toolingSha,
  });
  if ((await sha256File(archivePath)) !== archiveSha256)
    throw new Error("Release archive SHA-256 does not match workflow metadata");
  mkdirSync(path.dirname(releaseRoot), { recursive: true, mode: 0o755 });
  if (existsSync(releaseRoot))
    throw new Error(
      "Versioned release directory already exists; refusing overwrite",
    );
  const archiveEntries = run("tar", ["--list", "--gzip", "--file", archivePath])
    .split("\n")
    .filter(Boolean);
  if (
    !archiveEntries.length ||
    archiveEntries.some(
      (entry) => entry.startsWith("/") || entry.split("/").includes(".."),
    )
  )
    throw new Error("Release archive contains an unsafe path");
  const verboseEntries = run("tar", [
    "--list",
    "--verbose",
    "--gzip",
    "--file",
    archivePath,
  ])
    .split("\n")
    .filter(Boolean);
  if (verboseEntries.some((entry) => /^[lh]/.test(entry)))
    throw new Error("Release archive symlinks and hardlinks are not accepted");
  const unpackRoot = `${releaseRoot}.extract-${process.pid}`;
  if (existsSync(unpackRoot))
    throw new Error(
      "A prior incomplete extraction exists; refusing to overwrite it",
    );
  mkdirSync(unpackRoot, { mode: 0o755 });
  try {
    run("tar", [
      "--extract",
      "--gzip",
      "--file",
      archivePath,
      "--directory",
      unpackRoot,
      "--no-same-owner",
      "--no-same-permissions",
    ]);
    renameSync(unpackRoot, releaseRoot);
  } catch (error) {
    rmSync(unpackRoot, { recursive: true, force: true });
    throw error;
  }
  const identityPath = path.join(
    PRODUCTION.root,
    "releases",
    `${sha}.identity.json`,
  );
  writeFileSync(
    identityPath,
    `${JSON.stringify({ sha, tree, archiveSha256, toolingSha, installedAt: new Date().toISOString() }, null, 2)}\n`,
    { flag: "wx", mode: 0o444 },
  );
  if (
    realpathSync(releaseRoot) !== releaseRoot ||
    lstatSync(releaseRoot).isSymbolicLink()
  )
    throw new Error(
      "Production release directory resolved through an unexpected symlink",
    );

  if (path.dirname(fileURLToPath(import.meta.url)) !== controlRoot)
    throw new Error(
      "Loaded deployment controller location does not match the pinned control directory",
    );
  const sharedRoot = path.join(PRODUCTION.root, "shared");
  const backupRoot = path.join(sharedRoot, "production-backups");
  const snapshot = { value: null };
  let compose;
  let containerBaseline;
  let apiStopAttempted = false;
  let migrationStarted = false;
  const actions = {
    validate: async () => {
      compose = validateComposeRuntimeConfig(releaseRoot, envFile, overlayFile);
      verifyProductionPayPalDisabled(compose);
      containerBaseline = verifyWriterSet(compose);
    },
    build: async () =>
      run("docker", [...compose.args, "build", "api", "platform", "migrate"], {
        env: { ...process.env, DEPLOY_SHA: sha },
      }),
    "validate-lineage": async () => validatePendingLineage(compose),
    "verify-writer-inventory": async () => {
      const current = verifyWriterSet(compose);
      if (
        JSON.stringify([...current.entries()].sort()) !==
        JSON.stringify([...containerBaseline.entries()].sort())
      )
        throw new Error(
          "Production writer/container inventory changed during release preparation",
        );
    },
    "stop-writers": async () => {
      apiStopAttempted = true;
      run("docker", [...compose.args, "stop", "nginx", "api"]);
    },
    "verify-writers-stopped": async () => {
      stopAndVerifyWriters(compose);
      safePrintAssetsCopy(compose, sharedRoot);
    },
    snapshot: async () => {
      snapshot.value = createSnapshot(compose, backupRoot);
    },
    "verify-snapshot": async () => {
      if (
        !snapshot.value?.archive ||
        (await sha256File(snapshot.value.archive)) !== snapshot.value.digest
      )
        throw new Error("Snapshot checksum verification failed");
      if (
        !readFileSync(`${snapshot.value.archive}.toc`, "utf8").includes(
          "TABLE DATA",
        )
      )
        throw new Error("Snapshot archive inspection is incomplete");
    },
    "restore-rehearsal": async () => restoreSnapshotInIsolation(snapshot.value),
    migrate: async () => {
      migrationStarted = true;
      run("docker", [...compose.args, "run", "--rm", "migrate"], {
        env: { ...process.env, DEPLOY_SHA: sha },
      });
    },
    "verify-migration": async () => verifyMigration(compose),
    "start-api": async () =>
      run("docker", [...compose.args, "up", "-d", "--no-deps", "api"], {
        env: { ...process.env, DEPLOY_SHA: sha },
      }),
    "verify-api": async () => waitForApiContainer(compose, sha),
    "start-platform-proxy": async () =>
      run(
        "docker",
        [...compose.args, "up", "-d", "--no-deps", "platform", "nginx"],
        { env: { ...process.env, DEPLOY_SHA: sha } },
      ),
    smoke: async () => {
      const api = await waitFor("http://127.0.0.1:8081/api/healthz", sha);
      const home = await fetch("http://127.0.0.1:8081/");
      if (!home.ok)
        throw new Error("Production platform homepage smoke test failed");
      const lucifer = await fetch("http://127.0.0.1:8081/api/public/catalog", {
        headers: { host: "shop.lucifercruz.com" },
      });
      if (!lucifer.ok)
        throw new Error(
          "Production Lucifer public catalogue smoke test failed",
        );
      const luciferBody = await lucifer.json().catch(() => ({}));
      if (
        !Array.isArray(luciferBody.products) ||
        luciferBody.products.length === 0
      )
        throw new Error(
          "Production Lucifer public catalogue returned no products",
        );
      const accessChecks = [
        ["authentication/orders", "/api/orders"],
        ["admin", "/api/admin/settings/paypal-status"],
        ["inventory", "/api/admin/inventory/movements"],
        ["catalogue-admin", "/api/admin/catalogue/products"],
      ];
      const accessResults = [];
      for (const [name, route] of accessChecks) {
        const response = await fetch(`http://127.0.0.1:8081${route}`);
        if (![401, 403].includes(response.status))
          throw new Error(
            `Unauthenticated production ${name} boundary did not reject access`,
          );
        accessResults.push(`${name}:${response.status}`);
      }
      const services = run("docker", [
        ...compose.args,
        "ps",
        "--format",
        "json",
      ]);
      if (
        !services.includes("api") ||
        !services.includes("platform") ||
        !services.includes("nginx")
      )
        throw new Error("Production Compose health inventory is incomplete");
      const restarts = run("docker", [
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=com.docker.compose.project=${PRODUCTION.project}`,
      ])
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const afterByService = new Map();
      for (const id of restarts) {
        const data = JSON.parse(run("docker", ["inspect", id]))[0];
        const service = data.Config.Labels?.["com.docker.compose.service"];
        if (
          data.Config.Labels?.["com.docker.compose.project"] !==
            PRODUCTION.project ||
          !["api", "db", "migrate", "nginx", "platform"].includes(service)
        )
          throw new Error(
            "Unexpected container appeared in the production Compose project",
          );
        afterByService.set(service, data);
        const prior = containerBaseline.get(service);
        if (
          data.State.OOMKilled ||
          (prior &&
            prior.id === id &&
            Number(data.RestartCount) !== Number(prior.restartCount)) ||
          ((!prior || prior.id !== id) && Number(data.RestartCount) !== 0)
        )
          throw new Error("Unexpected production container restart or OOM");
      }
      for (const service of ["api", "db", "migrate", "nginx", "platform"])
        if (!afterByService.has(service))
          throw new Error(
            `Production ${service} container is missing after rollout`,
          );
      if (
        afterByService.get("api").Config.Image !== `myorder-api:${sha}` ||
        afterByService.get("platform").Config.Image !==
          `myorder-platform:${sha}`
      )
        throw new Error("Production API/platform image SHA mismatch");
      const recentLogs = run("docker", [
        ...compose.args,
        "logs",
        "--no-color",
        "--since",
        "10m",
        "--tail",
        "500",
        "api",
        "platform",
        "nginx",
      ]);
      const secretLikeLogEntries = (
        recentLogs.match(
          /(?:PAYPAL_CLIENT_SECRET|UBER_CLIENT_SECRET|SETTINGS_ENC_KEY|CLERK_SECRET_KEY|PRINT_BRIDGE_API_KEY)\s*[:=]\s*(?!\[REDACTED\])\S+|authorization\s*:\s*bearer\s+\S+/gi,
        ) ?? []
      ).length;
      if (secretLikeLogEntries)
        throw new Error(
          "Potential credential-bearing content detected in recent production logs",
        );
      const errorLogCount = (
        recentLogs.match(/\b(?:ERROR|FATAL|uncaught exception)\b/gi) ?? []
      ).length;
      console.log(
        `production smoke health_sha=${api.sha} homepage=${home.status} lucifer_products=${luciferBody.products.length} unauthenticated=${accessResults.join(",")} paypal=disabled cash=not-mutated print_bridge=not-probed sanitized_log_errors=${errorLogCount} secret_like_log_entries=${secretLikeLogEntries} checks=health,homepage,public_catalog,auth,admin,inventory_read_gate,orders_read_gate,ledger,compose,restart,oom,log_review`,
      );
    },
  };
  try {
    await executeProductionSequence(actions);
  } catch (error) {
    if (
      mayRestoreRollbackApi({ apiStopAttempted, migrationStarted }) &&
      containerBaseline?.get("api")?.id
    ) {
      const priorApiId = containerBaseline.get("api").id;
      const inspected = JSON.parse(run("docker", ["inspect", priorApiId]))[0];
      if (
        inspected.Config.Image !== `myorder-api:${ROLLBACK_SHA}` ||
        inspected.Config.Labels?.["com.docker.compose.project"] !==
          PRODUCTION.project
      )
        throw new Error(
          "Pre-migration failure: rollback API identity could not be verified; API remains stopped",
        );
      const priorNginxId = containerBaseline.get("nginx")?.id;
      const priorNginx = priorNginxId
        ? JSON.parse(run("docker", ["inspect", priorNginxId]))[0]
        : null;
      if (
        !priorNginx ||
        priorNginx.Config.Labels?.["com.docker.compose.project"] !==
          PRODUCTION.project ||
        priorNginx.Config.Labels?.["com.docker.compose.service"] !== "nginx"
      )
        throw new Error(
          "Pre-migration failure: original production ingress identity could not be verified; services remain stopped",
        );
      if (!inspected.State?.Running) run("docker", ["start", priorApiId]);
      if (!priorNginx.State?.Running) run("docker", ["start", priorNginxId]);
      await waitFor("http://127.0.0.1:8081/api/healthz", ROLLBACK_SHA);
      throw new Error(
        `Pre-migration deployment gate failed; restored the original API container (${error instanceof Error ? error.message : "unknown"})`,
      );
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname)
) {
  main().catch((error) => {
    console.error(
      `Production release refused/failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
