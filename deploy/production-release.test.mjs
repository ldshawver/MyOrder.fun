import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import {
  APPROVED_RELEASE,
  EXPECTED_PRODUCTION_MIGRATIONS,
  FROZEN_RELEASE,
  MIGRATION_0077,
  MIGRATION_0078,
  MIGRATION_0079,
  PRESERVED_SNAPSHOT,
  PRODUCTION_BASELINE,
  PRODUCTION,
  PRODUCTION_SMOKE_DOCKER_CHECKS,
  PRODUCTION_STEPS,
  PRE_RELEASE_SCHEMA_INVARIANTS,
  assertApprovedImageMetadata,
  assertPreReleaseSchemaInvariantDiagnostics,
  assertProductionConfig,
  assertRelease,
  assertReleaseIdentityManifest,
  assertReusableReleaseIdentity,
  classifyMigrationLineage,
  assertKnownNonWriterService,
  assertNoEncryptedProductionPayPalSettings,
  assertPublicCatalogSmokePayload,
  assertPlatformSmokeDocument,
  executeProductionSequence,
  loadPreservedSnapshot,
  mayRestoreRollbackApi,
  preReleaseSchemaDiagnosticSql,
  requestLoopbackJsonWithHost,
  readSmokeComposeServiceInventory,
  readSmokeRecentServiceLogs,
  runSmokeDockerCheck,
  sameWriterInventory,
  selectPreservedSnapshotMetadata,
} from "./production-release.mjs";

function captureSuccessfulDockerSpawn() {
  const calls = [];
  return {
    calls,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, signal: null, stdout: "[]", stderr: "" };
    },
  };
}

function assertPinnedSmokeComposeEnvironment(options) {
  assert.equal(options.encoding, "utf8");
  assert.equal(options.env.DEPLOY_SHA, APPROVED_RELEASE.sha);
  assert.equal(
    options.env.MYORDER_API_IMAGE,
    `ghcr.io/ldshawver/myorder-api@${APPROVED_RELEASE.manifests.api}`,
  );
  assert.equal(
    options.env.MYORDER_PLATFORM_IMAGE,
    `ghcr.io/ldshawver/myorder-platform@${APPROVED_RELEASE.manifests.platform}`,
  );
  assert.equal(
    options.env.MYORDER_MIGRATE_IMAGE,
    `ghcr.io/ldshawver/myorder-migrate@${APPROVED_RELEASE.manifests.migrate}`,
  );
  assert.equal(options.env.WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED, "false");
}

test("production smoke Compose service inventory uses the pinned release environment", () => {
  const compose = { args: ["compose", "--project-name", PRODUCTION.project] };
  const capture = captureSuccessfulDockerSpawn();
  readSmokeComposeServiceInventory(compose, capture.spawn);
  assert.equal(capture.calls.length, 1);
  assert.equal(capture.calls[0].command, "docker");
  assert.deepEqual(capture.calls[0].args, [
    ...compose.args,
    "ps",
    "--format",
    "json",
  ]);
  assertPinnedSmokeComposeEnvironment(capture.calls[0].options);
});

test("production smoke Compose log review uses the pinned release environment", () => {
  const compose = { args: ["compose", "--project-name", PRODUCTION.project] };
  const capture = captureSuccessfulDockerSpawn();
  readSmokeRecentServiceLogs(compose, capture.spawn);
  assert.equal(capture.calls.length, 1);
  assert.equal(capture.calls[0].command, "docker");
  assert.deepEqual(capture.calls[0].args, [
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
  assertPinnedSmokeComposeEnvironment(capture.calls[0].options);
});

for (const [checkName, label] of Object.entries(
  PRODUCTION_SMOKE_DOCKER_CHECKS,
)) {
  test(`production smoke Docker failure identifies ${checkName} without exposing process data`, () => {
    const sensitive = "client_secret=do-not-print customer@example.test";
    const failingSpawn = () => ({
      status: 17,
      signal: null,
      error: undefined,
      stdout: sensitive,
      stderr: sensitive,
    });
    assert.throws(
      () =>
        runSmokeDockerCheck(
          label,
          ["sensitive-command-argument"],
          {},
          failingSpawn,
        ),
      (error) => {
        assert.match(
          error.message,
          new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
        assert.match(
          error.message,
          /exit=17 signal=none error_code=none context=stderr-redacted/,
        );
        assert.doesNotMatch(
          error.message,
          /do-not-print|customer@example|sensitive-command-argument/,
        );
        return true;
      },
    );
  });
}

test("production smoke Docker failure context uses safe categories instead of raw stderr", () => {
  const label = PRODUCTION_SMOKE_DOCKER_CHECKS.containerMetadataInspection;
  assert.throws(
    () =>
      runSmokeDockerCheck(label, ["inspect", "sensitive-id"], {}, () => ({
        status: 1,
        signal: "SIGTERM",
        error: { code: "ENOENT", message: "do-not-print" },
        stdout: "",
        stderr: "Error response from daemon: No such container: sensitive-id",
      })),
    (error) => {
      assert.match(error.message, /signal=SIGTERM error_code=ENOENT context=container-not-found/);
      assert.doesNotMatch(error.message, /sensitive-id|do-not-print|Error response/);
      return true;
    },
  );
});

test("every final-smoke Docker subprocess uses a specific safe diagnostic label", () => {
  const controller = readFileSync(
    new URL("./production-release.mjs", import.meta.url),
    "utf8",
  );
  const start = controller.indexOf("    smoke: async () => {");
  const end = controller.indexOf("\n    },\n  };", start);
  assert.ok(start >= 0 && end > start);
  const smoke = controller.slice(start, end);
  for (const checkName of [
    "activeTenantProjection",
    "catalogueEligibilityProjection",
    "projectContainerInventory",
    "containerMetadataInspection",
  ])
    assert.match(
      smoke,
      new RegExp(`PRODUCTION_SMOKE_DOCKER_CHECKS\\.${checkName}`),
    );
  assert.match(smoke, /readSmokeComposeServiceInventory\(compose\)/);
  assert.match(smoke, /readSmokeRecentServiceLogs\(compose\)/);
  assert.doesNotMatch(smoke, /\brun\("docker"/);
});

const releaseRoot = path.join(PRODUCTION.root, "releases", APPROVED_RELEASE.sha);
const archivePath = path.join(
  PRODUCTION.root,
  "incoming",
  `${APPROVED_RELEASE.sha}.tar.gz`,
);
const preservedSnapshotCandidate = () => ({
  metadataPath: `/safe/${PRESERVED_SNAPSHOT.archiveName}.metadata.json`,
  metadata: {
    sourceApiRevision: PRESERVED_SNAPSHOT.sourceApiRevision,
    sourceApiImage: PRESERVED_SNAPSHOT.sourceApiImage,
    sourcePlatformRevision: PRESERVED_SNAPSHOT.sourcePlatformRevision,
    sourcePlatformImage: PRESERVED_SNAPSHOT.sourcePlatformImage,
    targetSha: PRESERVED_SNAPSHOT.targetSha,
    targetTree: PRESERVED_SNAPSHOT.targetTree,
    productionProject: PRODUCTION.project,
    database: PRODUCTION.database,
    ledgerRows: 51,
    ledger: Array.from({ length: 51 }, (_, index) => `${index + 1}|hash|${index + 1}`).join("\n"),
    representativeCounts: "orders=1;inventory_transaction_log=2;inventory_reservations=3;inventory_balances=4;catalog_items=5;order_items=6",
    archiveSha256: PRESERVED_SNAPSHOT.archiveSha256,
  },
});
const productionClerkPublishableKey = `pk_live_${Buffer.from("clerk.myorder.fun$").toString("base64url")}`;
const expectedConfig = {
  name: "deploy",
  services: {
    api: {
      image: APPROVED_RELEASE.references.api,
      environment: {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://app@db:5432/alavont",
        CLERK_SECRET_KEY: "sk_live_masked",
        CLERK_PUBLISHABLE_KEY: productionClerkPublishableKey,
        CLERK_PROXY_URL: "https://myorder.fun/api/__clerk",
        SESSION_SECRET: "masked",
        SETTINGS_ENC_KEY: "masked",
        MYORDER_OWNER_CLERK_ID: "user_testowner",
        WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED: "false",
        RECEIPT_PRINT_ENABLED: "false",
        LABEL_PRINT_ENABLED: "false",
        ORDER_NOTIFICATION_WORKER_ENABLED: "0",
        PAYMENT_MODE: "disabled",
        PAYPAL_ENVIRONMENT: "",
        PAYPAL_CLIENT_ID: "",
        PAYPAL_CLIENT_SECRET: "",
        PAYPAL_WEBHOOK_ID: "",
      },
      volumes: [
        {
          source: "/opt/alavont/shared/print-assets",
          target: "/var/lib/myorder/print-assets",
        },
      ],
    },
    platform: { image: APPROVED_RELEASE.references.platform, build: { args: {
      VITE_CLERK_PUBLISHABLE_KEY: productionClerkPublishableKey,
      VITE_CLERK_PROXY_URL: "https://myorder.fun/api/__clerk",
    } } },
    db: {
      environment: {
        POSTGRES_DB: "alavont",
        POSTGRES_USER: "alavont_user",
        POSTGRES_PASSWORD: "masked",
      },
    },
    migrate: {
      image: APPROVED_RELEASE.references.migrate,
      environment: { DATABASE_URL: "postgres://app@db:5432/alavont" },
    },
    nginx: { ports: ["127.0.0.1:8081:80"] },
  },
  volumes: { postgres_data: { name: "deploy_postgres_data" } },
  networks: {
    internal: { name: "deploy_internal" },
    external: { name: "deploy_external" },
  },
};

test("public catalogue smoke gate validates the API items response contract", () => {
  assert.equal(
    assertPublicCatalogSmokePayload({ items: [{ id: 1 }], total: 304 }, 304),
    1,
  );
  assert.throws(
    () => assertPublicCatalogSmokePayload({ items: [{ id: 1 }], total: 304 }, 303),
    /eligibility projection/,
  );
  assert.throws(
    () => assertPublicCatalogSmokePayload({ products: [{ id: 1 }], total: 1 }),
    /returned no items/,
  );
  assert.throws(
    () => assertPublicCatalogSmokePayload({ items: [], total: 0 }),
    /returned no items/,
  );
});

test("sign-in and POS shell smoke gates require the production HTML application", () => {
  const response = { ok: true, status: 200, headers: { get: () => "text/html; charset=utf-8" } };
  assert.equal(assertPlatformSmokeDocument(response, '<main id="root"></main>', "sign-in"), 200);
  assert.throws(() => assertPlatformSmokeDocument({ ...response, ok: false }, '<main id="root"></main>', "POS shell"), /POS shell/);
  assert.throws(() => assertPlatformSmokeDocument(response, "not the app", "sign-in"), /sign-in/);
});

test("accepts only the approved frozen release identity and immutable release path", () => {
  assert.equal(
    assertRelease({
      sha: APPROVED_RELEASE.sha,
      tree: APPROVED_RELEASE.tree,
      releaseRoot,
      archivePath,
      archiveSha256: "a".repeat(64),
    }),
    true,
  );
  assert.throws(() => assertReleaseIdentityManifest(
    { baseSha: FROZEN_RELEASE.sha, baseTree: FROZEN_RELEASE.tree, sha: "b".repeat(40), tree: APPROVED_RELEASE.tree },
    { sha: APPROVED_RELEASE.sha, tree: APPROVED_RELEASE.tree },
  ), /protected candidate identity/);
  assert.equal(assertReleaseIdentityManifest(
    { baseSha: FROZEN_RELEASE.sha, baseTree: FROZEN_RELEASE.tree, sha: APPROVED_RELEASE.sha, tree: APPROVED_RELEASE.tree },
    { sha: APPROVED_RELEASE.sha, tree: APPROVED_RELEASE.tree },
  ), true);
  assert.throws(
    () =>
      assertRelease({
        sha: APPROVED_RELEASE.sha,
        tree: APPROVED_RELEASE.tree,
        releaseRoot: PRODUCTION.root,
        archivePath,
        archiveSha256: "a".repeat(64),
      }),
    /directory/,
  );
  assert.throws(
    () =>
      assertRelease({
        sha: APPROVED_RELEASE.sha,
        tree: APPROVED_RELEASE.tree,
        releaseRoot,
        archivePath: "/opt/alavont/deploy/.env",
        archiveSha256: "a".repeat(64),
      }),
    /incoming/,
  );
  assert.throws(
    () =>
      assertRelease({
        sha: FROZEN_RELEASE.sha,
        tree: APPROVED_RELEASE.tree,
        releaseRoot,
        archivePath,
        archiveSha256: "a".repeat(64),
      }),
    /approved immutable candidate/,
  );
});

test("production preflight is separately authorized and cannot reach mutation steps", () => {
  const controller = readFileSync(new URL("./production-release.mjs", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const start = controller.indexOf('if (command === "preflight")');
  const end = controller.indexOf("  try {", start);
  const preflight = controller.slice(start, end);
  assert.ok(start > 0 && end > start);
  for (const step of ["validate", "verify-release-images", "validate-lineage", "verify-writer-inventory"])
    assert.ok(preflight.includes(step));
  assert.doesNotMatch(preflight, /stop-writers|snapshot|restore-rehearsal|migrate|start-api|start-platform-proxy/);
  assert.match(workflow, /I_AUTHORIZE_PRODUCTION_PREFLIGHT/);
  assert.match(workflow, /inputs\.release_action == 'preflight'/);
  assert.match(workflow, /inputs\.release_action == 'deploy'/);
  assert.match(workflow, /if: \$\{\{ inputs\.release_action == 'deploy' \}\}/);
});

test("production public catalogue smoke sends the exact MyOrder host over loopback", async () => {
  const controller = readFileSync(new URL("./production-release.mjs", import.meta.url), "utf8");
  const observed = {};
  const requestImpl = (target, options, callback) => {
    observed.url = target.href;
    observed.host = options.headers.host;
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => request.emit("error", error);
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => response;
      callback(response);
      response.emit("data", JSON.stringify({ items: [{ id: 1 }], total: 1 }));
      response.emit("end");
    });
    return request;
  };
  const result = await requestLoopbackJsonWithHost(
    "http://127.0.0.1:8081/api/public/catalog",
    "myorder.fun",
    10_000,
    requestImpl,
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { items: [{ id: 1 }], total: 1 });
  assert.deepEqual(observed, {
    url: "http://127.0.0.1:8081/api/public/catalog",
    host: "myorder.fun",
  });
  assert.match(controller, /requestLoopbackJsonWithHost\(\s*"http:\/\/127\.0\.0\.1:8081\/api\/public\/catalog",\s*"myorder\.fun"/);
  assert.doesNotMatch(controller, /headers: \{ host: "shop\.lucifercruz\.com" \}/);
  assert.match(controller, /Production MyOrder public catalogue smoke test failed/);
});

test("production loopback smoke request rejects non-loopback targets and invalid hosts", () => {
  assert.throws(
    () => requestLoopbackJsonWithHost("https://myorder.fun/api/public/catalog", "myorder.fun"),
    /IPv4 loopback/,
  );
  assert.throws(
    () => requestLoopbackJsonWithHost("http://127.0.0.1:8081/api/public/catalog", "myorder.fun:8081"),
    /host must be myorder\.fun/,
  );
});

test("production nginx keeps the Clerk browser proxy outside the general API rate limit", () => {
  const nginx = readFileSync(new URL("./nginx/nginx.conf", import.meta.url), "utf8");
  const clerk = nginx.match(/location \^~ \/api\/__clerk\/ \{([\s\S]*?)\n        \}/)?.[1] ?? "";
  const api = nginx.match(/location \/api\/ \{([\s\S]*?)\n        \}/)?.[1] ?? "";
  assert.match(clerk, /proxy_pass \$api_host/);
  assert.doesNotMatch(clerk, /limit_req/);
  assert.match(api, /limit_req zone=api burst=60 nodelay/);
});

test("isolated restore schema diagnostics name only safe expected and actual facts", () => {
  const passing = PRE_RELEASE_SCHEMA_INVARIANTS.map(({ id, expected }) => ({ id, actual: expected }));
  assert.equal(assertPreReleaseSchemaInvariantDiagnostics(passing), true);

  const missingIndex = structuredClone(passing);
  missingIndex.find(({ id }) => id === "public.orders_tenant_id_id_unique").actual = "missing";
  assert.throws(
    () => assertPreReleaseSchemaInvariantDiagnostics(missingIndex),
    /public\.orders_tenant_id_id_unique expected=matching unique index actual=missing/,
  );

  const unsafe = structuredClone(passing);
  unsafe[0].actual = "customer@example.test";
  assert.throws(
    () => assertPreReleaseSchemaInvariantDiagnostics(unsafe),
    (error) => /unsafe or unknown value/.test(error.message) && !error.message.includes("customer@example.test"),
  );
  assert.throws(
    () => assertPreReleaseSchemaInvariantDiagnostics(passing.slice(1)),
    /result set is incomplete/,
  );
});

test("pre-release slug uniqueness requires the canonical valid and ready lower(slug) index", () => {
  const passing = PRE_RELEASE_SCHEMA_INVARIANTS.map(({ id, expected }) => ({ id, actual: expected }));
  assert.equal(assertPreReleaseSchemaInvariantDiagnostics(passing), true);
  assert.ok(passing.some(({ id }) => id === "public.tenants_slug_ci_unique_idx"));
  assert.ok(!passing.some(({ id }) => id === "public.tenants_slug_unique"));

  const obsoleteOnly = passing.map((fact) =>
    fact.id === "public.tenants_slug_ci_unique_idx"
      ? { id: "public.tenants_slug_unique", actual: "matching unique index" }
      : fact,
  );
  assert.throws(
    () => assertPreReleaseSchemaInvariantDiagnostics(obsoleteOnly),
    /unsafe or unknown value/,
  );

  const sql = preReleaseSchemaDiagnosticSql();
  assert.match(sql, /index_class\.relname='tenants_slug_ci_unique_idx'/);
  assert.match(sql, /i\.indisunique AND i\.indisvalid AND i\.indisready/);
  assert.match(sql, /i\.indnatts=1 AND i\.indnkeyatts=1/);
  assert.match(sql, /i\.indpred IS NULL/);
  assert.match(sql, /pg_get_indexdef\(i\.indexrelid, 1, true\)='lower\(slug\)'/);
  assert.doesNotMatch(sql, /tenants_slug_unique/);
});

test("preserved snapshot selection pins the rehearsed archive and ignores extra snapshots", () => {
  const candidate = preservedSnapshotCandidate();
  const extra = structuredClone(candidate);
  extra.metadataPath = "/safe/alavont-before-5dd5b258f0b932e9a9ea4888af00a857d7d10146-extra.dump.metadata.json";
  assert.equal(selectPreservedSnapshotMetadata([extra, candidate]), candidate);
});

test("preserved snapshot selection refuses a missing pinned snapshot", () => {
  assert.throws(() => selectPreservedSnapshotMetadata([]), /metadata is missing/);
});

test("preserved snapshot selection refuses a pinned checksum mismatch", () => {
  const candidate = preservedSnapshotCandidate();
  candidate.metadata.archiveSha256 = "a".repeat(64);
  assert.throws(() => selectPreservedSnapshotMetadata([candidate]), /checksum differs/);
});

test("preserved snapshot loading hashes the pinned archive against the approved digest", async () => {
  const backupRoot = mkdtempSync(path.join(tmpdir(), "myorder-pinned-snapshot-"));
  try {
    const candidate = preservedSnapshotCandidate();
    candidate.metadataPath = path.join(backupRoot, `${PRESERVED_SNAPSHOT.archiveName}.metadata.json`);
    const archivePath = path.join(backupRoot, PRESERVED_SNAPSHOT.archiveName);
    writeFileSync(candidate.metadataPath, `${JSON.stringify(candidate.metadata)}\n`, { mode: 0o600 });
    writeFileSync(archivePath, "not-the-approved-archive", { mode: 0o600 });
    writeFileSync(`${archivePath}.sha256`, `${PRESERVED_SNAPSHOT.archiveSha256}  ${PRESERVED_SNAPSHOT.archiveName}\n`, { mode: 0o600 });
    writeFileSync(`${archivePath}.toc`, "TABLE DATA", { mode: 0o600 });
    await assert.rejects(() => loadPreservedSnapshot(backupRoot), /archive SHA-256 differs from the approved digest/);
  } finally {
    rmSync(backupRoot, { recursive: true, force: true });
  }
});

test("preserved snapshot selection refuses the wrong release baseline", () => {
  const candidate = preservedSnapshotCandidate();
  const wrongBaseline = structuredClone(candidate);
  wrongBaseline.metadata.sourceApiImage = "sha256:" + "b".repeat(64);
  assert.throws(() => selectPreservedSnapshotMetadata([wrongBaseline]), /approved release baseline/);
});

test("rehearsal command uses only the preserved snapshot and isolated restore path", () => {
  const controller = readFileSync(new URL("./production-release.mjs", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const start = controller.indexOf('if (command === "rehearsal")');
  const end = controller.indexOf('if (command === "preflight")', start);
  const rehearsal = controller.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(rehearsal, /loadPreservedSnapshot\(backupRoot\)/);
  assert.match(rehearsal, /restoreSnapshotInIsolation\(preservedSnapshot\)/);
  assert.doesNotMatch(rehearsal, /executeProductionSequence|createSnapshot|stop-writers|start-api|start-platform-proxy/);
  assert.match(workflow, /I_AUTHORIZE_PRODUCTION_RESTORE_REHEARSAL/);
  assert.match(workflow, /rehearsal\) CONTROLLER_CONFIRMATION=REHEARSE-PRODUCTION-SNAPSHOT/);
  assert.match(workflow, /if: \$\{\{ inputs\.release_action == 'deploy' \}\}/);
});

test("production Compose is pinned to the production database, release images, volume and loopback proxy", () => {
  assert.equal(
    assertProductionConfig(expectedConfig, {
      apiImage: APPROVED_RELEASE.references.api,
      platformImage: APPROVED_RELEASE.references.platform,
      migrateImage: APPROVED_RELEASE.references.migrate,
    }),
    true,
  );
  const staging = structuredClone(expectedConfig);
  staging.name = "myorder-staging";
  assert.throws(() => assertProductionConfig(staging), /project/);
  const wrongDb = structuredClone(expectedConfig);
  wrongDb.services.api.environment.DATABASE_URL =
    "postgres://app@db:5432/myorder_staging";
  assert.throws(() => assertProductionConfig(wrongDb), /production database/);
  const wrongVolume = structuredClone(expectedConfig);
  wrongVolume.volumes.postgres_data.name = "myorder-staging_postgres_data";
  assert.throws(() => assertProductionConfig(wrongVolume), /volume/);
  const missingAuth = structuredClone(expectedConfig);
  missingAuth.services.api.environment.SESSION_SECRET = "";
  assert.throws(() => assertProductionConfig(missingAuth), /SESSION_SECRET/);
  const testClerk = structuredClone(expectedConfig);
  testClerk.services.api.environment.CLERK_SECRET_KEY = "sk_test_masked";
  assert.throws(() => assertProductionConfig(testClerk), /live instance/);
  const mismatchedClerk = structuredClone(expectedConfig);
  mismatchedClerk.services.platform.build.args.VITE_CLERK_PUBLISHABLE_KEY = `pk_live_${Buffer.from("other.example$").toString("base64url")}`;
  assert.throws(() => assertProductionConfig(mismatchedClerk), /do not match/);
  const wrongClerkProxy = structuredClone(expectedConfig);
  wrongClerkProxy.services.platform.build.args.VITE_CLERK_PROXY_URL = "https://clerk.myorder.fun";
  assert.throws(() => assertProductionConfig(wrongClerkProxy), /proxy URLs/);
  assert.equal(assertProductionConfig(expectedConfig), true);
  const enabledWoo = structuredClone(expectedConfig);
  enabledWoo.services.api.environment.WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED = "true";
  assert.throws(() => assertProductionConfig(enabledWoo), /remain explicitly disabled/);
  const missingWooPolicy = structuredClone(expectedConfig);
  delete missingWooPolicy.services.api.environment.WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED;
  assert.throws(() => assertProductionConfig(missingWooPolicy), /remain explicitly disabled/);
  const wrongRole = structuredClone(expectedConfig);
  wrongRole.services.db.environment.POSTGRES_USER = "staging_user";
  assert.throws(() => assertProductionConfig(wrongRole), /PostgreSQL role/);
  const wrongRelease = structuredClone(expectedConfig);
  wrongRelease.services.api.image = "myorder-api:other";
  assert.throws(
    () =>
      assertProductionConfig(wrongRelease, {
        apiImage: APPROVED_RELEASE.references.api,
      }),
    /frozen release/,
  );
  const wrongMigrator = structuredClone(expectedConfig);
  wrongMigrator.services.migrate.image = "myorder-migrate:other";
  assert.throws(() => assertProductionConfig(wrongMigrator, {
    apiImage: APPROVED_RELEASE.references.api,
    platformImage: APPROVED_RELEASE.references.platform,
    migrateImage: APPROVED_RELEASE.references.migrate,
  }), /Migration image/);
  const enabledPaypal = structuredClone(expectedConfig);
  enabledPaypal.services.api.environment.PAYMENT_MODE = "live";
  assert.throws(() => assertProductionConfig(enabledPaypal), /fail-closed/);
  const enabledUberDispatch = structuredClone(expectedConfig);
  enabledUberDispatch.services.api.environment.UBER_DIRECT_DISPATCH_ENABLED =
    "true";
  assert.throws(
    () => assertProductionConfig(enabledUberDispatch),
    /Uber dispatch/,
  );
  const configuredOrderLight = structuredClone(expectedConfig);
  Object.assign(configuredOrderLight.services.api.environment, {
    ORDER_NOTIFICATION_WORKER_ENABLED: "1",
    TUYA_TENANT_ID: "10",
    TUYA_CLIENT_ID: "client",
    TUYA_CLIENT_SECRET: "secret",
    TUYA_API_BASE_URL: "https://openapi.tuyaus.com/",
    TUYA_DEVICE_ID: "device",
  });
  assert.equal(assertProductionConfig(configuredOrderLight), true);
  for (const name of ["TUYA_TENANT_ID", "TUYA_CLIENT_ID", "TUYA_CLIENT_SECRET", "TUYA_API_BASE_URL", "TUYA_DEVICE_ID"]) {
    const missing = structuredClone(configuredOrderLight);
    missing.services.api.environment[name] = "";
    assert.throws(() => assertProductionConfig(missing), /order light/);
  }
  const unapprovedTuyaHost = structuredClone(configuredOrderLight);
  unapprovedTuyaHost.services.api.environment.TUYA_API_BASE_URL = "https://example.test/";
  assert.throws(() => assertProductionConfig(unapprovedTuyaHost), /not approved/);
});

test("release deploys only digest-pinned approved artifacts with external Woo disabled", () => {
  assert.deepEqual(PRODUCTION_STEPS.slice(0, 3), [
    "validate",
    "verify-release-images",
    "validate-lineage",
  ]);
  assert.equal(PRODUCTION_STEPS.includes("build"), false);
  const overlay = readFileSync(new URL("./production-runtime-overlay.yml", import.meta.url), "utf8");
  assert.match(overlay, /image: \$\{MYORDER_API_IMAGE:\?approved API image is required\}/);
  assert.match(overlay, /image: \$\{MYORDER_PLATFORM_IMAGE:\?approved Platform image is required\}/);
  assert.match(overlay, /image: \$\{MYORDER_MIGRATE_IMAGE:\?approved Migrator image is required\}/);
  assert.equal((overlay.match(/pull_policy: never/g) ?? []).length, 3);
  assert.match(overlay, /WOOCOMMERCE_EXTERNAL_INTEGRATION_ENABLED: "false"/);
  assert.match(overlay, /RECEIPT_PRINT_ENABLED: "false"/);
  assert.match(overlay, /LABEL_PRINT_ENABLED: "false"/);
  assert.match(overlay, /ORDER_NOTIFICATION_WORKER_ENABLED: \$\{ORDER_NOTIFICATION_WORKER_ENABLED:-0\}/);
  const controller = readFileSync(new URL("./production-release.mjs", import.meta.url), "utf8");
  assert.match(controller, /docker", \["image", "inspect", reference\]/);
  assert.match(controller, /docker", \["manifest", "inspect", reference\]/);
  assert.match(controller, /"--pull", "never", "--no-build"/);
  assert.doesNotMatch(controller, /compose\.args, "build"/);
});

test("reuses only the exact immutable staged release identity", () => {
  const expected = {
    sha: APPROVED_RELEASE.sha,
    tree: APPROVED_RELEASE.tree,
    archiveSha256: "a".repeat(64),
    toolingSha: "b".repeat(40),
  };
  assert.equal(assertReusableReleaseIdentity({ ...expected }, expected), true);
  for (const field of ["sha", "tree", "archiveSha256"]) {
    assert.throws(
      () =>
        assertReusableReleaseIdentity(
          { ...expected, [field]: "0".repeat(expected[field].length) },
          expected,
        ),
      /does not match/,
    );
  }
  assert.equal(
    assertReusableReleaseIdentity(
      { ...expected, toolingSha: "c".repeat(40) },
      expected,
    ),
    true,
  );
});

test("allowlists only the exact localhost Vite preview service identity", () => {
  const properties = {
    Id: "myorder-preview.service",
    ActiveState: "active",
    SubState: "running",
    User: "serveradmin",
    Group: "serveradmin",
    ExecStart:
      "{ path=/usr/bin/npm ; argv[]=/usr/bin/npm run preview -- --host 127.0.0.1 --port 4173 ; ignore_errors=no ; }",
    WorkingDirectory: "/home/serveradmin/worktrees/myorder-preview",
    FragmentPath: "/etc/systemd/system/myorder-preview.service",
    EnvironmentFiles: "",
  };
  assert.equal(
    assertKnownNonWriterService("myorder-preview.service", properties),
    true,
  );
  assert.throws(
    () =>
      assertKnownNonWriterService("myorder-preview.service", {
        ...properties,
        ExecStart:
          "{ path=/usr/bin/npm ; argv[]=/usr/bin/npm run worker ; ignore_errors=no ; }",
      }),
    /command mismatch/,
  );
  assert.throws(
    () => assertKnownNonWriterService("unknown.service", properties),
    /not an approved non-writer/,
  );
});

test("deployment ordering stops all writers and verifies the protected snapshot before migration", async () => {
  const observed = [];
  const actions = Object.fromEntries(
    PRODUCTION_STEPS.map((step) => [step, async () => observed.push(step)]),
  );
  await executeProductionSequence(actions);
  assert.deepEqual(observed, [...PRODUCTION_STEPS]);
  assert.ok(observed.indexOf("verify-release-images") < observed.indexOf("validate-lineage"));
  assert.ok(
    observed.indexOf("validate-lineage") < observed.indexOf("stop-writers"),
  );
  assert.ok(
    observed.indexOf("verify-writers-stopped") ===
      observed.indexOf("stop-writers") + 1,
  );
  assert.ok(
    observed.indexOf("snapshot") ===
      observed.indexOf("verify-writers-stopped") + 1,
  );
  assert.ok(observed.indexOf("snapshot") < observed.indexOf("verify-snapshot"));
  assert.ok(
    observed.indexOf("verify-snapshot") < observed.indexOf("restore-rehearsal"),
  );
  assert.ok(
    observed.indexOf("restore-rehearsal") < observed.indexOf("migrate"),
  );
  assert.ok(
    observed.indexOf("verify-migration") < observed.indexOf("start-api"),
  );
  assert.ok(
    observed.indexOf("verify-api") < observed.indexOf("start-platform-proxy"),
  );
});

test("writer inventory recheck ignores runtime churn but rejects identity changes", () => {
  const baseline = new Map([
    ["api", {
      id: "api-container",
      image: "myorder-api@sha256:api",
      imageId: "sha256:api",
      revision: "release-sha",
      running: true,
      restartCount: 16,
      oomKilled: false,
    }],
    ["db", {
      id: "db-container",
      image: "postgres:16",
      imageId: "sha256:db",
      revision: "db-revision",
      running: true,
      restartCount: 0,
      oomKilled: false,
    }],
  ]);
  const runtimeChanged = new Map([
    ["api", {
      ...baseline.get("api"),
      running: false,
      restartCount: 17,
    }],
    ["db", { ...baseline.get("db"), restartCount: 1 }],
  ]);
  assert.equal(sameWriterInventory(baseline, runtimeChanged), true);

  const replaced = new Map(runtimeChanged);
  replaced.set("api", { ...runtimeChanged.get("api"), id: "replacement-container" });
  assert.equal(sameWriterInventory(baseline, replaced), false);

  const wrongImage = new Map(runtimeChanged);
  wrongImage.set("api", { ...runtimeChanged.get("api"), imageId: "sha256:other" });
  assert.equal(sameWriterInventory(baseline, wrongImage), false);
});

for (const failedGate of [
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
]) {
  test(`failure at ${failedGate} prevents all later production actions`, async () => {
    const observed = [];
    const actions = Object.fromEntries(
      PRODUCTION_STEPS.map((step) => [
        step,
        async () => {
          observed.push(step);
          if (step === failedGate) throw new Error("injected gate failure");
        },
      ]),
    );
    await assert.rejects(
      executeProductionSequence(actions),
      /injected gate failure/,
    );
    const failedIndex = PRODUCTION_STEPS.indexOf(failedGate);
    assert.deepEqual(observed, PRODUCTION_STEPS.slice(0, failedIndex + 1));
    assert.equal(
      observed.includes("migrate") &&
        failedIndex < PRODUCTION_STEPS.indexOf("migrate"),
      false,
    );
  });
}

test("pre-ingress API verification probes the SHA-bearing health endpoint", () => {
  const source = readFileSync(
    new URL("./production-release.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /fetch\('http:\/\/127\.0\.0\.1:8080\/api\/healthz'\)/);
});

test("missing production authorization is rejected by the executable entrypoint", () => {
  const source = readFileSync(
    new URL("./production-release.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /rehearsal: "REHEARSE-PRODUCTION-SNAPSHOT"/,
  );
  assert.match(source, /--authorized/);
});

test("production rollback baseline is the current pre-release image set", () => {
  assert.equal(PRODUCTION_BASELINE.apiImage, "sha256:a4379b10a1352294de14a6135d95325968d213465b92de5e769f051f5c227b16");
  assert.equal(PRODUCTION_BASELINE.apiRevision, "008af2262096ac856af4a784d37404141b8e63c3");
  assert.equal(PRODUCTION_BASELINE.apiReference, "ghcr.io/ldshawver/myorder-api@sha256:a4379b10a1352294de14a6135d95325968d213465b92de5e769f051f5c227b16");
  assert.equal(PRODUCTION_BASELINE.platformImage, "sha256:af58ac9f1fb41df3196b8af4a36f421c4103525e37feffb3bd9b802d53cd4612");
  assert.equal(PRODUCTION_BASELINE.platformRevision, "008af2262096ac856af4a784d37404141b8e63c3");
  assert.equal(PRODUCTION_BASELINE.platformReference, "ghcr.io/ldshawver/myorder-platform@sha256:af58ac9f1fb41df3196b8af4a36f421c4103525e37feffb3bd9b802d53cd4612");
  assert.equal(PRODUCTION_BASELINE.nginxImage, "sha256:8b1e78743a03dbb2c95171cc58639fef29abc8816598e27fb910ed2e621e589a");
  assert.equal(PRODUCTION_BASELINE.nginxReference, "nginx:alpine");
  assert.equal(PRODUCTION_BASELINE.databaseImage, "sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229");
  assert.equal(PRODUCTION_BASELINE.databaseReference, "postgres:16-alpine");
  assert.equal(PRESERVED_SNAPSHOT.sourceApiRevision, "3e5a5c833b93c0e5c345cb2d2f2f9537400d16cb");
  assert.equal(PRESERVED_SNAPSHOT.targetSha, "5dd5b258f0b932e9a9ea4888af00a857d7d10146");
  assert.equal(PRESERVED_SNAPSHOT.targetTree, "bd96df1c597e64d17c1aaa47f0d0201115a89173");
  assert.equal(PRESERVED_SNAPSHOT.archiveName, "alavont-before-5dd5b258f0b932e9a9ea4888af00a857d7d10146-20261022T103613Z.dump");
  assert.equal(PRESERVED_SNAPSHOT.archiveSha256, "059e28765fbdda27e9072497364e16b36e25e97968d4972c03326f4af2f2ac9e");
  assert.equal(PRESERVED_SNAPSHOT.rehearsalWorkflowRun, "39771000177");
  assert.deepEqual(Object.keys(APPROVED_RELEASE.manifests).sort(), ["api", "migrate", "platform"]);
  assert.deepEqual(Object.keys(APPROVED_RELEASE.configs).sort(), ["api", "migrate", "platform"]);
  assert.equal(APPROVED_RELEASE.manifests.api, "sha256:031c4808774da734cd3bb94a12708f6f9cdd0e248455a0991a3aa71800af47c0");
  assert.equal(APPROVED_RELEASE.manifests.migrate, "sha256:d9914a9de63b1dbf1afe3ae41384e7f49b5ae052fe6d8fece506c31709e6c94f");
  assert.equal(APPROVED_RELEASE.manifests.platform, "sha256:dca78cac9ba8a0cc3a021337fdf1ef434b85d3b8a225b86d0f0f992ce3924d1e");
  assert.equal(APPROVED_RELEASE.configs.api, "sha256:33f345ff602983ea3d52ffdf9280f122b2f8cce71bc4429ba96f665b2308ae1f");
  assert.equal(APPROVED_RELEASE.configs.migrate, "sha256:99842c62f7acd8c9984fb469a103b5bcb3e3defa57eaf38a09a7a9889299b1a5");
  assert.equal(APPROVED_RELEASE.configs.platform, "sha256:a2e759d53ee15b21de950046817876d42be68a768242abfb9ed538e96c8b80f0");
  assert.equal(APPROVED_RELEASE.revisions.api, APPROVED_RELEASE.sha);
  assert.equal(APPROVED_RELEASE.revisions.platform, APPROVED_RELEASE.sha);
  assert.equal(APPROVED_RELEASE.revisions.migrate, APPROVED_RELEASE.sha);
  assert.equal(APPROVED_RELEASE.references.api, "ghcr.io/ldshawver/myorder-api@sha256:031c4808774da734cd3bb94a12708f6f9cdd0e248455a0991a3aa71800af47c0");
  assert.equal(APPROVED_RELEASE.references.migrate, "ghcr.io/ldshawver/myorder-migrate@sha256:d9914a9de63b1dbf1afe3ae41384e7f49b5ae052fe6d8fece506c31709e6c94f");
  assert.equal(APPROVED_RELEASE.references.platform, "ghcr.io/ldshawver/myorder-platform@sha256:dca78cac9ba8a0cc3a021337fdf1ef434b85d3b8a225b86d0f0f992ce3924d1e");
  assert.deepEqual(EXPECTED_PRODUCTION_MIGRATIONS, ["0079_verified_zero_opening_counts"]);
  assert.equal(MIGRATION_0077.timestamp, "1792440000000");
  assert.equal(MIGRATION_0077.sha256, "29b98289bd97b1c4781495a93d3d034f03a0daa503a96adfda035d2a3aeecd6b");
  assert.equal(MIGRATION_0078.timestamp, "1792785600000");
  assert.equal(MIGRATION_0078.sha256, "9d62687484ce3bdea6a0b127411643125739ec198644793b247313a92b2b78a4");
  assert.equal(MIGRATION_0079.timestamp, "1793044800000");
  assert.equal(MIGRATION_0079.sha256, "04105fcffc7f6219c4059a34739d4f26d96a233aa58a8a063e80e98ba4758aa6");
  assert.equal(
    mayRestoreRollbackApi({ apiStopAttempted: true, migrationStarted: false }),
    true,
  );
  assert.equal(
    mayRestoreRollbackApi({ apiStopAttempted: true, migrationStarted: true }),
    false,
  );
  assert.equal(
    mayRestoreRollbackApi({ apiStopAttempted: false, migrationStarted: false }),
    false,
  );
});

test("candidate builder and deployment approval are frozen to the exact verified source", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/build-production-platform.yml", import.meta.url),
    "utf8",
  );
  const proposed = {
    sha: "68edc6a4e64876c146c82c21ca47f8abcf6b392f",
    tree: "015b406605eaa070c5f13f50dea5ce9f925ef5ab",
  };
  assert.match(workflow, new RegExp(`SOURCE_SHA: ${proposed.sha}`));
  assert.match(workflow, new RegExp(`SOURCE_TREE: ${proposed.tree}`));
  assert.match(workflow, new RegExp(`ref: ${proposed.sha}`));
  assert.equal(workflow.match(new RegExp(proposed.sha, "g"))?.length, 5);
  assert.equal(proposed.sha, APPROVED_RELEASE.sha);
  assert.equal(proposed.tree, APPROVED_RELEASE.tree);
  assert.doesNotMatch(workflow, /:latest(?:\s|$)/);
  assert.match(workflow, /\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
});

test("migration lineage classifier accepts only the ordered 0079 continuation after applied 0077 and 0078", () => {
  assert.equal(
    classifyMigrationLineage(
      "[migration-ledger] APPLIED 0077_catalogue_inventory_reconciliation hash\n[migration-ledger] APPLIED 0078_inventory_history_baseline_repair hash\n[migration-ledger] APPLIED 0079_verified_zero_opening_counts hash\n[migration-ledger] recognized lineage preserved: 54/54\n",
    ),
    "applied",
  );
  assert.equal(
    classifyMigrationLineage(
      "[migration-ledger] APPLIED 0077_catalogue_inventory_reconciliation hash\n[migration-ledger] APPLIED 0078_inventory_history_baseline_repair hash\n[migration-ledger] PENDING 0079_verified_zero_opening_counts hash\n[migration-ledger] recognized lineage preserved: 53/54\n",
    ),
    "pending",
  );
  assert.throws(
    () => classifyMigrationLineage("[migration-ledger] recognized lineage preserved: 53/54\n"),
    /neither the exact 53-row pre-0079 path nor the verified 54-row applied lineage/,
  );
  assert.throws(
    () => classifyMigrationLineage(
      "[migration-ledger] APPLIED 0077_catalogue_inventory_reconciliation hash\n[migration-ledger] PENDING 0078_inventory_history_baseline_repair hash\n[migration-ledger] PENDING 0079_verified_zero_opening_counts hash\n[migration-ledger] recognized lineage preserved: 52/54\n",
    ),
    /neither the exact 53-row pre-0079 path nor the verified 54-row applied lineage/,
  );
});

test("approved image gate keeps manifest, repository, config and metadata identities separate", () => {
  const reference = APPROVED_RELEASE.references.api;
  const image = {
    Id: APPROVED_RELEASE.manifests.api,
    RepoDigests: [reference],
    Os: "linux",
    Architecture: "amd64",
    Config: {
      Labels: {
        "org.opencontainers.image.revision": APPROVED_RELEASE.sha,
        "com.myorder.deploy-sha": APPROVED_RELEASE.sha,
      },
    },
  };
  const manifest = { config: { digest: APPROVED_RELEASE.configs.api } };

  assert.equal(assertApprovedImageMetadata({ service: "api", reference, image, manifest }), true);
  assert.throws(
    () => assertApprovedImageMetadata({ service: "api", reference: reference.replace("myorder-api", "other"), image, manifest }),
    /repository manifest reference/,
  );
  assert.throws(
    () => assertApprovedImageMetadata({ service: "api", reference, image: { ...image, RepoDigests: [] }, manifest }),
    /immutable digest reference/,
  );
  assert.throws(
    () => assertApprovedImageMetadata({ service: "api", reference, image: { ...image, Id: "sha256:wrong" }, manifest }),
    /local image identity/,
  );
  assert.throws(
    () => assertApprovedImageMetadata({ service: "api", reference, image, manifest: { config: { digest: "sha256:wrong" } } }),
    /config digest/,
  );
  assert.throws(
    () => assertApprovedImageMetadata({ service: "api", reference, image: { ...image, Architecture: "arm64" }, manifest }),
    /image metadata/,
  );
  assert.throws(
    () => assertApprovedImageMetadata({ service: "api", reference, image: { ...image, Config: { Labels: {} } }, manifest }),
    /image metadata/,
  );
});

test("production PayPal configuration stays fail-closed in Release 1", () => {
  assert.equal(assertNoEncryptedProductionPayPalSettings(0), true);
  assert.throws(
    () => assertNoEncryptedProductionPayPalSettings(1),
    /provider readiness/,
  );
});

test("approved P0 patch identity and rerun semantics are verified without changing the Drizzle ledger", () => {
  const sql = readFileSync(new URL("./hotfix-owner-approval.sql", import.meta.url), "utf8");
  const digest = createHash("sha256").update(sql).digest("hex");
  assert.equal(digest, "cd496d318643c3f485a563445ae5d3f59b3f4ea79d991108b2e7c17dd83db54a");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS approved_by_clerk_id/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS approved_at/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS users_owner_approval_provenance_idx/);
  assert.match(sql, /ON CONFLICT \(migration_id\) DO NOTHING/);
  assert.doesNotMatch(sql, /drizzle\.__drizzle_migrations/);
});

test("migration verifier checks physical 0077/0078/0079 effects and release gates bind the exact lineage", () => {
  const validator = readFileSync(new URL("../lib/db/scripts/validate-migration-ledger.ts", import.meta.url), "utf8");
  const controller = readFileSync(new URL("./production-release.mjs", import.meta.url), "utf8");
  const guard = readFileSync(new URL("./safe-compose.mjs", import.meta.url), "utf8");
  assert.match(validator, /applied\.has\(49\)/);
  assert.match(validator, /applied\.has\(50\)/);
  assert.match(validator, /applied\.has\(51\)/);
  assert.match(validator, /0075 catalogue variant physical effects/);
  assert.match(validator, /0076 WooCommerce webhook physical effects/);
  assert.match(validator, /woocommerce_webhook_events_pkey/);
  assert.match(controller, /verifyP0Schema\(compose\)/);
  assert.match(controller, /recognized lineage preserved: 53\/54/);
  assert.match(controller, /recognized lineage preserved: 54\/54/);
  assert.match(controller, /Migration 0077 reconciliation schema/);
  assert.match(controller, /Migration 0078 repair evidence schema/);
  assert.match(controller, /Migration 0079 verified zero opening-count constraint/);
  assert.match(controller, /contype IN \('p','f','u'\)\)=5/);
  assert.match(controller, /FOREIGN KEY \(actor_user_id\) REFERENCES users\(id\)/);
  assert.match(controller, /Isolated migration \$\{migration\.tag\.slice\(0, 4\)\} rehearsal failed/);
  assert.match(controller, /--single-transaction/);
  assert.match(controller, /Migration 0077\/0078\/0079 rehearsal changed representative production data counts/);
  assert.match(guard, /recognized lineage preserved: 49\/51/);
  assert.match(guard, /appliedMigrations\.length === 51/);
  assert.match(guard, /hasPendingMigrations/);
  assert.match(guard, /users_owner_approval_provenance_idx/);
  assert.match(guard, /wooExternalEnabled/);
  assert.match(guard, /wc_consumer_key IS NOT NULL AND wc_consumer_secret IS NOT NULL/);
});

test("production workflow uses versioned release archives and never deletes or synchronizes into the live checkout", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy.yml", import.meta.url),
    "utf8",
  );
  const runner = readFileSync(
    new URL("./production-release.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /rsync[^\n]*--delete|rsync\s+-[^\n]*delete/);
  assert.match(workflow, /git archive/);
  assert.ok(workflow.includes("test ! -L '${DEPLOY_PATH}'"));
  assert.match(
    workflow,
    /test ! -L '\$\{DEPLOY_PATH\}\/incoming\/\$\{RELEASE_ARCHIVE_NAME\}'/,
  );
  assert.match(runner, /releases/);
  assert.match(runner, /"--extract"/);
  assert.match(runner, /"--directory",\s*unpackRoot/);
  assert.match(runner, /renameSync\(unpackRoot, releaseRoot\)/);
  assert.match(runner, /lstatSync\(current\)/);
  assert.match(runner, /info\.isSymbolicLink\(\)/);
  assert.match(
    runner,
    /Deployment controller is outside its versioned production control directory/,
  );
  assert.match(runner, /docker",\s*\["cp", `\$\{apiId\}:/);
  assert.match(runner, /existing print asset differs/);
  assert.doesNotMatch(runner, /rsync|--delete/);
  assert.match(runner, /\/opt\/alavont\/shared\/print-assets/);
  assert.match(workflow, /production-release\.mjs/);
  assert.ok(workflow.includes('git merge-base --is-ancestor "${RELEASE_SHA}" "${TOOLING_SHA}"'));
  assert.ok(workflow.includes('git show "${GITHUB_SHA}:artifacts/api-server/src/routes/__tests__/myorder-pos-stabilization-static.test.ts"'));
  assert.ok(workflow.includes('git show "${GITHUB_SHA}:.github/workflows/deploy.yml"'));
  assert.ok(workflow.includes('git show "${GITHUB_SHA}:deploy/production-release.mjs"'));
  assert.doesNotMatch(workflow, /git show "HEAD:(?:artifacts\/api-server\/src\/routes\/__tests__\/myorder-pos-stabilization-static\.test\.ts|\.github\/workflows\/deploy\.yml|deploy\/production-release\.mjs)"/);
  assert.ok(workflow.includes('git show "${TOOLING_SHA}:deploy/production-release.mjs"'));
  assert.ok(workflow.includes('git show "${TOOLING_SHA}:deploy/production-runtime-overlay.yml"'));
  assert.ok(workflow.includes('"${TOOLING_ROOT}/production-release.mjs"'));
  assert.ok(workflow.includes('"${TOOLING_ROOT}/production-runtime-overlay.yml"'));
  assert.ok(workflow.includes('TOOLING_CONTROLLER_SHA256="$(sha256sum'));
  assert.ok(workflow.includes('TOOLING_OVERLAY_SHA256="$(sha256sum'));
  assert.ok(workflow.includes('test -f \\"\\$controller\\" && test ! -L \\"\\$controller\\"'));
  assert.ok(workflow.includes('test -f \\"\\$overlay\\" && test ! -L \\"\\$overlay\\"'));
  assert.ok(workflow.includes("= '${TOOLING_CONTROLLER_SHA256}'"));
  assert.ok(workflow.includes("= '${TOOLING_OVERLAY_SHA256}'"));
  assert.ok(workflow.includes('case "${TOOLING_TRANSFER_MODE}" in'));
  assert.ok(workflow.includes('*) echo "Refusing unknown tooling transfer mode" >&2; exit 1 ;;'));
  assert.ok(workflow.includes('if [[ "${TOOLING_TRANSFER_MODE}" == "install" ]]'));
  assert.ok(workflow.includes("Reusing hash-verified immutable deployment tooling"));
  assert.ok(workflow.includes("name: Stage immutable replacement API, migrator and Platform images"));
  assert.ok(workflow.includes(`REPLACEMENT_API_REFERENCE: ${APPROVED_RELEASE.references.api}`));
  assert.ok(workflow.includes(`REPLACEMENT_MIGRATE_REFERENCE: ${APPROVED_RELEASE.references.migrate}`));
  assert.ok(workflow.includes(`REPLACEMENT_PLATFORM_REFERENCE: ${APPROVED_RELEASE.references.platform}`));
  assert.ok(workflow.includes("docker pull '${REPLACEMENT_PLATFORM_REFERENCE}'"));
  assert.ok(workflow.includes("Pulled API manifest identity: %s; config identity: %s"));
  assert.ok(workflow.includes("Pulled migrator manifest identity: %s; config identity: %s"));
  assert.ok(workflow.includes("Pulled Platform manifest identity: %s; config identity: %s"));
  assert.ok(workflow.includes(`test \\"\\$api_id\\" = '${APPROVED_RELEASE.manifests.api}'`));
  assert.ok(workflow.includes(`test \\"\\$api_config\\" = '${APPROVED_RELEASE.configs.api}'`));
  assert.ok(workflow.includes(APPROVED_RELEASE.manifests.platform));
  assert.ok(workflow.includes("{{range .RepoDigests}}{{println .}}{{end}}"));
  assert.ok(workflow.includes("grep -Fx"));
});

test("production SSH uses an ephemeral Tailscale route and pinned SSH host identity only", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy.yml", import.meta.url),
    "utf8",
  );
  const joinTailscale = workflow.indexOf("uses: tailscale/github-action@v4");
  const routeCheck = workflow.indexOf(
    "Verify Tailscale route to production SSH",
  );
  const sshPreflight = workflow.indexOf("name: Verify SSH access");
  assert.ok(
    joinTailscale >= 0 &&
      routeCheck > joinTailscale &&
      sshPreflight > routeCheck,
  );
  assert.match(
    workflow,
    /oauth-client-id: \$\{\{ secrets\.TS_OAUTH_CLIENT_ID \}\}/,
  );
  assert.match(workflow, /oauth-secret: \$\{\{ secrets\.TS_OAUTH_SECRET \}\}/);
  assert.match(workflow, /tags: tag:github-actions/);
  assert.match(workflow, /VPS_TAILSCALE_HOST: 100\.85\.15\.43/);
  assert.ok(workflow.includes('nc -z -w 5 "${VPS_TAILSCALE_HOST}" "${VPS_PORT}"'));
  assert.doesNotMatch(
    workflow,
    /VPS_HOST_FALLBACK|SELECTED_VPS_HOST=\$\{VPS_HOST\}/,
  );
  assert.doesNotMatch(workflow, /ssh-keyscan|StrictHostKeyChecking=accept-new/);
  assert.ok(workflow.includes('ssh-keygen -F "${VPS_SSH_HOST_KEY_ALIAS}" -f ~/.ssh/known_hosts'));
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.ok(workflow.includes('HostKeyAlias=${VPS_SSH_HOST_KEY_ALIAS}'));
  assert.match(
    workflow,
    /VPS_PRIVATE_KEY: \$\{\{ secrets\.VPS_SSH_KEY \|\| secrets\.VPS_SECRET_KEY \}\}/,
  );
  assert.match(
    workflow,
    new RegExp(`RELEASE_BASE_SHA: ${FROZEN_RELEASE.sha}`),
  );
  assert.match(
    workflow,
    /RELEASE_SHA: \$\{\{ inputs\.release_sha \}\}/,
  );
  assert.match(workflow, /RELEASE_TREE: \$\{\{ inputs\.release_tree \}\}/);
  const globalEnv = workflow.match(/^env:\n((?:[ \t]+.*\n|\n)*)/m)?.[1] ?? "";
  assert.equal(APPROVED_RELEASE.sha, "68edc6a4e64876c146c82c21ca47f8abcf6b392f");
  assert.equal(APPROVED_RELEASE.tree, "015b406605eaa070c5f13f50dea5ce9f925ef5ab");
  for (const [key, value] of [["SHA", APPROVED_RELEASE.sha], ["TREE", APPROVED_RELEASE.tree]]) {
    const pin = `PINNED_RELEASE_${key}`;
    assert.deepEqual(globalEnv.match(new RegExp(`^  ${pin}: ([a-f0-9]{40})$`, "gm")), [`  ${pin}: ${value}`]);
    assert.equal(workflow.match(new RegExp(`\\b${pin}\\s*[:=]`, "g"))?.length, 1);
    assert.ok(workflow.includes(`          test "\${RELEASE_${key}}" = "\${${pin}}"\n`));
    assert.ok(workflow.includes(`RELEASE_${key}: \${{ github.event_name == 'workflow_dispatch' && inputs.release_${key.toLowerCase()} || '${value}' }}`));
  }
  assert.ok(workflow.includes('ref: ${{ env.RELEASE_SHA }}'));
  assert.match(workflow, /name: Release controller tests/);
  assert.match(workflow, /needs: \[test, release-tooling\]/);
  assert.match(workflow, /branches:\n\s+- "release-tooling\/\*\*"/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, new RegExp(`RELEASE_BASE_TREE: ${FROZEN_RELEASE.tree}`));
  assert.ok(workflow.includes('git rev-parse "${RELEASE_BASE_SHA}^{tree}"'));
  assert.ok(workflow.includes('git merge-base --is-ancestor "${RELEASE_BASE_SHA}" "${RELEASE_SHA}"'));
  assert.match(workflow, /MYORDER-RELEASE-IDENTITY\.json/);
  assert.match(readFileSync(new URL("./production-release.mjs", import.meta.url), "utf8"), /assertReleaseIdentityManifest\(packagedIdentity, \{ sha, tree \}\)/);
});

test("SSH connectivity diagnostic is pinned, secret-backed, and read-only", () => {
  const workflow = readFileSync(
    new URL(
      "../.github/workflows/ssh-connectivity-diagnostic.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const joinTailscale = workflow.indexOf("uses: tailscale/github-action@v4");
  const identityCheck = workflow.indexOf(
    "Verify runner has Tailscale identity",
  );
  const routeCheck = workflow.indexOf(
    "Verify only the pinned Tailscale SSH route",
  );
  const hostCheck = workflow.indexOf(
    "Validate pinned SSH host identity and install key",
  );
  const readOnlySsh = workflow.indexOf("Run read-only SSH connectivity check");
  const baselineInspection = workflow.indexOf("Inspect production runtime and migration baseline read-only");
  assert.ok(
    joinTailscale >= 0 &&
      identityCheck > joinTailscale &&
      routeCheck > identityCheck &&
      hostCheck > routeCheck &&
      readOnlySsh > hostCheck &&
      baselineInspection > readOnlySsh,
  );
  assert.match(workflow, /tags: tag:github-actions/);
  assert.match(workflow, /VPS_TAILSCALE_HOST: 100\.85\.15\.43/);
  assert.match(
    workflow,
    /TS_OAUTH_CLIENT_ID: \$\{\{ secrets\.TS_OAUTH_CLIENT_ID \}\}/,
  );
  assert.match(
    workflow,
    /TS_OAUTH_SECRET: \$\{\{ secrets\.TS_OAUTH_SECRET \}\}/,
  );
  assert.match(workflow, /tailscale ip -4/);
  assert.match(workflow, /nc -z -w 5 "\$VPS_TAILSCALE_HOST" "\$VPS_PORT"/);
  assert.match(workflow, /ssh-keygen -F "\$VPS_SSH_HOST_KEY_ALIAS"/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /HostKeyAlias=\$VPS_SSH_HOST_KEY_ALIAS/);
  assert.match(workflow, /CI SSH connectivity verified/);
  assert.doesNotMatch(
    workflow,
    /ssh-keyscan|accept-new|scp |rsync |production-release\.mjs/,
  );
  assert.doesNotMatch(
    workflow,
    /docker compose|migrate|pg_dump|curl .*api/,
  );
  assert.match(workflow, /SELECT count\(\*\).*drizzle\.__drizzle_migrations/);
  assert.doesNotMatch(workflow, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
  assert.match(workflow, /environment: production/);
});

test("migration runner holds one database advisory lock across validation and transactional migration", () => {
  const migrator = readFileSync(
    new URL("../lib/db/scripts/migrate-verified.ts", import.meta.url),
    "utf8",
  );
  assert.match(migrator, /pg_advisory_lock\(1299805539, 20261003\)/);
  assert.match(migrator, /db\.dialect\.migrate\(pendingIndices\.map/);
  assert.match(
    migrator,
    /finally\s*\{[\s\S]*pg_advisory_unlock\(1299805539, 20261003\)/,
  );
  assert.match(migrator, /main\(\)\.catch/);
});

test("unexpected production DB writer services fail closed before shutdown/migration", () => {
  const runner = readFileSync(
    new URL("./production-release.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    runner,
    /const expected = \["api", "db", "migrate", "nginx", "platform"\]/,
  );
  assert.match(runner, /Unexpected production project services/);
  assert.match(
    runner,
    /Potential external production writer\/scheduler exists/,
  );
  assert.match(runner, /Production database still has/);
});

test("maintenance closes ingress during database work and checks the API privately before reopening", () => {
  const runner = readFileSync(
    new URL("./production-release.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /run\("docker", \["stop", nginxId\]\)/);
  assert.match(runner, /run\("docker", \["stop", apiId\]\)/);
  assert.ok(
    runner.indexOf('run("docker", ["stop", nginxId])') <
      runner.indexOf('run("docker", ["stop", apiId])'),
  );
  assert.match(runner, /waitForApiContainer\(compose, sha\)/);
  assert.match(
    runner,
    /\.\.\.compose\.args, "ps", "--all", "--quiet", "api"\],\s*\{ env: releaseComposeEnvironment\(\) \}/,
  );
  assert.match(runner, /Production ingress proxy did not stop/);
  assert.ok(
    runner.indexOf('"verify-api": async () => waitForApiContainer') <
      runner.indexOf('"start-platform-proxy": async () =>'),
  );
});

test("application startup does not trigger Woo synchronization or Uber dispatch", () => {
  const startup = readFileSync(
    new URL("../artifacts/api-server/src/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(startup, /startFeedbackArchiveScheduler\(\)/);
  assert.match(startup, /startOrderNotificationWorker\(\)/);
  assert.doesNotMatch(
    startup,
    /syncPending|dispatchPendingUberDelivery|createUberDelivery|createWooOrder|fetchWooSafely/,
  );
  const runner = readFileSync(
    new URL("./production-release.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(runner, /fetch\([^\n]*(woocommerce|uber)/i);
});


test("post-migration resume accepts only exact approved runtime identities", () => {
  const controller = readFileSync(
    new URL("./production-release.mjs", import.meta.url),
    "utf8",
  );
  assert.match(controller, /apiIsBaseline/);
  assert.match(controller, /apiIsApproved/);
  assert.match(controller, /platformIsBaseline/);
  assert.match(controller, /platformIsApproved/);
  assert.match(controller, /current\?\.image === approvedImageReference\(service\)/);
  assert.match(
    controller,
    /runtimeAlreadyAdvanced && migrationState !== "applied"/,
  );
  assert.match(controller, /exact 53-row migration lineage is applied/);
});
