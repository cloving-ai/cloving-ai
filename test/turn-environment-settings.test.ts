import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { settingsEnvironment } from "../src/cli/project-settings.ts";
import { configurationEntries } from "../src/configuration-display.ts";
import { configuration, validateSetting } from "../src/configuration-schema.ts";
import { turnHarness } from "../src/harness-defaults.ts";
import { turnVariablesSetting } from "../src/turn-environment.ts";
import { settingsScene } from "./project-settings-fixture.ts";

await test("CLV-310 the private file accepts a list of variable names or inherit for turns.environment", () => {
  for (const turns of [
    { environment: ["DATABASE_URL", "NPM_CONFIG_CACHE"] },
    { environment: "inherit" },
    { environment: [] },
  ])
    assert.deepEqual(
      configuration({ version: 1, turns }, "private").turns,
      turns,
    );
});

for (const value of [
  "all",
  ["1NAME"],
  ["GH_TOKEN"],
  ["GITHUB_TOKEN"],
  ["GH_CONFIG_DIR"],
  [""],
  [1],
])
  await test(`CLV-310 turns.environment refuses ${JSON.stringify(value)}`, () => {
    assert.throws(() => {
      validateSetting("turns.environment", value);
    }, /invalid-setting: turns\.environment/);
  });

await test("CLV-310 the project file refuses turns.environment", () => {
  assert.throws(
    () =>
      configuration(
        { version: 1, turns: { environment: ["SECRET_TEST_VALUE"] } },
        "project",
      ),
    { message: "private-setting-in-project-file: turns" },
  );
});

await test("CLV-310 the private setting becomes a start variable and has an empty default", () => {
  const fixture = settingsScene();
  try {
    fixture.write(fixture.privateFile, {
      version: 1,
      turns: { environment: ["DATABASE_URL"] },
    });
    const environment = settingsEnvironment(
      fixture.environment,
      fixture.repository,
    );
    assert.equal(environment["CLOVING_TURN_ENVIRONMENT"], '["DATABASE_URL"]');
    fixture.write(fixture.privateFile, {
      version: 1,
      turns: { environment: "inherit" },
    });
    assert.equal(
      settingsEnvironment(fixture.environment, fixture.repository)[
        "CLOVING_TURN_ENVIRONMENT"
      ],
      "inherit",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
  const shown = configurationEntries({
    project: undefined,
    private: undefined,
    environment: {},
  }).filter((entry) => entry.field === "turns.environment");
  assert.deepEqual(
    shown.map(({ field, value, source }) => [field, value, source]),
    [["turns.environment", [], "default"]],
  );
});

await test("CLV-310 the start variable gives the listed names or inherit", () => {
  assert.deepEqual(turnVariablesSetting(undefined), []);
  assert.deepEqual(turnVariablesSetting('["DATABASE_URL"]'), ["DATABASE_URL"]);
  assert.equal(turnVariablesSetting("inherit"), "inherit");
});

for (const value of ["all", "[1]", '["GH_TOKEN"]', '{"name":"A"}', "[", "[]x"])
  await test(`CLV-310 CLOVING_TURN_ENVIRONMENT=${value} stops the start and names the variable`, () => {
    assert.throws(
      () => turnVariablesSetting(value),
      /invalid-setting: CLOVING_TURN_ENVIRONMENT/,
    );
  });

await test("CLV-310 the harness of a turn carries the turn variables", () => {
  assert.deepEqual(turnHarness({}).variables, []);
  assert.deepEqual(turnHarness({ turnVariables: ["DATABASE_URL"] }).variables, [
    "DATABASE_URL",
  ]);
  assert.equal(turnHarness({ turnVariables: "inherit" }).variables, "inherit");
});
