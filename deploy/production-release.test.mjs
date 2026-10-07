import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FROZEN_RELEASE,
  PRODUCTION,
  PRODUCTION_STEPS,
  ROLLBACK_SHA,
  assertProductionConfig,
  assertRelease,
  assertNoEncryptedProductionPayPalSettings,
  executeProductionSequence,
  mayRestoreRollbackApi,
} from "./production-release.mjs";

const releaseRoot = path.join(PRODUCTION.root, "releases", FROZEN_RELEASE.sha);
const archivePath = path.join(
  PRODUCTION.root,
  "incoming",
  `${FROZEN_RELEASE.sha}.tar.gz`,
);
const expectedConfig = {
  name: "deploy",
  services: {
    api: {
      image: `myorder-api:${FROZEN_RELEASE.sha}`,
      environment: {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://app:masked@db:5432/alavont",
        CLERK_SECRET_KEY: "masked",
        CLERK_PUBLISHABLE_KEY: "masked",
        SESSION_SECRET: "masked",
        SETTINGS_ENC_KEY: "masked",
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
    platform: { image: `myorder-platform:${FROZEN_RELEASE.sha}` },
    db: {
      environment: {
        POSTGRES_DB: "alavont",
        POSTGRES_USER: "alavont_user",
        POSTGRES_PASSWORD: "masked",
      },
    },
    migrate: {
      environment: { DATABASE_URL: "postgres://app:masked@db:5432/alavont" },
    },
    nginx: { ports: ["127.0.0.1:8081:80"] },
  },
  volumes: { postgres_data: { name: "deploy_postgres_data" } },
  networks: {
    internal: { name: "deploy_internal" },
    external: { name: "deploy_external" },
  },
};

test("accepts only the frozen Release 1 identity and its immutable release path", () => {
  assert.equal(
    assertRelease({
      sha: FROZEN_RELEASE.sha,
      tree: FROZEN_RELEASE.tree,
      releaseRoot,
      archivePath,
      archiveSha256: "a".repeat(64),
    }),
    true,
  );
  assert.throws(
    () =>
      assertRelease({
        sha: "b".repeat(40),
        tree: FROZEN_RELEASE.tree,
        releaseRoot,
        archivePath,
        archiveSha256: "a".repeat(64),
      }),
    /frozen/,
  );
  assert.throws(
    () =>
      assertRelease({
        sha: FROZEN_RELEASE.sha,
        tree: FROZEN_RELEASE.tree,
        releaseRoot: PRODUCTION.root,
        archivePath,
        archiveSha256: "a".repeat(64),
      }),
    /directory/,
  );
  assert.throws(
    () =>
      assertRelease({
        sha: FROZEN_RELEASE.sha,
        tree: FROZEN_RELEASE.tree,
        releaseRoot,
        archivePath: "/opt/alavont/deploy/.env",
        archiveSha256: "a".repeat(64),
      }),
    /incoming/,
  );
});

test("production Compose is pinned to the production database, release images, volume and loopback proxy", () => {
  assert.equal(
    assertProductionConfig(expectedConfig, {
      apiImage: `myorder-api:${FROZEN_RELEASE.sha}`,
      platformImage: `myorder-platform:${FROZEN_RELEASE.sha}`,
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
  const wrongRole = structuredClone(expectedConfig);
  wrongRole.services.db.environment.POSTGRES_USER = "staging_user";
  assert.throws(() => assertProductionConfig(wrongRole), /PostgreSQL role/);
  const wrongRelease = structuredClone(expectedConfig);
  wrongRelease.services.api.image =
    "myorder-api:579cce225c0f9e7bee41a4c226d43e5ba5c86606";
  assert.throws(
    () =>
      assertProductionConfig(wrongRelease, {
        apiImage: `myorder-api:${FROZEN_RELEASE.sha}`,
      }),
    /frozen release/,
  );
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

test("deployment ordering stops all writers and verifies the protected snapshot before migration", async () => {
  const observed = [];
  const actions = Object.fromEntries(
    PRODUCTION_STEPS.map((step) => [step, async () => observed.push(step)]),
  );
  await executeProductionSequence(actions);
  assert.deepEqual(observed, [...PRODUCTION_STEPS]);
  assert.ok(observed.indexOf("build") < observed.indexOf("validate-lineage"));
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

for (const failedGate of [
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

test("rollback release identity remains pinned", () => {
  assert.equal(ROLLBACK_SHA, "579cce225c0f9e7bee41a4c226d43e5ba5c86606");
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
    /RELEASE_SHA: 65a85f2f82daf9f30a07f1a2de13092d5be80360/,
  );
  assert.match(
    workflow,
    /RELEASE_TREE: 0411a10aa3326308bc480ff2fd15ecca037419bf/,
  );
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
  assert.match(runner, /"stop",\s*"nginx",\s*"api"/);
  assert.match(runner, /waitForApiContainer\(compose, sha\)/);
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
    /Woo|woo|syncPending|dispatchPendingUberDelivery|createUberDelivery/,
  );
  const runner = readFileSync(
    new URL("./production-release.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(runner, /fetch\([^\n]*(woocommerce|uber)/i);
});
