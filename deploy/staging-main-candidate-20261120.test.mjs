import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);
const definition = JSON.parse(readFileSync(new URL("./staging-main-candidate-20261120.json", import.meta.url), "utf8"));

test("freezes the reviewed main source and excludes guest migration 0084", () => {
  assert.equal(definition.environment, "staging");
  assert.equal(definition.status, "source_frozen_images_unresolved");
  assert.equal(definition.source.commit, "28b987bb92960e0a496b99060acef06ae1446152");
  assert.equal(definition.source.tree, "40e494b4cf474b93674c95956bbfe9274b2f9966");
  assert.equal(
    execFileSync("git", ["-C", root.pathname, "rev-parse", `${definition.source.commit}^{tree}`], { encoding: "utf8" }).trim(),
    definition.source.tree,
  );

  const migrationNames = readdirSync(new URL("../lib/db/drizzle/", import.meta.url)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  const sourceMigrationNames = execFileSync(
    "git",
    ["-C", root.pathname, "ls-tree", "-r", "--name-only", definition.source.commit, "lib/db/drizzle"],
    { encoding: "utf8" },
  ).trim().split("\n").map((name) => name.split("/").at(-1)).filter(Boolean).sort();
  const sourceSqlMigrations = sourceMigrationNames.filter((name) => /^\d{4}_.*\.sql$/.test(name));
  assert.equal(sourceSqlMigrations.at(-1), definition.source.migrationTip);
  assert.equal(sourceSqlMigrations.some((name) => name.startsWith("0084_")), false);
  assert.equal(migrationNames.some((name) => name.startsWith("0084_")), false);
  assert.deepEqual(definition.source.excludedMigrations, ["0084"]);
});

test("fails closed until independently built immutable images and reviewed staging tooling exist", () => {
  assert.deepEqual(definition.images, { api: null, platform: null, migrate: null });
  assert.equal(definition.gates.imagesBuilt, false);
  assert.equal(definition.gates.immutableDigestsRecorded, false);
  assert.equal(definition.gates.stagingControllerReviewedThroughMigrationTip, false);
  assert.equal(definition.gates.stagingDeploymentAuthorized, false);
  assert.equal(definition.gates.productionDeploymentAuthorized, false);
});
