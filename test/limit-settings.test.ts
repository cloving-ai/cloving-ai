import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { settingsEnvironment } from "../src/cli/project-settings.ts";
import { validateSetting } from "../src/configuration-schema.ts";
import { settingsScene } from "./project-settings-fixture.ts";
import { workflowLimits } from "../src/workflow-limits.ts";
import { commandUsage } from "../src/cli/usage.ts";

for (const [scope, limits, variables] of [
  [
    "project",
    { effects: 200, chain: 10 },
    { CLOVING_LIMIT_EFFECTS: "200", CLOVING_LIMIT_CHAIN: "10" },
  ],
  [
    "private",
    { effects: 1000, chain: 50 },
    { CLOVING_LIMIT_EFFECTS: "1000", CLOVING_LIMIT_CHAIN: "50" },
  ],
] as const)
  await test(`CLV-308 the ${scope} file sets the operator maximums of effects and chain`, () => {
    const fixture = settingsScene();
    try {
      fixture.write(
        scope === "project" ? fixture.project : fixture.privateFile,
        { version: 1, limits },
      );
      const result = settingsEnvironment(
        fixture.environment,
        fixture.repository,
      );
      assert.deepEqual(
        {
          CLOVING_LIMIT_EFFECTS: result["CLOVING_LIMIT_EFFECTS"],
          CLOVING_LIMIT_CHAIN: result["CLOVING_LIMIT_CHAIN"],
        },
        variables,
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

for (const [field, value] of [
  ["limits.effects", 0],
  ["limits.effects", 1001],
  ["limits.effects", 1.5],
  ["limits.effects", "100"],
  ["limits.chain", 1],
  ["limits.chain", 51],
  ["limits.chain", 2.5],
] as const)
  await test(`CLV-308 ${field} refuses ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => {
        validateSetting(field, value);
      },
      new RegExp(`invalid-setting: ${field}`),
    );
  });

await test("CLV-308 the daemon reads the operator maximums from the environment with the defaults 100 and 5", () => {
  assert.deepEqual(workflowLimits({}), { effects: 100, chain: 5 });
  assert.deepEqual(
    workflowLimits({ CLOVING_LIMIT_EFFECTS: "200", CLOVING_LIMIT_CHAIN: "10" }),
    { effects: 200, chain: 10 },
  );
  for (const [variable, value] of [
    ["CLOVING_LIMIT_EFFECTS", "0"],
    ["CLOVING_LIMIT_EFFECTS", "1001"],
    ["CLOVING_LIMIT_EFFECTS", "1e2"],
    ["CLOVING_LIMIT_CHAIN", "1"],
    ["CLOVING_LIMIT_CHAIN", "51"],
    ["CLOVING_LIMIT_CHAIN", " 5"],
  ] as const)
    assert.throws(
      () => workflowLimits({ [variable]: value }),
      new RegExp(`invalid-setting: ${variable} must be`),
    );
});

await test("CLV-308 the start help names the operator maximums with their ranges and defaults", () => {
  const lines = String(commandUsage["start"]).split("\n");
  for (const [name, fact] of [
    [
      "CLOVING_LIMIT_EFFECTS",
      /1 to 1000.*default is 100.*effectLimit.*effect-limit-above-maximum/,
    ],
    ["CLOVING_LIMIT_CHAIN", /2 to 50.*default is 5.*chainLimit/],
  ] as const)
    assert.match(
      lines.find((line) => line.startsWith(`  ${name} `)) ?? "",
      fact,
    );
});
