#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = { staging: "myorder-staging", production: "deploy" };
const ENVIRONMENT = { staging: "staging", production: "production" };
const DATABASE = { staging: "myorder_staging", production: "alavont" };
const ROOTS = { staging: "/home/serveradmin/worktrees/myorder-dev", production: "/opt/alavont" };
const ACTIONS = new Set(["config", "build", "up", "migrate", "bootstrap"]);

export function validatePlan({ environment, root, project, config, authorization }) {
  if (!(environment in PROJECT)) throw new Error("Unknown deployment environment");
  if (path.resolve(root) !== ROOTS[environment]) throw new Error("Unexpected deployment working tree");
  if (project !== PROJECT[environment]) throw new Error("Compose project does not match the selected environment");
  if (config?.name !== PROJECT[environment]) throw new Error("Resolved Compose project does not match the selected environment");
  if (config?.services?.api?.environment?.NODE_ENV !== ENVIRONMENT[environment]) throw new Error("API environment does not match the selected environment");
  const apiEnvironment = config.services.api.environment;
  if (environment === "production" && Object.keys(apiEnvironment).some(name => name.startsWith("STAGING_"))) throw new Error("Staging-only settings cannot be attached to production");
  if (environment === "staging" && (apiEnvironment.PAYPAL_ENVIRONMENT && apiEnvironment.PAYPAL_ENVIRONMENT !== "sandbox" || apiEnvironment.LIVE_PAYMENTS_ENABLED === "true")) throw new Error("Staging cannot enable live payment credentials or mode");
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
  if (!(config.services.nginx.ports ?? []).some(port => String(port).replaceAll("/tcp", "") === expectedPort)) throw new Error("Resolved proxy port does not match the pinned environment");
  if (config.volumes?.postgres_data?.name !== `${PROJECT[environment]}_postgres_data`) throw new Error("Resolved database volume does not match the pinned environment");
  if (environment === "production" && authorization !== "DEPLOY-PRODUCTION") throw new Error("Production requires explicit DEPLOY-PRODUCTION authorization");
  if (environment === "staging" && (project === "deploy" || database === "alavont")) throw new Error("Staging cannot target production resources");
  return true;
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

function main() {
  const [environment, action, ...rest] = process.argv.slice(2);
  if (!ACTIONS.has(action)) throw new Error("Usage: safe-compose.mjs <staging|production> <config|build|up|migrate|bootstrap> [services] [--authorize-production]");
  if (!(environment in PROJECT)) throw new Error("Unknown deployment environment");
  const authorization = rest.includes("--authorize-production") && process.env.PRODUCTION_DEPLOY_CONFIRMATION === "DEPLOY-PRODUCTION" ? "DEPLOY-PRODUCTION" : undefined;
  if (rest.includes("--authorize-production") && !authorization) throw new Error("Production authorization flag and confirmation must both be present");
  if (environment === "production" && !authorization) throw new Error("Production requires explicit authorization before Compose can be resolved");
  if (path.resolve(ROOT) !== ROOTS[environment]) throw new Error("Unexpected deployment working tree");
  const services = rest.filter(arg => arg !== "--authorize-production");
  if (services.some(service => !["db", "api", "platform", "nginx"].includes(service))) throw new Error("Service is not in the deployment allowlist");
  if (action === "up" && (!services.length || services.some(service => !["db", "api", "platform", "nginx"].includes(service)))) throw new Error("up requires an explicit allowlisted service list");
  if (action === "migrate" && services.length) throw new Error("migrate does not accept service arguments");
  if ((action === "bootstrap" || action === "build" || action === "config") && services.length) throw new Error(`${action} does not accept service arguments`);

  const project = PROJECT[environment];
  const composeFile = path.join(ROOT, "deploy", environment === "production" ? "docker-compose.yml" : "docker-compose.staging.yml");
  const envFile = environment === "production" ? path.join(ROOT, "deploy", ".env") : path.join(ROOT, "deploy", ".env.staging");
  if (!existsSync(composeFile) || !existsSync(envFile)) throw new Error("Expected Compose file or environment file is missing");
  const prefix = ["compose", "--project-name", project, "--env-file", envFile, "--file", composeFile];
  const resolved = JSON.parse(run("docker", [...prefix, "config", "--format", "json"], { capture: true }));
  validatePlan({ environment, root: ROOT, project, config: resolved, authorization });

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

  if (action === "config") return;
  if (environment === "production" && !authorization) throw new Error("Production action requires explicit authorization");
  if (action === "build") run("docker", [...prefix, "build"]);
  if (action === "up") run("docker", [...prefix, "up", "-d", "--no-deps", ...services]);
  if (action === "migrate") run("docker", [...prefix, "run", "--rm", "migrate"]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Deployment refused: ${error instanceof Error ? error.message : "unknown error"}`); process.exitCode = 1; }
}
