import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  APPROVED_RELEASE,
  EXPECTED_PRODUCTION_MIGRATIONS,
  FROZEN_RELEASE,
  PRODUCTION_BASELINE,
  PRODUCTION,
  PRODUCTION_STEPS,
  assertProductionConfig,
  assertRelease,
  assertReleaseIdentityManifest,
  assertReusableReleaseIdentity,
  assertKnownNonWriterService,
  assertNoEncryptedProductionPayPalSettings,
  assertPublicCatalogSmokePayload,
  executeProductionSequence,
  mayRestoreRollbackApi,
  sameWriterInventory,
} from "./production-release.mjs";

const releaseRoot = path.join(PRODUCTION.root, "releases", APPROVED_RELEASE.sha);
const archivePath = path.join(
  PRODUCTION.root,
  "incoming",
  `${APPROVED_RELEASE.sha}.tar.gz`,
);
const expectedConfig = {
  name: "deploy",
  services: {
    api: {
      image: APPROVED_RELEASE.references.api,
      environment: {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://app@db:5432/alavont",
        CLERK_SECRET_KEY: "masked",
        CLERK_PUBLISHABLE_KEY: "masked",
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
    platform: { image: APPROVED_RELEASE.references.platform },
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
    assertPublicCatalogSmokePayload({ items: [{ id: 1 }], total: 304 }),
    1,
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
        sha: "b".repeat(40),
        tree: APPROVED_RELEASE.tree,
        releaseRoot,
        archivePath,
        archiveSha256: "a".repeat(64),
      }),
    /approved immutable candidate/,
  );
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
  assert.match(overlay, /ORDER_NOTIFICATION_WORKER_ENABLED: "0"/);
  const controller = readFileSync(new URL("./production-release.mjs", import.meta.url), "utf8");
  assert.match(controller, /docker", \["image", "inspect", reference\]/);
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
    /PRODUCTION_DEPLOY_CONFIRMATION !== "DEPLOY-PRODUCTION"/,
  );
  assert.match(source, /--authorized/);
});

test("production rollback baseline is the current pre-release image set", () => {
  assert.equal(PRODUCTION_BASELINE.apiImage, "sha256:8e8299bb7b92ada12827071578987463ba9dfb97ece47235b4856f097dc5e154");
  assert.equal(PRODUCTION_BASELINE.apiRevision, "3e5a5c833b93c0e5c345cb2d2f2f9537400d16cb");
  assert.equal(PRODUCTION_BASELINE.platformImage, "sha256:fbd2185bca1e471462a41fac0c50595643c84a6e506076311655c792b2a2ca13");
  assert.equal(PRODUCTION_BASELINE.platformRevision, "40fccbc3d9464ddfa5574f2cb57b71d0fe3ab833");
  assert.deepEqual(Object.keys(APPROVED_RELEASE.images).sort(), ["api", "migrate", "platform"]);
  assert.equal(APPROVED_RELEASE.images.api, "sha256:8e8299bb7b92ada12827071578987463ba9dfb97ece47235b4856f097dc5e154");
  assert.equal(APPROVED_RELEASE.images.platform, "sha256:ac052a7439d4cabacbbf1bdddef9f375f5220379d871970f5e2b050870c348cf");
  assert.equal(APPROVED_RELEASE.revisions.api, APPROVED_RELEASE.sha);
  assert.equal(APPROVED_RELEASE.revisions.platform, APPROVED_RELEASE.sha);
  assert.equal(APPROVED_RELEASE.revisions.migrate, FROZEN_RELEASE.sha);
  assert.equal(APPROVED_RELEASE.references.api, "ghcr.io/ldshawver/myorder-api@sha256:8e8299bb7b92ada12827071578987463ba9dfb97ece47235b4856f097dc5e154");
  assert.equal(APPROVED_RELEASE.references.platform, "ghcr.io/ldshawver/myorder-platform@sha256:ac052a7439d4cabacbbf1bdddef9f375f5220379d871970f5e2b050870c348cf");
  assert.equal(EXPECTED_PRODUCTION_MIGRATIONS.length, 9);
  assert.deepEqual(EXPECTED_PRODUCTION_MIGRATIONS, [
    "0068_print_jobs_document_job_types",
    "0069_inventory_tenant_quantity_foundation",
    "0070_catalogue_products_options_reorder",
    "0071_refund_state_constraint_reconciliation",
    "0072_order_created_notifications",
    "0073_admin_settings_tenant_uniqueness",
    "0074_tenant_slug_case_insensitive_unique",
    "0075_catalogue_variant_attributes",
    "0076_tenant_woo_store_url_no_default",
  ]);
  assert.deepEqual(EXPECTED_PRODUCTION_MIGRATIONS.slice(-2), [
    "0075_catalogue_variant_attributes",
    "0076_tenant_woo_store_url_no_default",
  ]);
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

test("migration verifier checks physical 0075/0076 effects and release gates bind P0 state", () => {
  const validator = readFileSync(new URL("../lib/db/scripts/validate-migration-ledger.ts", import.meta.url), "utf8");
  const controller = readFileSync(new URL("./production-release.mjs", import.meta.url), "utf8");
  const guard = readFileSync(new URL("./safe-compose.mjs", import.meta.url), "utf8");
  assert.match(validator, /applied\.has\(49\)/);
  assert.match(validator, /applied\.has\(50\)/);
  assert.match(validator, /0075 catalogue variant physical effects/);
  assert.match(validator, /0076 WooCommerce webhook physical effects/);
  assert.match(validator, /woocommerce_webhook_events_pkey/);
  assert.match(controller, /verifyP0Schema\(compose\)/);
  assert.match(controller, /recognized lineage preserved: 42\/51/);
  assert.match(controller, /recognized lineage preserved: 51\/51/);
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
  assert.match(workflow, /test ! -L '\$DEPLOY_PATH'/);
  assert.match(
    workflow,
    /test ! -L '\$DEPLOY_PATH\/incoming\/\$RELEASE_ARCHIVE_NAME'/,
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
  assert.match(workflow, /nc -z -w 5 "\$VPS_TAILSCALE_HOST" "\$VPS_PORT"/);
  assert.doesNotMatch(
    workflow,
    /VPS_HOST_FALLBACK|SELECTED_VPS_HOST=\$\{VPS_HOST\}/,
  );
  assert.doesNotMatch(workflow, /ssh-keyscan|StrictHostKeyChecking=accept-new/);
  assert.match(workflow, /ssh-keygen \\\s*-F "\$VPS_SSH_HOST_KEY_ALIAS"/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /HostKeyAlias=\$VPS_SSH_HOST_KEY_ALIAS/);
  assert.match(
    workflow,
    /VPS_PRIVATE_KEY: \$\{\{ secrets\.VPS_SSH_KEY \|\| secrets\.VPS_SECRET_KEY \}\}/,
  );
  assert.match(
    workflow,
    /RELEASE_BASE_SHA: 40fccbc3d9464ddfa5574f2cb57b71d0fe3ab833/,
  );
  assert.match(
    workflow,
    /RELEASE_SHA: \$\{\{ inputs\.release_sha \}\}/,
  );
  assert.match(workflow, /RELEASE_TREE: \$\{\{ inputs\.release_tree \}\}/);
  assert.match(workflow, /test "\$RELEASE_SHA" = "3e5a5c833b93c0e5c345cb2d2f2f9537400d16cb"/);
  assert.match(workflow, /ref: \$\{\{ inputs\.release_sha \|\| '3e5a5c833b93c0e5c345cb2d2f2f9537400d16cb' \}\}/);
  assert.match(workflow, /name: Release controller tests/);
  assert.match(workflow, /needs: \[test, release-tooling\]/);
  assert.match(workflow, /branches:\n\s+- "release-tooling\/\*\*"/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /RELEASE_BASE_TREE: 76bb2bc969450206f0be4754a6ef95434cd27b4a/);
  assert.match(workflow, /git rev-parse "\$RELEASE_BASE_SHA\^\{tree\}"/);
  assert.match(workflow, /git merge-base --is-ancestor "\$RELEASE_BASE_SHA" "\$RELEASE_SHA"/);
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
  assert.ok(
    joinTailscale >= 0 &&
      identityCheck > joinTailscale &&
      routeCheck > identityCheck &&
      hostCheck > routeCheck &&
      readOnlySsh > hostCheck,
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
    /docker compose|migrate|pg_dump|psql|curl .*api/,
  );
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
  assert.match(controller, /exact 51-row migration lineage is applied/);
});
