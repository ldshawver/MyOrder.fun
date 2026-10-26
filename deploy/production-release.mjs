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
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";

export const FROZEN_RELEASE = Object.freeze({
  // The replacement candidate must descend from the previously approved
  // application candidate; deployment-only successors cannot change it.
  sha: "583d556c8d3a5a094641ea229835d7c3397de1b1",
  tree: "5d28e84ac2cf71aa6c99f42b299fedfcde51079f",
});
export const APPROVED_RELEASE = Object.freeze({
  sha: "b129ce3113ccabf26a0723355dce2f12ca3cf41e",
  tree: "0fedf800e58982363d740ad3ef3c945a210e2b26",
  // Production's containerd-backed Docker image store reports the immutable
  // manifest digest as image.Id. Keep registry manifests and their referenced
  // image-config digests separate so neither identity can stand in for the other.
  manifests: Object.freeze({
    api: "sha256:24b68d3553e57aa63254aeca2e4baa603756c83d911cfb8cb2f20b57fbe5f4dd",
    platform: "sha256:2082268d64cbbdfcdbf6d610a8cf134eb0d339e567388746aa5af5b42653607f",
    migrate: "sha256:fd51ed9afc114da542ae5ed13a1bf7e55169b49411455c52aedfd36e7083edaf",
  }),
  configs: Object.freeze({
    api: "sha256:2b4944af5265f8458a36149882af25c8865fa8d3a6223b44efc2740c4ab84409",
    platform: "sha256:e2d06676b71433c03a917ff912c4161a2e7a232705500a91183ad9576da0bb4f",
    migrate: "sha256:762825d40914a549b524f83d37ddde49a04ddbf282b7d467ce41436ad872c332",
  }),
  revisions: Object.freeze({
    api: "b129ce3113ccabf26a0723355dce2f12ca3cf41e",
    platform: "b129ce3113ccabf26a0723355dce2f12ca3cf41e",
    migrate: "b129ce3113ccabf26a0723355dce2f12ca3cf41e",
  }),
  references: Object.freeze({
    api: "ghcr.io/ldshawver/myorder-api@sha256:24b68d3553e57aa63254aeca2e4baa603756c83d911cfb8cb2f20b57fbe5f4dd",
    platform: "ghcr.io/ldshawver/myorder-platform@sha256:2082268d64cbbdfcdbf6d610a8cf134eb0d339e567388746aa5af5b42653607f",
    migrate: "ghcr.io/ldshawver/myorder-migrate@sha256:fd51ed9afc114da542ae5ed13a1bf7e55169b49411455c52aedfd36e7083edaf",
  }),
});
export const PRODUCTION_BASELINE = Object.freeze({
  apiImage: "sha256:acf3279c72c6ef2d9cd2f64fa4eab9d36d175a17c63422661996d0152477ad38",
  apiRevision: "e3b71aefbba59c34dd1164e25e1abb8dcc7771db",
  apiReference: "ghcr.io/ldshawver/myorder-api@sha256:acf3279c72c6ef2d9cd2f64fa4eab9d36d175a17c63422661996d0152477ad38",
  platformImage: "sha256:d81df6632045b3b254b366820cfa33818508b704e478eae9ec2ab7cb32380a52",
  platformRevision: "e3b71aefbba59c34dd1164e25e1abb8dcc7771db",
  platformReference: "ghcr.io/ldshawver/myorder-platform@sha256:d81df6632045b3b254b366820cfa33818508b704e478eae9ec2ab7cb32380a52",
  nginxImage: "sha256:8b1e78743a03dbb2c95171cc58639fef29abc8816598e27fb910ed2e621e589a",
  nginxReference: "nginx:alpine",
  databaseImage: "sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229",
  databaseReference: "postgres:16-alpine",
});
export const PRESERVED_SNAPSHOT = Object.freeze({
  // Guarded rehearsal run 39771000177 selected this exact archive, logged
  // this digest, and completed the isolated 0077 restore rehearsal before
  // guarded preflight run 39771583853 passed.
  archiveName: "alavont-before-5dd5b258f0b932e9a9ea4888af00a857d7d10146-20261022T103613Z.dump",
  archiveSha256: "059e28765fbdda27e9072497364e16b36e25e97968d4972c03326f4af2f2ac9e",
  rehearsalWorkflowRun: "39771000177",
  sourceApiRevision: "3e5a5c833b93c0e5c345cb2d2f2f9537400d16cb",
  sourceApiImage: "sha256:8e8299bb7b92ada12827071578987463ba9dfb97ece47235b4856f097dc5e154",
  sourcePlatformRevision: "3e5a5c833b93c0e5c345cb2d2f2f9537400d16cb",
  sourcePlatformImage: "sha256:ac052a7439d4cabacbbf1bdddef9f375f5220379d871970f5e2b050870c348cf",
  targetSha: "5dd5b258f0b932e9a9ea4888af00a857d7d10146",
  targetTree: "bd96df1c597e64d17c1aaa47f0d0201115a89173",
});
export const MIGRATION_0077 = Object.freeze({
  tag: "0077_catalogue_inventory_reconciliation",
  timestamp: "1792440000000",
  sha256: "29b98289bd97b1c4781495a93d3d034f03a0daa503a96adfda035d2a3aeecd6b",
});
export const MIGRATION_0078 = Object.freeze({
  tag: "0078_inventory_history_baseline_repair",
  timestamp: "1792785600000",
  sha256: "9d62687484ce3bdea6a0b127411643125739ec198644793b247313a92b2b78a4",
});
let releaseIdentity = APPROVED_RELEASE;
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
  "verify-release-images",
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

export const PRODUCTION_SMOKE_DOCKER_CHECKS = Object.freeze({
  activeTenantProjection: "production smoke active-tenant projection",
  catalogueEligibilityProjection:
    "production smoke catalogue-eligibility projection",
  composeServiceInventory: "production smoke Compose service inventory",
  projectContainerInventory: "production smoke project container inventory",
  containerMetadataInspection: "production smoke container metadata inspection",
  recentServiceLogReview: "production smoke recent service-log review",
});

export const EXPECTED_PRODUCTION_MIGRATIONS = Object.freeze([
  MIGRATION_0078.tag,
]);

const preReleaseSchemaInvariants = (ledgerRows) => Object.freeze([
  Object.freeze({ id: "migration_ledger_rows", expected: String(ledgerRows), allowed: /^\d+$/ }),
  ...[
    "public.orders",
    "public.inventory_transaction_log",
    "public.inventory_reservations",
    "public.inventory_balances",
    "public.admin_settings",
    "public.tenants",
    "public.print_jobs",
    "public.woocommerce_webhook_events",
  ].map((id) => Object.freeze({ id, expected: "table", allowed: /^(?:table|partitioned table|index|partitioned index|view|materialized view|sequence|foreign table|other|missing)$/ })),
  ...[
    "public.admin_settings_tenant_id_unique_idx",
  ].map((id) => Object.freeze({ id, expected: "index", allowed: /^(?:table|partitioned table|index|partitioned index|view|materialized view|sequence|foreign table|other|missing)$/ })),
  Object.freeze({ id: "public.catalogue_inventory_reconciliation_events", expected: ledgerRows === 51 ? "missing" : "table", allowed: /^(?:table|partitioned table|index|partitioned index|view|materialized view|sequence|foreign table|other|missing)$/ }),
  Object.freeze({ id: "public.inventory_history_baseline_repair_events", expected: "missing", allowed: /^(?:table|partitioned table|index|partitioned index|view|materialized view|sequence|foreign table|other|missing)$/ }),
  ...[
    "public.catalog_items_tenant_id_id_unique",
    "public.inventory_locations_tenant_id_id_unique",
    "public.orders_tenant_id_id_unique",
    "public.users_tenant_id_id_unique",
    "public.tenants_slug_ci_unique_idx",
  ].map((id) => Object.freeze({ id, expected: "matching unique index", allowed: /^(?:matching unique index|present with unexpected definition|missing)$/ })),
  Object.freeze({ id: "admin_settings_duplicate_tenant_groups", expected: "0", allowed: /^\d+$/ }),
  Object.freeze({ id: "tenants_duplicate_casefolded_slug_groups", expected: "0", allowed: /^\d+$/ }),
]);
export const PRE_RELEASE_SCHEMA_INVARIANTS = preReleaseSchemaInvariants(52);

export function assertPreReleaseSchemaInvariantDiagnostics(rows, ledgerRows = 52) {
  if (![51, 52].includes(ledgerRows))
    throw new Error("Isolated restore migration ledger length is not a recognized release predecessor");
  const invariants = preReleaseSchemaInvariants(ledgerRows);
  if (!Array.isArray(rows) || rows.length !== invariants.length)
    throw new Error("Isolated restore schema diagnostic result set is incomplete");
  const actualById = new Map();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || typeof row.actual !== "string" || actualById.has(row.id))
      throw new Error("Isolated restore schema diagnostic result set is invalid");
    actualById.set(row.id, row.actual);
  }
  const failures = [];
  for (const invariant of invariants) {
    const actual = actualById.get(invariant.id);
    if (actual === undefined || !invariant.allowed.test(actual))
      throw new Error("Isolated restore schema diagnostic contained an unsafe or unknown value");
    if (actual !== invariant.expected)
      failures.push(`${invariant.id} expected=${invariant.expected} actual=${actual}`);
  }
  if (failures.length)
    throw new Error(`Isolated restore pre-release schema invariants failed: ${failures.join("; ")}`);
  return true;
}

export function selectPreservedSnapshotMetadata(candidates) {
  if (!Array.isArray(candidates))
    throw new Error("Preserved production snapshot metadata is invalid");
  const pinnedMetadataName = `${PRESERVED_SNAPSHOT.archiveName}.metadata.json`;
  const pinned = candidates.filter(({ metadataPath }) =>
    typeof metadataPath === "string" && path.basename(metadataPath) === pinnedMetadataName
  );
  if (pinned.length === 0)
    throw new Error("Pinned preserved production snapshot metadata is missing");
  if (pinned.length !== 1)
    throw new Error("Pinned preserved production snapshot metadata is not unique");
  const selected = pinned[0];
  const metadata = selected.metadata;
  const baselineMatches =
    metadata?.sourceApiRevision === PRESERVED_SNAPSHOT.sourceApiRevision &&
    metadata?.sourceApiImage === PRESERVED_SNAPSHOT.sourceApiImage &&
    metadata?.sourcePlatformRevision === PRESERVED_SNAPSHOT.sourcePlatformRevision &&
    metadata?.sourcePlatformImage === PRESERVED_SNAPSHOT.sourcePlatformImage &&
    metadata?.targetSha === PRESERVED_SNAPSHOT.targetSha &&
    metadata?.targetTree === PRESERVED_SNAPSHOT.targetTree &&
    metadata?.productionProject === PRODUCTION.project &&
    metadata?.database === PRODUCTION.database &&
    metadata?.ledgerRows === 51 &&
    typeof metadata?.ledger === "string" &&
    metadata.ledger.split("\n").length === 51 &&
    /^orders=\d+;inventory_transaction_log=\d+;inventory_reservations=\d+;inventory_balances=\d+;catalog_items=\d+;order_items=\d+$/.test(metadata?.representativeCounts ?? "") &&
    /^[a-f0-9]{64}$/.test(metadata?.archiveSha256 ?? "");
  if (!baselineMatches)
    throw new Error("Pinned preserved production snapshot does not match the approved release baseline");
  if (metadata.archiveSha256 !== PRESERVED_SNAPSHOT.archiveSha256)
    throw new Error("Pinned preserved production snapshot metadata checksum differs from the approved digest");
  return selected;
}

export function assertRelease({
  sha,
  tree,
  releaseRoot,
  archivePath,
  archiveSha256,
  baseSha = FROZEN_RELEASE.sha,
  baseTree = FROZEN_RELEASE.tree,
}) {
  if (baseSha !== FROZEN_RELEASE.sha || baseTree !== FROZEN_RELEASE.tree || !/^[a-f0-9]{40}$/.test(sha ?? "") || !/^[a-f0-9]{40}$/.test(tree ?? ""))
    throw new Error("Release identity is invalid or does not descend from the frozen forward base");
  if (sha !== APPROVED_RELEASE.sha || tree !== APPROVED_RELEASE.tree)
    throw new Error("Release identity does not match the approved immutable candidate");
  const expectedRoot = path.join(
    PRODUCTION.root,
    "releases",
    releaseIdentity.sha,
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

export function assertReleaseIdentityManifest(identity, expected) {
  if (identity?.baseSha !== FROZEN_RELEASE.sha || identity?.baseTree !== FROZEN_RELEASE.tree ||
      identity?.sha !== expected?.sha || identity?.tree !== expected?.tree)
    throw new Error("Packaged release commit/tree does not match the protected candidate identity");
  return true;
}

export function assertReusableReleaseIdentity(identity, expected) {
  if (
    identity?.sha !== expected?.sha ||
    identity?.tree !== expected?.tree ||
    identity?.archiveSha256 !== expected?.archiveSha256
  )
    throw new Error("Existing versioned release identity does not match this guarded deployment");
  return true;
}

export function assertKnownNonWriterService(service, properties) {
  if (service !== "myorder-preview.service")
    throw new Error("Service is not an approved non-writer");
  const expected = {
    Id: "myorder-preview.service",
    ActiveState: "active",
    SubState: "running",
    User: "serveradmin",
    Group: "serveradmin",
    WorkingDirectory: "/home/serveradmin/worktrees/myorder-preview",
    FragmentPath: "/etc/systemd/system/myorder-preview.service",
    EnvironmentFiles: "",
  };
  for (const [key, value] of Object.entries(expected)) {
    if ((properties?.[key] ?? "") !== value)
      throw new Error(`Known non-writer service identity mismatch: ${key}`);
  }
  if (
    !/^\{ path=\/usr\/bin\/npm ; argv\[\]=\/usr\/bin\/npm run preview -- --host 127\.0\.0\.1 --port 4173 ;/.test(
      properties?.ExecStart ?? "",
    )
  )
    throw new Error("Known non-writer service command mismatch");
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
    "MYORDER_OWNER_CLERK_ID",
  ]) {
    if (typeof api[name] !== "string" || api[name].trim() === "")
      throw new Error(`Required production setting is missing: ${name}`);
  }
  const platformBuildArgs = config.services?.platform?.build?.args ?? {};
  const platformClerkKey = platformBuildArgs.VITE_CLERK_PUBLISHABLE_KEY;
  const platformClerkProxy = platformBuildArgs.VITE_CLERK_PROXY_URL;
  let clerkDomain = "";
  try {
    clerkDomain = Buffer.from(api.CLERK_PUBLISHABLE_KEY.slice("pk_live_".length), "base64url")
      .toString("utf8").replace(/\$$/, "");
  } catch { /* rejected below */ }
  if (!api.CLERK_SECRET_KEY.startsWith("sk_live_") || !api.CLERK_PUBLISHABLE_KEY.startsWith("pk_live_") ||
      clerkDomain !== "clerk.myorder.fun")
    throw new Error("Production API Clerk keys must use the clerk.myorder.fun live instance");
  if (platformClerkKey !== api.CLERK_PUBLISHABLE_KEY)
    throw new Error("Production API and Platform Clerk publishable keys do not match");
  if (api.CLERK_PROXY_URL !== "https://myorder.fun/api/__clerk" ||
      platformClerkProxy !== "https://myorder.fun/api/__clerk")
    throw new Error("Production API and Platform Clerk proxy URLs must match the MyOrder proxy route");
  if (!/^user_[A-Za-z0-9_-]+$/.test(api.MYORDER_OWNER_CLERK_ID))
    throw new Error("Production owner Clerk subject is invalid");
  if (api.WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED !== "false")
    throw new Error("Production WooCommerce external integration must remain explicitly disabled for this release");
  if (
    api.RECEIPT_PRINT_ENABLED !== "false" ||
    api.LABEL_PRINT_ENABLED !== "false"
  )
    throw new Error("Production printing must remain disabled for this release");
  if (!["0", "1"].includes(api.ORDER_NOTIFICATION_WORKER_ENABLED))
    throw new Error("Production order notification worker setting is invalid");
  if (api.ORDER_NOTIFICATION_WORKER_ENABLED === "1") {
    if (!/^\d+$/.test(String(api.TUYA_TENANT_ID ?? "")) || Number(api.TUYA_TENANT_ID) <= 0)
      throw new Error("Production order light tenant is invalid");
    for (const name of ["TUYA_CLIENT_ID", "TUYA_CLIENT_SECRET", "TUYA_API_BASE_URL", "TUYA_DEVICE_ID"]) {
      if (typeof api[name] !== "string" || api[name].trim() === "")
        throw new Error(`Required production order light setting is missing: ${name}`);
    }
    let tuyaUrl;
    try { tuyaUrl = new URL(api.TUYA_API_BASE_URL); }
    catch { throw new Error("Production order light API URL is invalid"); }
    if (tuyaUrl.protocol !== "https:" || tuyaUrl.pathname !== "/" || tuyaUrl.search || tuyaUrl.hash ||
        !["openapi.tuyaus.com", "openapi.tuyaeu.com", "openapi.tuyain.com", "openapi.tuyacn.com", "openapi-ueaz.tuyaus.com", "openapi-weaz.tuyaeu.com"].includes(tuyaUrl.hostname))
      throw new Error("Production order light API URL is not approved");
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
  if (expected?.migrateImage && config.services.migrate.image !== expected.migrateImage)
    throw new Error("Migration image does not match frozen release SHA");
  return true;
}

function approvedImageReference(service) {
  return APPROVED_RELEASE.references[service];
}

function releaseComposeEnvironment() {
  return {
    ...process.env,
    DEPLOY_SHA: releaseIdentity.sha,
    MYORDER_API_IMAGE: approvedImageReference("api"),
    MYORDER_PLATFORM_IMAGE: approvedImageReference("platform"),
    MYORDER_MIGRATE_IMAGE: approvedImageReference("migrate"),
    WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED: "false",
  };
}

export function assertApprovedImageMetadata({ service, reference, image, manifest }) {
  const expectedReference = `ghcr.io/ldshawver/myorder-${service}@${APPROVED_RELEASE.manifests[service]}`;
  if (reference !== expectedReference)
    throw new Error(`Approved ${service} repository manifest reference does not match the frozen release`);
  if (!Array.isArray(image?.RepoDigests) || !image.RepoDigests.includes(reference))
    throw new Error(`Approved ${service} immutable digest reference is unavailable`);
  if (image.Id !== APPROVED_RELEASE.manifests[service])
    throw new Error(`Approved ${service} local image identity does not match the manifest digest`);
  if (manifest?.config?.digest !== APPROVED_RELEASE.configs[service])
    throw new Error(`Approved ${service} image config digest does not match the frozen release`);
  if (
    image.Os !== "linux" ||
    image.Architecture !== "amd64" ||
    image.Config?.Labels?.["org.opencontainers.image.revision"] !== APPROVED_RELEASE.revisions[service] ||
    image.Config?.Labels?.["com.myorder.deploy-sha"] !== APPROVED_RELEASE.revisions[service]
  )
    throw new Error(`Approved ${service} image metadata does not match the frozen release`);
  return true;
}

function verifyApprovedReleaseImages() {
  for (const service of ["api", "platform", "migrate"]) {
    const reference = approvedImageReference(service);
    let image;
    let manifest;
    try {
      image = JSON.parse(run("docker", ["image", "inspect", reference]))[0];
      manifest = JSON.parse(run("docker", ["manifest", "inspect", reference]));
    } catch {
      throw new Error(`Approved ${service} image is unavailable by immutable digest`);
    }
    assertApprovedImageMetadata({ service, reference, image, manifest });
  }
  return true;
}

/** Sequential deployment state machine. Each action is awaited; any failure prevents all later actions. */
export async function executeProductionSequence(actions) {
  for (const name of PRODUCTION_STEPS) {
    if (typeof actions[name] !== "function")
      throw new Error(`Missing production deployment action: ${name}`);
    console.log(`production step start=${name}`);
    await actions[name]();
    console.log(`production step complete=${name}`);
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

export function assertPublicCatalogSmokePayload(payload, expectedTotal) {
  const items = payload?.items;
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    !Number.isSafeInteger(payload?.total) ||
    payload.total < items.length
  )
    throw new Error("Production Lucifer public catalogue returned no items");
  if (expectedTotal !== undefined && payload.total !== expectedTotal)
    throw new Error("Production public catalogue total differs from the database sale-eligibility projection");
  return items.length;
}

export function assertPlatformSmokeDocument(response, body, label) {
  if (!response?.ok || !String(response.headers?.get?.("content-type") ?? "").includes("text/html") ||
      !body.includes('id="root"'))
    throw new Error(`Production ${label} page smoke test failed`);
  return response.status;
}

export function requestLoopbackJsonWithHost(
  url,
  host,
  timeoutMs = 10_000,
  requestImpl = httpRequest,
) {
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1")
    throw new Error("Production smoke request must use the IPv4 loopback interface");
  if (host !== "myorder.fun")
    throw new Error("Production smoke request host must be myorder.fun");

  return new Promise((resolve, reject) => {
    const request = requestImpl(
      target,
      { headers: { host } },
      (response) => {
        let rawBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          rawBody += chunk;
          if (rawBody.length > 1_000_000)
            request.destroy(new Error("Production smoke response exceeded the size limit"));
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          let body = {};
          try {
            body = JSON.parse(rawBody);
          } catch {
            // The caller's existing response-contract guard will reject this.
          }
          resolve({ ok: status >= 200 && status < 300, status, body });
        });
      },
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(new Error("Production smoke request timed out")),
    );
    request.on("error", reject);
    request.end();
  });
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

function classifySmokeDockerStderr(stderr) {
  const value = String(stderr ?? "");
  if (!value.trim()) return "stderr-empty";
  if (/no such container/i.test(value)) return "container-not-found";
  if (/container .* is not running/i.test(value))
    return "container-not-running";
  if (/no such service/i.test(value)) return "compose-service-not-found";
  if (
    /cannot connect to the docker daemon|docker daemon is not running/i.test(
      value,
    )
  )
    return "docker-daemon-unavailable";
  if (/permission denied/i.test(value)) return "permission-denied";
  if (/connection refused|connection reset/i.test(value))
    return "connection-failure";
  if (/syntax error|\bERROR:/i.test(value)) return "database-command-rejected";
  return "stderr-redacted";
}

export function formatSmokeDockerFailure(label, result) {
  if (!Object.values(PRODUCTION_SMOKE_DOCKER_CHECKS).includes(label))
    throw new Error("Unknown production smoke Docker check label");
  const exit = Number.isInteger(result?.status)
    ? String(result.status)
    : "unavailable";
  const signal = /^[A-Z0-9]+$/.test(String(result?.signal ?? ""))
    ? String(result.signal)
    : "none";
  const errorCode = /^[A-Z0-9_]+$/.test(String(result?.error?.code ?? ""))
    ? String(result.error.code)
    : "none";
  const stderrClass = classifySmokeDockerStderr(result?.stderr);
  return `${label} failed (exit=${exit} signal=${signal} error_code=${errorCode} context=${stderrClass})`;
}

export function runSmokeDockerCheck(
  label,
  args,
  options = {},
  spawn = spawnSync,
) {
  const result = spawn("docker", args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0)
    throw new Error(formatSmokeDockerFailure(label, result));
  return result.stdout ?? "";
}

export function readSmokeComposeServiceInventory(compose, spawn = spawnSync) {
  return runSmokeDockerCheck(
    PRODUCTION_SMOKE_DOCKER_CHECKS.composeServiceInventory,
    [...compose.args, "ps", "--format", "json"],
    { env: releaseComposeEnvironment() },
    spawn,
  );
}

export function readSmokeRecentServiceLogs(compose, spawn = spawnSync) {
  return runSmokeDockerCheck(
    PRODUCTION_SMOKE_DOCKER_CHECKS.recentServiceLogReview,
    [
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
    ],
    { env: releaseComposeEnvironment() },
    spawn,
  );
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
    env: releaseComposeEnvironment(),
  });
  const config = JSON.parse(output);
  assertProductionConfig(config, {
    apiImage: approvedImageReference("api"),
    platformImage: approvedImageReference("platform"),
    migrateImage: approvedImageReference("migrate"),
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
  return { args, config, releaseRoot };
}

function query(compose, sql, env = {}, smokeDockerCheck) {
  const args = [
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
  ];
  const options = {
    env: { ...process.env, DEPLOY_SHA: releaseIdentity.sha, ...env },
  };
  return (
    smokeDockerCheck
      ? runSmokeDockerCheck(smokeDockerCheck, args, options)
      : run("docker", args, options)
  ).trim();
}

export function sameWriterInventory(left, right) {
  if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size)
    return false;
  const stableIdentity = (inventory) =>
    [...inventory.entries()]
      .map(([service, container]) => [
        service,
        container.id,
        container.image,
        container.imageId,
        container.revision,
      ])
      .sort(([leftService], [rightService]) =>
        leftService.localeCompare(rightService),
      );
  return (
    JSON.stringify(stableIdentity(left)) ===
    JSON.stringify(stableIdentity(right))
  );
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
      imageId: container.Image,
      revision: labels["org.opencontainers.image.revision"],
    });
  }
  const expected = ["api", "db", "migrate", "nginx", "platform"].sort();
  if (JSON.stringify(observed.sort()) !== JSON.stringify(expected))
    throw new Error(
      `Unexpected production project services; expected ${expected.join(",")}`,
    );
  const api = idsByService.get("api");
  const apiIsBaseline =
    api?.imageId === PRODUCTION_BASELINE.apiImage &&
    api?.revision === PRODUCTION_BASELINE.apiRevision &&
    api?.image === PRODUCTION_BASELINE.apiReference;
  const apiIsApproved =
    api?.imageId === APPROVED_RELEASE.manifests.api &&
    api?.revision === APPROVED_RELEASE.revisions.api &&
    api?.image === approvedImageReference("api");
  if (!apiIsBaseline && !apiIsApproved)
    throw new Error("Current production API is not the exact recorded rollback or approved image");
  const platform = idsByService.get("platform");
  const platformIsBaseline =
    platform?.imageId === PRODUCTION_BASELINE.platformImage &&
    platform?.revision === PRODUCTION_BASELINE.platformRevision &&
    platform?.image === PRODUCTION_BASELINE.platformReference;
  const platformIsApproved =
    platform?.imageId === APPROVED_RELEASE.manifests.platform &&
    platform?.revision === APPROVED_RELEASE.revisions.platform &&
    platform?.image === approvedImageReference("platform");
  if (!platformIsBaseline && !platformIsApproved)
    throw new Error("Current production Platform is neither the recorded rollback image nor the exact approved release image");
  const nginx = idsByService.get("nginx");
  if (
    nginx?.imageId !== PRODUCTION_BASELINE.nginxImage ||
    nginx?.image !== PRODUCTION_BASELINE.nginxReference
  )
    throw new Error("Current production nginx is not the exact recorded live baseline image");
  const database = idsByService.get("db");
  if (
    database?.imageId !== PRODUCTION_BASELINE.databaseImage ||
    database?.image !== PRODUCTION_BASELINE.databaseReference
  )
    throw new Error("Current production database is not the exact recorded live baseline image");
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
  const externalWriterCandidates = run(
    "sh",
    [
      "-lc",
      "systemctl list-units --all --type=service --no-legend --plain | awk 'tolower($0) ~ /(myorder|alavont).*active/ {print $1}'; systemctl list-timers --all --no-legend --plain | awk 'tolower($0) ~ /(myorder|alavont)/ {print $1}'; grep -RIlE '/opt/alavont|myorder|alavont' /etc/crontab /etc/cron.d /etc/cron.hourly /etc/cron.daily /var/spool/cron/crontabs 2>/dev/null | grep -vE '/(certbot|logrotate|e2scrub|sysstat)' || true",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const previewUnit = "myorder-preview.service";
  const previewIndex = externalWriterCandidates.indexOf(previewUnit);
  if (previewIndex !== -1) {
    const properties = Object.fromEntries(
      run("systemctl", [
        "show",
        previewUnit,
        "--no-pager",
        "--property=Id,ActiveState,SubState,User,Group,ExecStart,WorkingDirectory,FragmentPath,EnvironmentFiles",
      ])
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    assertKnownNonWriterService(previewUnit, properties);
    externalWriterCandidates.splice(previewIndex, 1);
  }
  if (externalWriterCandidates.length)
    throw new Error(
      `Potential external production writer/scheduler exists: ${externalWriterCandidates.join("\n")}`,
    );
  return idsByService;
}

function stopAndVerifyWriters(compose, containerBaseline) {
  const apiId = containerBaseline?.get("api")?.id;
  if (!apiId)
    throw new Error(
      "Verified production API container identity is unavailable during writer shutdown",
    );
  const running = run("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    apiId,
  ]).trim();
  if (running !== "false")
    throw new Error("Production API writer did not stop");
  const nginxId = containerBaseline?.get("nginx")?.id;
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

function safePrintAssetsCopy(apiId, sharedRoot) {
  if (!apiId)
    throw new Error(
      "Verified API container identity is unavailable; cannot preserve print assets",
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
    releaseIdentity.sha,
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
    `alavont-before-${releaseIdentity.sha}-${stamp}.dump`,
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
  if (ledger.split("\n").length !== 52)
    throw new Error(
      "Expected the recognized 52-row pre-0078 production ledger",
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
        env: { ...process.env, DEPLOY_SHA: releaseIdentity.sha },
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
    [...compose.args, "exec", "-T", "db", "pg_restore", "--list"],
    {
      env: { ...process.env, DEPLOY_SHA: releaseIdentity.sha },
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
    `${JSON.stringify({ sourceApiRevision: PRODUCTION_BASELINE.apiRevision, sourceApiImage: PRODUCTION_BASELINE.apiImage, sourcePlatformRevision: PRODUCTION_BASELINE.platformRevision, sourcePlatformImage: PRODUCTION_BASELINE.platformImage, targetSha: releaseIdentity.sha, targetTree: releaseIdentity.tree, productionProject: PRODUCTION.project, database: PRODUCTION.database, databaseIdentity: identity, ledgerRows: 52, ledger, representativeCounts: counts, archiveSha256: digest, capturedAt: new Date().toISOString() }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  chmodSync(partial, 0o600);
  renameSync(partial, archive);
  return { archive, digest, ledger, identity, counts };
}

const PRE_RELEASE_TABLES = Object.freeze([
  "orders",
  "inventory_transaction_log",
  "inventory_reservations",
  "inventory_balances",
  "admin_settings",
  "tenants",
  "print_jobs",
  "woocommerce_webhook_events",
]);
const PRE_RELEASE_NAMED_INDEXES = Object.freeze([
  "admin_settings_tenant_id_unique_idx",
]);
const PRE_RELEASE_UNIQUE_INDEXES = Object.freeze([
  ["catalog_items_tenant_id_id_unique", "tenant_id, id"],
  ["inventory_locations_tenant_id_id_unique", "tenant_id, id"],
  ["orders_tenant_id_id_unique", "tenant_id, id"],
  ["users_tenant_id_id_unique", "tenant_id, id"],
]);

function relationTypeExpression(name) {
  return `COALESCE((SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'i' THEN 'index' WHEN 'I' THEN 'partitioned index' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'foreign table' ELSE 'other' END FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='${name}'), 'missing')`;
}

export function preReleaseSchemaDiagnosticSql() {
  let ordinal = 0;
  const facts = [];
  const add = (id, actual) => facts.push(`SELECT ${++ordinal} AS ordinal, '${id}'::text AS id, ${actual}::text AS actual`);
  add("migration_ledger_rows", "(SELECT count(*) FROM drizzle.__drizzle_migrations)");
  for (const name of PRE_RELEASE_TABLES)
    add(`public.${name}`, relationTypeExpression(name));
  for (const name of PRE_RELEASE_NAMED_INDEXES)
    add(`public.${name}`, relationTypeExpression(name));
  add("public.catalogue_inventory_reconciliation_events", relationTypeExpression("catalogue_inventory_reconciliation_events"));
  add("public.inventory_history_baseline_repair_events", relationTypeExpression("inventory_history_baseline_repair_events"));
  for (const [name, columns] of PRE_RELEASE_UNIQUE_INDEXES) {
    add(
      `public.${name}`,
      `CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='${name}' AND indexdef LIKE 'CREATE UNIQUE INDEX% (${columns})') THEN 'matching unique index' WHEN to_regclass('public.${name}') IS NOT NULL THEN 'present with unexpected definition' ELSE 'missing' END`,
    );
  }
  add(
    "public.tenants_slug_ci_unique_idx",
    `CASE WHEN EXISTS (
      SELECT 1
      FROM pg_index i
      JOIN pg_class index_class ON index_class.oid=i.indexrelid
      JOIN pg_namespace index_schema ON index_schema.oid=index_class.relnamespace
      WHERE i.indrelid='public.tenants'::regclass
        AND index_schema.nspname='public'
        AND index_class.relname='tenants_slug_ci_unique_idx'
        AND i.indisunique AND i.indisvalid AND i.indisready
        AND i.indnatts=1 AND i.indnkeyatts=1
        AND i.indpred IS NULL
        AND pg_get_indexdef(i.indexrelid, 1, true)='lower(slug)'
    ) THEN 'matching unique index' WHEN to_regclass('public.tenants_slug_ci_unique_idx') IS NOT NULL THEN 'present with unexpected definition' ELSE 'missing' END`,
  );
  add("admin_settings_duplicate_tenant_groups", "(SELECT count(*) FROM (SELECT tenant_id FROM admin_settings GROUP BY tenant_id HAVING count(*) > 1) duplicate_groups)");
  add("tenants_duplicate_casefolded_slug_groups", "(SELECT count(*) FROM (SELECT lower(slug) FROM tenants GROUP BY lower(slug) HAVING count(*) > 1) duplicate_groups)");
  return `SELECT COALESCE(json_agg(json_build_object('id', id, 'actual', actual) ORDER BY ordinal), '[]'::json)::text FROM (${facts.join(" UNION ALL ")}) schema_facts`;
}

export async function loadPreservedSnapshot(backupRoot) {
  assertRealFilesystemPath(backupRoot, "directory");
  const prefix = `alavont-before-${PRESERVED_SNAPSHOT.targetSha}-`;
  const suffix = ".dump.metadata.json";
  const candidates = [];
  for (const entry of readdirSync(backupRoot)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue;
    const metadataPath = path.join(backupRoot, entry);
    assertRealFilesystemPath(metadataPath, "file");
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    } catch {
      throw new Error("Preserved production snapshot metadata JSON is invalid");
    }
    candidates.push({ metadataPath, metadata });
  }
  const selected = selectPreservedSnapshotMetadata(candidates);
  const archive = selected.metadataPath.slice(0, -".metadata.json".length);
  if (path.basename(archive) !== PRESERVED_SNAPSHOT.archiveName)
    throw new Error("Pinned preserved production snapshot path differs from the approved path");
  for (const filename of [archive, `${archive}.sha256`, `${archive}.toc`])
    assertRealFilesystemPath(filename, "file");
  const digest = PRESERVED_SNAPSHOT.archiveSha256;
  if ((await sha256File(archive)) !== digest)
    throw new Error("Preserved production snapshot archive SHA-256 differs from the approved digest");
  if (readFileSync(`${archive}.sha256`, "utf8") !== `${digest}  ${path.basename(archive)}\n`)
    throw new Error("Preserved production snapshot checksum sidecar differs from metadata");
  if (!readFileSync(`${archive}.toc`, "utf8").includes("TABLE DATA"))
    throw new Error("Preserved production snapshot archive inspection is incomplete");
  return {
    archive,
    digest,
    ledger: selected.metadata.ledger,
    identity: selected.metadata.databaseIdentity,
    counts: selected.metadata.representativeCounts,
  };
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
    const ledgerRows = recoveredLedger.trim().split("\n").filter(Boolean).length;
    if (![51, 52].includes(ledgerRows))
      throw new Error("Isolated restore does not have a recognized 0077/0078 predecessor lineage");
    const invariantJson = run("docker", [
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
      preReleaseSchemaDiagnosticSql(),
    ]);
    let invariantRows;
    try {
      invariantRows = JSON.parse(invariantJson);
    } catch {
      throw new Error("Isolated restore schema diagnostic returned invalid JSON");
    }
    assertPreReleaseSchemaInvariantDiagnostics(invariantRows, ledgerRows);
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
    const migrations = ledgerRows === 51
      ? [
          [MIGRATION_0077, "0077_catalogue_inventory_reconciliation.sql"],
          [MIGRATION_0078, "0078_inventory_history_baseline_repair.sql"],
        ]
      : [[MIGRATION_0078, "0078_inventory_history_baseline_repair.sql"]];
    for (const [migration, filename] of migrations) {
      const migrationPath = path.join(
        PRODUCTION.root,
        "releases",
        releaseIdentity.sha,
        "lib/db/drizzle",
        filename,
      );
      assertRealFilesystemPath(migrationPath, "file");
      const migrationSource = readFileSync(migrationPath);
      if (createHash("sha256").update(migrationSource).digest("hex") !== migration.sha256)
        throw new Error(`Migration ${migration.tag.slice(0, 4)} source checksum differs from the reviewed candidate`);
      const migrationFd = openSync(migrationPath, "r");
      const rehearsal = spawnSync(
        "docker",
        [
          "exec",
          "-i",
          name,
          "psql",
          "-U",
          "postgres",
          "-d",
          "alavont_recovery",
          "-X",
          "-v",
          "ON_ERROR_STOP=1",
          "--single-transaction",
        ],
        { stdio: [migrationFd, "pipe", "pipe"] },
      );
      closeSync(migrationFd);
      if (rehearsal.error || rehearsal.status !== 0)
        throw new Error(`Isolated migration ${migration.tag.slice(0, 4)} rehearsal failed`);
    }
    const rehearsalVerified = run("docker", [
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
      `SELECT
        to_regclass('public.catalogue_inventory_reconciliation_events') IS NOT NULL
        AND to_regprocedure('public.prevent_catalogue_reconciliation_mutation()') IS NOT NULL
        AND to_regprocedure('public.block_live_inventory_model_change()') IS NOT NULL
        AND (SELECT count(*) FROM pg_trigger WHERE tgname IN ('catalogue_inventory_reconciliation_immutable','catalogue_product_inventory_model_guard') AND NOT tgisinternal)=2
        AND to_regclass('public.inventory_history_baseline_repair_events') IS NOT NULL
        AND to_regprocedure('public.prevent_inventory_history_baseline_repair_mutation()') IS NOT NULL
        AND (SELECT count(*) FROM pg_trigger WHERE tgname='inventory_history_baseline_repair_events_immutable' AND NOT tgisinternal)=1
        AND (SELECT count(*) FROM drizzle.__drizzle_migrations)=${ledgerRows}`,
    ]).trim();
    if (rehearsalVerified !== "t")
      throw new Error("Isolated 0077/0078 rehearsal schema verification failed");
    const countsAfterRehearsal = run("docker", [
      "exec", name, "psql", "-U", "postgres", "-d", "alavont_recovery",
      "-X", "-v", "ON_ERROR_STOP=1", "-Atc",
      "SELECT 'orders='||(SELECT count(*) FROM orders)||';inventory_transaction_log='||(SELECT count(*) FROM inventory_transaction_log)||';inventory_reservations='||(SELECT count(*) FROM inventory_reservations)||';inventory_balances='||(SELECT count(*) FROM inventory_balances)||';catalog_items='||(SELECT count(*) FROM catalog_items)||';order_items='||(SELECT count(*) FROM order_items)",
    ]).trim();
    if (countsAfterRehearsal !== snapshot.counts.trim())
      throw new Error("Migration 0077/0078 rehearsal changed representative production data counts");
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
    return {
      counts: counts.trim(),
      ledgerRows,
      isolated: true,
      migration0077: ledgerRows === 51,
      migration0078: true,
    };
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
  if (actual.split("\n").length !== 53)
    throw new Error("Production migration ledger count is not 53");
  const journal = JSON.parse(
    readFileSync(
      path.join(compose.releaseRoot, "lib/db/drizzle/meta/_journal.json"),
      "utf8",
    ),
  );
  if (journal.entries.length !== 53)
    throw new Error("Candidate migration journal must contain all 53 canonical entries through 0078");
  if (
    expected.some((tag) => !journal.entries.some((entry) => entry.tag === tag))
  )
    throw new Error("Approved migration 0078 is missing from the candidate journal");
  const migrationPath = path.join(compose.releaseRoot, "lib/db/drizzle/0078_inventory_history_baseline_repair.sql");
  if (createHash("sha256").update(readFileSync(migrationPath)).digest("hex") !== MIGRATION_0078.sha256)
    throw new Error("Migration 0078 source checksum differs from the reviewed candidate");
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
    { env: { ...process.env, DEPLOY_SHA: releaseIdentity.sha } },
  );
  for (const tag of expected)
    if (!validator.includes(`APPLIED ${tag} `))
      throw new Error(`Post-migration validator did not confirm ${tag}`);
  if (!validator.includes(`APPLIED ${MIGRATION_0077.tag} `))
    throw new Error(`Post-migration validator did not preserve ${MIGRATION_0077.tag}`);
  if (!validator.includes("recognized lineage preserved: 53/53"))
    throw new Error(
      "Post-migration validator did not confirm the complete candidate migration lineage",
    );
  const candidateSchema = query(compose, `
    SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='catalogue_options' AND column_name='option_values' AND udt_name='jsonb')
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='catalog_items' AND column_name='barcode' AND udt_name='text')
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_items' AND column_name='variant_snapshot' AND udt_name='jsonb')
      AND EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='catalog_items_tenant_sku_ci_unique' AND i.indisunique AND i.indisvalid AND i.indisready)
      AND EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='catalog_items_tenant_woo_variation_unique' AND i.indisunique AND i.indisvalid AND i.indisready)
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='admin_settings' AND column_name='wc_webhook_secret')
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='admin_settings' AND column_name='wc_store_url' AND column_default IS NULL)
      AND to_regclass('public.woocommerce_webhook_events') IS NOT NULL
      AND (SELECT count(*)=12 FROM information_schema.columns WHERE table_schema='public' AND table_name='woocommerce_webhook_events')
      AND NOT EXISTS (
        SELECT 1 FROM (VALUES
          ('id','int8','NO'), ('tenant_id','int4','NO'), ('delivery_id','text','NO'),
          ('topic','text','NO'), ('product_id','text','NO'), ('payload_sha256','text','NO'),
          ('status','text','NO'), ('attempt_count','int4','NO'), ('error_code','text','YES'),
          ('created_at','timestamptz','NO'), ('updated_at','timestamptz','NO'), ('processed_at','timestamptz','YES')
        ) AS expected(column_name, udt_name, is_nullable)
        WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public'
          AND c.table_name='woocommerce_webhook_events' AND c.column_name=expected.column_name
          AND c.udt_name=expected.udt_name AND c.is_nullable=expected.is_nullable)
      )
      AND (SELECT count(*)=3 FROM pg_constraint WHERE conrelid='public.woocommerce_webhook_events'::regclass AND contype IN ('p','c','u'))
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.woocommerce_webhook_events'::regclass AND conname='woocommerce_webhook_events_tenant_id_fkey' AND contype='f' AND convalidated)
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.woocommerce_webhook_events'::regclass AND conname='woocommerce_webhook_events_pkey' AND contype='p' AND convalidated)
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.woocommerce_webhook_events'::regclass AND conname='woocommerce_webhook_events_tenant_delivery_unique' AND contype='u' AND convalidated)
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.woocommerce_webhook_events'::regclass AND conname='woocommerce_webhook_events_status_check' AND contype='c' AND convalidated)
  `);
  if (candidateSchema !== "t") throw new Error("Candidate 0075/0076 physical schema verification failed");
  const reconciliationSchema = query(compose, `
    SELECT
      to_regclass('public.catalogue_inventory_reconciliation_events') IS NOT NULL
      AND to_regprocedure('public.prevent_catalogue_reconciliation_mutation()') IS NOT NULL
      AND to_regprocedure('public.block_live_inventory_model_change()') IS NOT NULL
      AND (SELECT count(*) FROM pg_trigger WHERE tgname IN ('catalogue_inventory_reconciliation_immutable','catalogue_product_inventory_model_guard') AND NOT tgisinternal)=2
      AND (SELECT count(*) FROM drizzle.__drizzle_migrations WHERE created_at=${MIGRATION_0077.timestamp})=1
  `);
  if (reconciliationSchema !== "t")
    throw new Error("Migration 0077 reconciliation schema is absent or structurally invalid");
  const repairSchema = query(compose, `
    SELECT
      to_regclass('public.inventory_history_baseline_repair_events') IS NOT NULL
      AND to_regprocedure('public.prevent_inventory_history_baseline_repair_mutation()') IS NOT NULL
      AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='inventory_history_baseline_repair_events')=10
      AND (SELECT count(*) FROM pg_constraint WHERE conrelid='public.inventory_history_baseline_repair_events'::regclass AND contype IN ('p','f','u'))=5
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.inventory_history_baseline_repair_events'::regclass AND conname='inventory_history_baseline_repair_events_pkey' AND contype='p' AND convalidated)
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.inventory_history_baseline_repair_events'::regclass AND contype='f' AND convalidated AND pg_get_constraintdef(oid,true)='FOREIGN KEY (tenant_id) REFERENCES tenants(id)')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.inventory_history_baseline_repair_events'::regclass AND contype='f' AND convalidated AND pg_get_constraintdef(oid,true)='FOREIGN KEY (actor_user_id) REFERENCES users(id)')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.inventory_history_baseline_repair_events'::regclass AND contype='f' AND convalidated AND pg_get_constraintdef(oid,true)='FOREIGN KEY (tenant_id, product_id) REFERENCES catalogue_products(tenant_id, id)')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.inventory_history_baseline_repair_events'::regclass AND contype='u' AND convalidated AND pg_get_constraintdef(oid,true)='UNIQUE (tenant_id, idempotency_key)')
      AND (SELECT count(*) FROM pg_trigger WHERE tgname='inventory_history_baseline_repair_events_immutable' AND NOT tgisinternal)=1
      AND (SELECT count(*) FROM drizzle.__drizzle_migrations WHERE created_at=${MIGRATION_0078.timestamp})=1
  `);
  if (repairSchema !== "t")
    throw new Error("Migration 0078 repair evidence schema is absent or structurally invalid");
  verifyP0Schema(compose);
  const checks = query(
    compose,
    "SELECT (SELECT indisvalid AND indisready FROM pg_index WHERE indexrelid='public.admin_settings_tenant_id_unique_idx'::regclass) AND (SELECT indisvalid AND indisready FROM pg_index WHERE indexrelid='public.tenants_slug_ci_unique_idx'::regclass)",
  );
  if (checks !== "t")
    throw new Error(
      "Required Release 1 unique indexes are not valid and ready",
    );
}

function verifyP0Schema(compose) {
  if (query(compose, "SELECT to_regclass('public.myorder_hotfix_migrations')::text") !== "myorder_hotfix_migrations")
    throw new Error("Required P0 marker table is absent");
  const verified = query(compose, `
    SELECT
      (SELECT count(*) FROM public.myorder_hotfix_migrations WHERE migration_id='p0_owner_approval_provenance') = 1
      AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='myorder_hotfix_migrations')=2
      AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='myorder_hotfix_migrations' AND ((column_name='migration_id' AND data_type='text' AND is_nullable='NO') OR (column_name='applied_at' AND data_type='timestamp with time zone' AND is_nullable='NO' AND column_default LIKE 'now()%')))=2
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.myorder_hotfix_migrations'::regclass AND contype='p' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.myorder_hotfix_migrations'::regclass AND attname='migration_id')]::smallint[] AND convalidated)
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='approved_at' AND data_type='timestamp with time zone' AND is_nullable='YES')
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='approved_by_clerk_id' AND data_type='text' AND is_nullable='YES')
      AND EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='users_owner_approval_provenance_idx' AND i.indisvalid AND i.indisready AND pg_get_expr(i.indpred, i.indrelid) = '(status = ''approved''::text)')
  `);
  if (verified !== "t") throw new Error("Required P0 marker/provenance schema is absent or structurally invalid");
  return true;
}

export function classifyMigrationLineage(output) {
  const expected = EXPECTED_PRODUCTION_MIGRATIONS;
  const pending = [
    ...output.matchAll(/\[migration-ledger\] PENDING ([^ ]+)/g),
  ].map((match) => match[1]);
  if (
    JSON.stringify(pending) === JSON.stringify(expected) &&
    output.includes("recognized lineage preserved: 52/53")
  )
    return "pending";
  if (
    pending.length === 0 &&
    expected.every((tag) => output.includes(`APPLIED ${tag} `)) &&
    output.includes("recognized lineage preserved: 53/53")
  )
    return "applied";
  throw new Error(
    `Production migration state is neither the exact 52-row pre-0078 path nor the verified 53-row applied lineage: ${pending.join(",")}`,
  );
}

function validatePendingLineage(compose) {
  verifyP0Schema(compose);
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
    { env: { ...process.env, DEPLOY_SHA: releaseIdentity.sha } },
  );
  return classifyMigrationLineage(output);
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
  const apiId = run(
    "docker",
    [...compose.args, "ps", "--all", "--quiet", "api"],
    { env: releaseComposeEnvironment() },
  ).trim();
  if (!apiId) throw new Error("Production API container is missing");
  const probe = `fetch('http://127.0.0.1:8080/api/healthz').then(async r=>{const b=await r.json();if(!r.ok||b.sha!==${JSON.stringify(expectedSha)})process.exit(1)}).catch(()=>process.exit(1))`;
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
  const confirmations = Object.freeze({
    preflight: "PREFLIGHT-PRODUCTION",
    rehearsal: "REHEARSE-PRODUCTION-SNAPSHOT",
    deploy: "DEPLOY-PRODUCTION",
  });
  if (!Object.hasOwn(confirmations, command))
    throw new Error(
      "Usage: production-release.mjs <preflight|rehearsal|deploy> --base-sha SHA --base-tree TREE --release-sha SHA --release-tree TREE --archive PATH --archive-sha SHA256 --tooling-sha SHA --authorized",
    );
  const get = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (
    !args.includes("--authorized") ||
    process.env.PRODUCTION_DEPLOY_CONFIRMATION !== confirmations[command]
  )
    throw new Error(
      "Production requires explicit protected-workflow authorization",
    );
  const sha = get("--release-sha");
  const tree = get("--release-tree");
  const baseSha = get("--base-sha");
  const baseTree = get("--base-tree");
  const archivePath = get("--archive");
  const archiveSha256 = get("--archive-sha");
  const toolingSha = get("--tooling-sha");
  releaseIdentity = Object.freeze({ sha, tree });
  Object.assign(process.env, {
    MYORDER_API_IMAGE: approvedImageReference("api"),
    MYORDER_PLATFORM_IMAGE: approvedImageReference("platform"),
    MYORDER_MIGRATE_IMAGE: approvedImageReference("migrate"),
    WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED: "false",
  });
  const releaseRoot = path.join(PRODUCTION.root, "releases", String(sha));
  assertRelease({ sha, tree, baseSha, baseTree, releaseRoot, archivePath, archiveSha256 });
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
  const identityPath = path.join(
    PRODUCTION.root,
    "releases",
    `${sha}.identity.json`,
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
  const packagedIdentityText = run("tar", ["--extract", "--to-stdout", "--gzip", "--file", archivePath, "MYORDER-RELEASE-IDENTITY.json"], { capture: true });
  let packagedIdentity;
  try { packagedIdentity = JSON.parse(packagedIdentityText); }
  catch { throw new Error("Release archive identity manifest is invalid"); }
  assertReleaseIdentityManifest(packagedIdentity, { sha, tree });
  if (existsSync(releaseRoot)) {
    assertRealFilesystemPath(releaseRoot, "directory");
    assertRealFilesystemPath(identityPath, "file");
    let existingIdentity;
    let installedManifest;
    try {
      existingIdentity = JSON.parse(readFileSync(identityPath, "utf8"));
      installedManifest = JSON.parse(
        readFileSync(
          path.join(releaseRoot, "MYORDER-RELEASE-IDENTITY.json"),
          "utf8",
        ),
      );
    } catch {
      throw new Error("Existing versioned release identity metadata is invalid");
    }
    assertReusableReleaseIdentity(existingIdentity, {
      sha,
      tree,
      archiveSha256,
      toolingSha,
    });
    assertReleaseIdentityManifest(installedManifest, { sha, tree });
  } else {
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
    writeFileSync(
      identityPath,
      `${JSON.stringify({ sha, tree, archiveSha256, toolingSha, installedAt: new Date().toISOString() }, null, 2)}\n`,
      { flag: "wx", mode: 0o444 },
    );
  }
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
  let migrationState = "unknown";
  let apiStopAttempted = false;
  let migrationStarted = false;
  const actions = {
    "verify-release-images": async () => verifyApprovedReleaseImages(),
    validate: async () => {
      compose = validateComposeRuntimeConfig(releaseRoot, envFile, overlayFile);
      verifyProductionPayPalDisabled(compose);
      containerBaseline = verifyWriterSet(compose);
    },
    "validate-lineage": async () => {
      migrationState = validatePendingLineage(compose);
      const runtimeAlreadyAdvanced = ["api", "platform"].some((service) => {
        const current = containerBaseline.get(service);
        return (
          (current?.imageId === APPROVED_RELEASE.manifests[service] &&
            current?.revision === APPROVED_RELEASE.revisions[service] &&
            current?.image === approvedImageReference(service))
        );
      });
      if (runtimeAlreadyAdvanced && migrationState !== "applied")
        throw new Error("Approved runtime image cannot be resumed before the exact 53-row migration lineage is applied");
      if (migrationState === "applied") migrationStarted = true;
    },
    "verify-writer-inventory": async () => {
      const current = verifyWriterSet(compose);
      if (!sameWriterInventory(current, containerBaseline))
        throw new Error(
          "Production writer/container identity changed during release preparation",
        );
    },
    "stop-writers": async () => {
      const nginxId = containerBaseline?.get("nginx")?.id;
      const apiId = containerBaseline?.get("api")?.id;
      if (!nginxId || !apiId)
        throw new Error("Verified production API/ingress container IDs are unavailable");
      apiStopAttempted = true;
      run("docker", ["stop", nginxId]);
      run("docker", ["stop", apiId]);
    },
    "verify-writers-stopped": async () => {
      stopAndVerifyWriters(compose, containerBaseline);
      safePrintAssetsCopy(containerBaseline.get("api").id, sharedRoot);
    },
    snapshot: async () => {
      if (migrationState === "applied") {
        console.log("production resume: snapshot already completed before the verified migration");
        return;
      }
      snapshot.value = createSnapshot(compose, backupRoot);
    },
    "verify-snapshot": async () => {
      if (migrationState === "applied") {
        console.log("production resume: snapshot verification already completed before the verified migration");
        return;
      }
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
    "restore-rehearsal": async () => {
      if (migrationState === "applied") {
        console.log("production resume: isolated restore rehearsal already completed before the verified migration");
        return;
      }
      return restoreSnapshotInIsolation(snapshot.value);
    },
    migrate: async () => {
      if (migrationState === "applied") {
        console.log("production resume: exact 53-row migration lineage is already applied");
        return;
      }
      migrationStarted = true;
      run("docker", [...compose.args, "run", "--pull", "never", "--rm", "--no-deps", "migrate"], {
        env: releaseComposeEnvironment(),
      });
    },
    "verify-migration": async () => verifyMigration(compose),
    "start-api": async () =>
      run("docker", [...compose.args, "up", "--pull", "never", "--no-build", "-d", "--no-deps", "api"], {
        env: releaseComposeEnvironment(),
      }),
    "verify-api": async () => waitForApiContainer(compose, sha),
    "start-platform-proxy": async () =>
      run(
        "docker",
        [...compose.args, "up", "--pull", "never", "--no-build", "-d", "--no-deps", "platform", "nginx"],
        { env: releaseComposeEnvironment() },
      ),
    smoke: async () => {
      const api = await waitFor("http://127.0.0.1:8081/api/healthz", sha);
      const home = await fetch("http://127.0.0.1:8081/");
      if (!home.ok)
        throw new Error("Production platform homepage smoke test failed");
      const publicCatalog = await requestLoopbackJsonWithHost(
        "http://127.0.0.1:8081/api/public/catalog",
        "myorder.fun",
      );
      if (!publicCatalog.ok)
        throw new Error(
          "Production MyOrder public catalogue smoke test failed",
        );
      const publicCatalogBody = publicCatalog.body;
      const activeTenants = Number(
        query(
          compose,
          "SELECT count(*) FROM tenants WHERE status='active'",
          {},
          PRODUCTION_SMOKE_DOCKER_CHECKS.activeTenantProjection,
        ),
      );
      if (activeTenants !== 1)
        throw new Error("Production public catalog tenant mapping is ambiguous");
      const eligiblePublicTotal = Number(query(compose, `
        SELECT count(*) FROM catalog_items ci
        JOIN tenants t ON t.id=ci.tenant_id
        WHERE t.status='active'
          AND ci.is_woo_managed=true
          AND ci.merchant_product_source='woo'
          AND ci.is_available=true
          AND ci.woo_product_id IS NOT NULL
          AND ci.woo_product_id<>''
          AND NOT coalesce(ci.metadata,'{}'::jsonb) @> '{"isVisible":false}'::jsonb
          AND NOT coalesce(ci.metadata,'{}'::jsonb) @> '{"archived":true}'::jsonb
          AND NOT coalesce(ci.metadata,'{}'::jsonb) @> '{"safeOnlyDuplicate":true}'::jsonb
          AND NOT coalesce(ci.metadata,'{}'::jsonb) @> '{"complianceHold":true}'::jsonb
          AND ci.metadata->>'mergedIntoCatalogItemId' IS NULL
      `, {}, PRODUCTION_SMOKE_DOCKER_CHECKS.catalogueEligibilityProjection));
      if (!Number.isSafeInteger(eligiblePublicTotal) || eligiblePublicTotal <= 0)
        throw new Error("Production public catalog database eligibility projection is empty or invalid");
      const publicCatalogItems = assertPublicCatalogSmokePayload(publicCatalogBody, eligiblePublicTotal);
      const signIn = await fetch("http://127.0.0.1:8081/sign-in");
      const signInStatus = assertPlatformSmokeDocument(signIn, await signIn.text(), "sign-in");
      const pos = await fetch("http://127.0.0.1:8081/orders");
      const posStatus = assertPlatformSmokeDocument(pos, await pos.text(), "POS shell");
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
      const services = readSmokeComposeServiceInventory(compose);
      if (
        !services.includes("api") ||
        !services.includes("platform") ||
        !services.includes("nginx")
      )
        throw new Error("Production Compose health inventory is incomplete");
      const restarts = runSmokeDockerCheck(PRODUCTION_SMOKE_DOCKER_CHECKS.projectContainerInventory, [
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
        const data = JSON.parse(runSmokeDockerCheck(
          PRODUCTION_SMOKE_DOCKER_CHECKS.containerMetadataInspection,
          ["inspect", id],
        ))[0];
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
        afterByService.get("api").Image !== APPROVED_RELEASE.manifests.api ||
        afterByService.get("platform").Image !== APPROVED_RELEASE.manifests.platform ||
        afterByService.get("api").Config.Image !== approvedImageReference("api") ||
        afterByService.get("platform").Config.Image !== approvedImageReference("platform")
      )
        throw new Error("Production API/platform image digest mismatch");
      const recentLogs = readSmokeRecentServiceLogs(compose);
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
        `production smoke health_sha=${api.sha} homepage=${home.status} sign_in=${signInStatus} pos_shell=${posStatus} public_catalog_items=${publicCatalogItems} public_catalog_total=${eligiblePublicTotal} unauthenticated=${accessResults.join(",")} paypal=disabled cash=not-mutated print_bridge=not-probed sanitized_log_errors=${errorLogCount} secret_like_log_entries=${secretLikeLogEntries} checks=health,homepage,sign_in,pos_shell,public_catalog_filter,auth,admin,inventory_read_gate,orders_read_gate,ledger,compose,restart,oom,log_review`,
      );
    },
  };
  if (command === "rehearsal") {
    console.log("production rehearsal step start=select-preserved-snapshot");
    const preservedSnapshot = await loadPreservedSnapshot(backupRoot);
    console.log(
      `production rehearsal step complete=select-preserved-snapshot archive=${path.basename(preservedSnapshot.archive)} sha256=${preservedSnapshot.digest}`,
    );
    console.log("production rehearsal step start=restore-rehearsal");
    const rehearsal = restoreSnapshotInIsolation(preservedSnapshot);
    console.log("production rehearsal step complete=restore-rehearsal");
    console.log(
      `production rehearsal result=passed release_sha=${sha} isolated=${rehearsal.isolated} migration_0077=${rehearsal.migration0077} migration_0078=${rehearsal.migration0078} ledger_rows=${rehearsal.ledgerRows}`,
    );
    return;
  }
  if (command === "preflight") {
    for (const name of ["validate", "verify-release-images", "validate-lineage", "verify-writer-inventory"]) {
      console.log(`production preflight step start=${name}`);
      await actions[name]();
      console.log(`production preflight step complete=${name}`);
    }
    console.log(`production preflight result=passed release_sha=${sha} migration_state=${migrationState}`);
    return;
  }
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
        inspected.Image !== PRODUCTION_BASELINE.apiImage ||
        inspected.Config.Image !== PRODUCTION_BASELINE.apiReference ||
        inspected.Config.Labels?.["org.opencontainers.image.revision"] !== PRODUCTION_BASELINE.apiRevision ||
        inspected.Config.Labels?.["com.docker.compose.project"] !==
          PRODUCTION.project
      )
        throw new Error(
          "Pre-migration failure: preserved production API baseline could not be verified; API remains stopped",
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
      await waitFor("http://127.0.0.1:8081/api/healthz", PRODUCTION_BASELINE.apiRevision);
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
