import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configuration,
  settingFields,
  validateSetting,
} from "../src/configuration-schema.ts";
import { resolveSettings } from "../src/project-settings.ts";

const settings = {
  test: ["node", "--test"],
  testFiles: ["test/"],
  prepare: ["npm", "ci", "--ignore-scripts"],
  assertionPattern: "assert",
  skipPattern: "skip",
};

await test("CLV-248 checks.redGreen accepts an object and maps it to CLOVING_RED_GREEN", () => {
  const project = JSON.stringify({
    version: 1,
    checks: { redGreen: settings },
  });
  assert.deepEqual(configuration(JSON.parse(project), "project").checks, {
    redGreen: settings,
  });
  assert.doesNotThrow(() => {
    validateSetting("checks.redGreen", settings);
  });
  assert.ok(settingFields().includes("checks.redGreen"));
  assert.equal(
    resolveSettings({}, { project, private: undefined }).environment[
      "CLOVING_RED_GREEN"
    ],
    JSON.stringify(settings),
  );
  assert.equal(
    resolveSettings(
      { CLOVING_RED_GREEN: "environment" },
      { project, private: undefined },
    ).environment["CLOVING_RED_GREEN"],
    "environment",
  );
});

await test("CLV-248 red-green settings reject missing commands and invalid arrays", () => {
  for (const redGreen of [
    {},
    { ...settings, test: [] },
    { ...settings, test: [4] },
    { ...settings, testFiles: "test/" },
    { ...settings, prepare: [] },
    { ...settings, assertionPattern: 4 },
  ])
    assert.throws(
      () => configuration({ version: 1, checks: { redGreen } }, "project"),
      /invalid-setting: checks.redGreen/,
    );
});
