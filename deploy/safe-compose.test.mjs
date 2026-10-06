import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCandidateIdentity, validateContainer, validatePlan } from "./safe-compose.mjs";

const root = "/home/serveradmin/worktrees/myorder-coordinated-staging-20261006";
function config(environment, database) {
  const project = environment === "staging" ? "myorder-staging" : "deploy";
  const networks = environment === "staging" ? { internal: {} } : { internal: {}, external: {} };
  return {
    name: project,
    services: {
      api: { environment: { NODE_ENV: environment, DATABASE_URL: `postgres://app@db:5432/${database}` }, networks: { internal: {} } },
      db: { environment: { POSTGRES_DB: database }, networks: { internal: {} } },
      migrate: { environment: { DATABASE_URL: `postgres://app@db:5432/${database}` }, networks: { internal: {} } },
      platform: { networks: { internal: {} } },
      nginx: { ports: [environment === "staging" ? "127.0.0.1:28081:80" : "127.0.0.1:8081:80"], networks: environment === "staging" ? { internal: {} } : { internal: {}, external: {} } },
    },
    networks: Object.fromEntries(Object.keys(networks).map(name => [name, { name: `${project}_${name}` }])),
    volumes: { postgres_data: { name: `${project}_postgres_data` } },
  };
}

test("accepts a staging plan pinned to the staging tree, project and database", () => {
  assert.equal(validatePlan({ environment: "staging", root, project: "myorder-staging", config: config("staging", "myorder_staging") }), true);
});
test("rejects staging pointed at the production project or database", () => {
  assert.throws(() => validatePlan({ environment: "staging", root, project: "deploy", config: config("staging", "myorder_staging") }), /project/);
  assert.throws(() => validatePlan({ environment: "staging", root, project: "myorder-staging", config: config("staging", "alavont") }), /Database target/);
});
test("rejects a conflicting resolved project or migration database", () => {
  const wrongProject = config("staging", "myorder_staging");
  wrongProject.name = "deploy";
  assert.throws(() => validatePlan({ environment: "staging", root, project: "myorder-staging", config: wrongProject }), /Resolved Compose project/);
  const wrongMigration = config("staging", "myorder_staging");
  wrongMigration.services.migrate.environment.DATABASE_URL = "postgres://app@db:5432/alavont";
  assert.throws(() => validatePlan({ environment: "staging", root, project: "myorder-staging", config: wrongMigration }), /Migration database target/);
  const remoteDatabase = config("staging", "myorder_staging");
  remoteDatabase.services.api.environment.DATABASE_URL = "postgres://app@production-db:5432/myorder_staging";
  assert.throws(() => validatePlan({ environment: "staging", root, project: "myorder-staging", config: remoteDatabase }), /database host/);
});
test("rejects staging settings in production and live payments in staging", () => {
  const productionWithStageSetting = config("production", "alavont");
  productionWithStageSetting.services.api.environment.STAGING_PUBLIC_TENANT_ID = "1";
  assert.throws(() => validatePlan({ environment: "production", root: "/opt/alavont", project: "deploy", config: productionWithStageSetting, authorization: "DEPLOY-PRODUCTION" }), /Staging-only/);
  const liveStaging = config("staging", "myorder_staging");
  liveStaging.services.api.environment.PAYPAL_ENVIRONMENT = "live";
  assert.throws(() => validatePlan({ environment: "staging", root, project: "myorder-staging", config: liveStaging }), /live payment/);
});
test("rejects a staging Compose network, database volume, or proxy port collision with production", () => {
  const wrongNetwork = config("staging", "myorder_staging");
  wrongNetwork.networks.internal.name = "deploy_internal";
  assert.throws(() => validatePlan({ environment: "staging", root, project: "myorder-staging", config: wrongNetwork }), /networks/);
  const wrongVolume = config("staging", "myorder_staging");
  wrongVolume.volumes.postgres_data.name = "deploy_postgres_data";
  assert.throws(() => validatePlan({ environment: "staging", root, project: "myorder-staging", config: wrongVolume }), /database volume/);
  const wrongProxy = config("staging", "myorder_staging");
  wrongProxy.services.nginx.ports = [{ host_ip: "127.0.0.1", published: "8081", target: 80, protocol: "tcp" }];
  assert.throws(() => validatePlan({ environment: "staging", root, project: "myorder-staging", config: wrongProxy }), /proxy port/);
  const actualComposeFormat = config("staging", "myorder_staging");
  actualComposeFormat.services.nginx.ports = [{ host_ip: "127.0.0.1", published: "28081", target: 80, protocol: "tcp" }];
  assert.equal(validatePlan({ environment: "staging", root, project: "myorder-staging", config: actualComposeFormat }), true);
});
test("rejects mismatched Compose API environment, wrong tree and wrong project", () => {
  const wrongApiEnvironment = config("staging", "myorder_staging");
  wrongApiEnvironment.services.api.environment.NODE_ENV = "production";
  assert.throws(() => validatePlan({ environment: "staging", root, project: "myorder-staging", config: wrongApiEnvironment }), /API environment/);
  assert.throws(() => validatePlan({ environment: "staging", root: "/tmp", project: "myorder-staging", config: config("staging", "myorder_staging") }), /working tree/);
  assert.throws(() => validatePlan({ environment: "staging", root, project: "deploy", config: config("staging", "myorder_staging") }), /project/);
});
test("requires a clean candidate checkout and an exact candidate SHA", () => {
  assert.equal(validateCandidateIdentity({ root, environment: "staging", status: "", headSha: "abc123", deploySha: "abc123" }), "abc123");
  assert.throws(() => validateCandidateIdentity({ root, environment: "staging", status: " M deploy/file", headSha: "abc123" }), /clean/);
  assert.throws(() => validateCandidateIdentity({ root, environment: "staging", status: "", headSha: "abc123", deploySha: "different" }), /HEAD/);
});
test("requires explicit production authorization and exact production targets", () => {
  const args = { environment: "production", root: "/opt/alavont", project: "deploy", config: config("production", "alavont") };
  assert.throws(() => validatePlan(args), /authorization/);
  assert.equal(validatePlan({ ...args, authorization: "DEPLOY-PRODUCTION" }), true);
  assert.throws(() => validatePlan({ ...args, project: "myorder-staging", authorization: "DEPLOY-PRODUCTION" }), /project/);
});
test("rejects a container resolved from another Compose project or file", () => {
  const labels = { "com.docker.compose.project": "myorder-staging", "com.docker.compose.service": "api", "com.docker.compose.project.config_files": "/home/serveradmin/worktrees/myorder-dev/deploy/docker-compose.staging.yml", "com.docker.compose.project.working_dir": "/home/serveradmin/worktrees/myorder-dev/deploy" };
  const args = { environment: "staging", project: "myorder-staging", service: "api", labels, composeFile: "/home/serveradmin/worktrees/myorder-dev/deploy/docker-compose.staging.yml", composeWorkingDir: "/home/serveradmin/worktrees/myorder-dev/deploy", resolved: config("staging", "myorder_staging"), envValues: { NODE_ENV: "staging", DATABASE_URL: "postgres://app@db:5432/myorder_staging" }, networks: { "myorder-staging_internal": {} } };
  assert.equal(validateContainer(args), true);
  assert.throws(() => validateContainer({ ...args, labels: { ...labels, "com.docker.compose.project": "deploy" } }), /another project/);
  assert.throws(() => validateContainer({ ...args, labels: { ...labels, "com.docker.compose.project.config_files": "/opt/alavont/deploy/docker-compose.yml", "com.docker.compose.project.working_dir": "/opt/alavont/deploy" } }), /staging Compose source/);
  assert.equal(validateContainer({ ...args, labels: { ...labels, "com.docker.compose.project.config_files": "/home/serveradmin/worktrees/lucifer-woo-staging-repair/deploy/docker-compose.staging.yml", "com.docker.compose.project.working_dir": "/home/serveradmin/worktrees/lucifer-woo-staging-repair/deploy" } }), true);
  assert.throws(() => validateContainer({ ...args, envValues: { NODE_ENV: "production", DATABASE_URL: "postgres://app@db:5432/alavont" } }), /container environment/);
  assert.throws(() => validateContainer({ ...args, networks: { deploy_internal: {} } }), /unexpected network/);
});
test("checks the selected tenant database, persistent volume and environment proxy port", () => {
  const base = { environment: "staging", project: "myorder-staging", service: "db", labels: { "com.docker.compose.project": "myorder-staging", "com.docker.compose.service": "db", "com.docker.compose.project.config_files": "/home/serveradmin/worktrees/myorder-dev/deploy/docker-compose.staging.yml", "com.docker.compose.project.working_dir": "/home/serveradmin/worktrees/myorder-dev/deploy" }, composeFile: "/home/serveradmin/worktrees/myorder-dev/deploy/docker-compose.staging.yml", composeWorkingDir: "/home/serveradmin/worktrees/myorder-dev/deploy", resolved: config("staging", "myorder_staging"), envValues: { POSTGRES_DB: "myorder_staging" }, mounts: [{ Destination: "/var/lib/postgresql/data", Name: "myorder-staging_postgres_data" }], networks: { "myorder-staging_internal": {} } };
  assert.equal(validateContainer(base), true);
  assert.throws(() => validateContainer({ ...base, mounts: [{ Destination: "/var/lib/postgresql/data", Name: "deploy_postgres_data" }] }), /data volume/);
  assert.throws(() => validateContainer({ ...base, envValues: { POSTGRES_DB: "alavont" } }), /another database/);
  assert.throws(() => validateContainer({ ...base, service: "nginx", labels: { ...base.labels, "com.docker.compose.service": "nginx" }, portBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8081" }] } }), /environment port/);
});
