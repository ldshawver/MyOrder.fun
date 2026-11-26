import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/deploy-staging.yml", import.meta.url), "utf8");
const remote = readFileSync(new URL("./staging-release-remote.sh", import.meta.url), "utf8");
const production = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");

test("staging workflow is manual-only, uses the protected staging environment and serializes releases", () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule|workflow_run):/m);
  assert.match(workflow, /environment:\n\s+name: staging\n/);
  assert.match(workflow, /concurrency:\n\s+group: deploy-staging-myorderfun\n\s+cancel-in-progress: false/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
});

test("staging workflow can only read staging-scoped secrets and never names production targets", () => {
  const secretNames = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]);
  assert.ok(secretNames.length > 0);
  for (const name of secretNames) assert.match(name, /^STAGING_/, `workflow reads non-staging secret ${name}`);
  assert.doesNotMatch(workflow, /environment: production|I_AUTHORIZE_PRODUCTION|--authorize-production|docker-compose\.yml|COMPOSE_PROJECT_NAME: deploy/);
  assert.match(workflow, /tags: tag:github-actions-staging/);
  // The production tag/credentials stay exclusive to the production workflow.
  assert.match(production, /tags: tag:github-actions\n/);
});

test("release identity, tree, CI success and guard base are verified before the staging job", () => {
  assert.match(workflow, /needs: verify-release/);
  assert.match(workflow, /test "\$\(git rev-parse 'HEAD\^\{tree\}'\)" = "\$RELEASE_TREE"/);
  assert.match(workflow, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$\{RELEASE_SHA\}/);
  assert.match(workflow, /\[ "\$conclusion" = "success" \]/);
  assert.match(workflow, /git merge-base --is-ancestor "\$base" HEAD/);
});

test("SSH is key-only with a pinned host identity, over Tailscale", () => {
  const sshCalls = workflow.match(/\bssh -i [^\n]+/g) ?? [];
  assert.ok(sshCalls.length >= 2);
  for (const call of sshCalls) {
    assert.match(call, /-o BatchMode=yes/);
    assert.match(call, /-o StrictHostKeyChecking=yes/);
    assert.match(call, /-o IdentitiesOnly=yes/);
  }
  assert.match(workflow, /HostKeyAlias=\$\{STAGING_VPS_HOST_KEY_ALIAS\}/);
  assert.match(workflow, /\^100\\\./);
});

test("migrations need an explicit action and confirmation; deploy never migrates implicitly", () => {
  assert.match(workflow, /migrate-and-deploy requires migration_confirmation=APPLY_STAGING_MIGRATIONS/);
  assert.match(remote, /\[ "\$ACTION" = "migrate-and-deploy" \] \|\| fail "Release needs pending staging migrations/);
  const migrateIdx = remote.indexOf("guard migrate\n");
  const statusIdx = remote.indexOf("guard migrations");
  const upIdx = remote.indexOf("guard up api platform");
  assert.ok(statusIdx > 0 && statusIdx < migrateIdx && migrateIdx < upIdx);
});

test("synthetic bootstrap is confirmation-gated and only drives the staging guard", () => {
  assert.match(workflow, /bootstrap-synthetic requires migration_confirmation=BOOTSTRAP_SYNTHETIC_STAGING/);
  assert.match(remote, /bootstrap-synthetic requires the explicit synthetic bootstrap confirmation/);
  const bootstrap = remote.indexOf("guard bootstrap-synthetic");
  const releaseGuard = remote.indexOf("guard config");
  assert.ok(bootstrap > 0 && releaseGuard > bootstrap, "empty-state bootstrap must be handled before normal existing-stack guards");
  assert.match(remote, /guard bootstrap-synthetic/);
});

test("host script only drives the staging guard and refuses production paths", () => {
  const nodeCalls = remote.match(/node deploy\/safe-compose\.mjs[^\n]*/g) ?? [];
  assert.deepEqual(nodeCalls, ['node deploy/safe-compose.mjs staging "$@"; }']);
  assert.doesNotMatch(remote, /\bdocker\b|\bpsql\b|safe-compose\.mjs production/);
  assert.match(remote, /\/opt\/alavont\|\/opt\/alavont\/\*\) fail "Refusing to use the production checkout"/);
  assert.match(remote, /case "\$mode" in 600\|400\)/);
  assert.match(remote, /export DEPLOY_SHA="\$SHA" DEPLOY_TREE="\$TREE" MYORDER_STAGING_ENV_FILE="\$ENV_FILE" MYORDER_STAGING_RELEASE_MODE="verified-release"/);
  assert.match(remote, /unset [^\n]*PRODUCTION_DEPLOY_CONFIRMATION/);
});

test("health and release identity are verified on the host and publicly", () => {
  assert.match(remote, /j\.status==="ok"&&j\.sha===process\.argv\[1\]/);
  assert.match(workflow, /\[ "\$sha" = "ok:\$\{RELEASE_SHA\}" \]/);
});

test("host script resolves Node.js before any guard call in a non-interactive SSH session", () => {
  const resolveIdx = remote.indexOf('command -v node >/dev/null 2>&1 || fail "Node.js is not available');
  const versionIdx = remote.indexOf(">= 22 ? 0 : 1");
  const firstNodeUse = remote.indexOf('node deploy/safe-compose.mjs');
  const healthProbe = remote.indexOf('| node -e');
  assert.ok(resolveIdx > 0, "Node.js resolution with a clear failure is required");
  assert.ok(versionIdx > resolveIdx, "Node.js major version must be checked after resolution");
  assert.ok(versionIdx < firstNodeUse && versionIdx < healthProbe, "Node.js must be resolved before the guard and health probe");
  assert.match(remote, /\$HOME\/\.nvm\/versions\/node/);
  assert.doesNotMatch(remote, /\.nvm\/nvm\.sh|\bsource\b.*profile|\.bashrc/);
});
