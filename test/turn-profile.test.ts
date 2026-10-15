import assert from "node:assert/strict";
import { test } from "node:test";
import { isProfilesFile } from "../src/turn-profile.ts";

await test("CLV-086 profile files validate names, optional fields and positive finite budgets", () => {
  const valid = [
    { profiles: {} },
    { profiles: { checker: {} } },
    { profiles: { ["a".repeat(119)]: {} } },
    {
      profiles: {
        "A_9-z": {
          env: { TURN_NAME: "{turn}", REVIEW_ONLY: "1" },
          allowedTools: ["Read", "Bash(git status)"],
          model: "opus",
          permissionMode: "plan",
          maxBudgetUsd: 0.01,
          workflows: ["review-loop"],
        },
      },
    },
  ];
  for (const value of valid)
    assert.equal(isProfilesFile(value), true, JSON.stringify(value));
  for (const value of [
    null,
    [],
    {},
    { profiles: [] },
    { profiles: null },
    { profiles: {}, extra: true },
  ])
    assert.equal(isProfilesFile(value), false, JSON.stringify(value));
  for (const name of [
    "",
    "a".repeat(120),
    "two words",
    "é",
    "checker:fixer",
    "a.b",
    "line\n",
  ])
    assert.equal(isProfilesFile({ profiles: { [name]: {} } }), false, name);
});

await test("CLV-086 invalid profile fields and GitHub environment overrides fail validation", () => {
  const invalid = [
    null,
    [],
    "profile",
    { unknown: true },
    { env: [] },
    { env: { VALUE: 1 } },
    { env: { "BAD=NAME": "x" } },
    { env: { "": "x" } },
    { env: { VALUE: "\0" } },
    { allowedTools: "Read" },
    { allowedTools: [1] },
    { workflows: "review-loop" },
    { model: 1 },
    { permissionMode: false },
    { model: "op\0us" },
    { maxBudgetUsd: 0 },
    { maxBudgetUsd: -1 },
    { maxBudgetUsd: "15" },
    { maxBudgetUsd: Infinity },
    { maxBudgetUsd: NaN },
  ];
  for (const value of invalid)
    assert.equal(
      isProfilesFile({ profiles: { checker: value } }),
      false,
      JSON.stringify(value),
    );
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_CONFIG_DIR",
  ])
    assert.equal(
      isProfilesFile({ profiles: { checker: { env: { [name]: "x" } } } }),
      false,
      name,
    );
});
