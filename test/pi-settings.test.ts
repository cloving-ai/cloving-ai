import assert from "node:assert/strict";
import { test } from "node:test";
import { commandUsage } from "../src/cli/usage.ts";
import { resultOf } from "./claude-worker-fixture.ts";
import { configurationEntries } from "../src/configuration-display.ts";
import { changedConfiguration } from "../src/configuration-change.ts";
import {
  resolveSettings,
  withoutFileVariables,
} from "../src/project-settings.ts";
import { defaultPiCommand, turnHarness } from "../src/harness-defaults.ts";
import {
  harnessDefinition,
  harnessVersion,
} from "../src/agent-harness-versions.ts";

await test("CLV-364 Pi private commands map to their own override and clear on settings restart", () => {
  const settings = JSON.stringify({
    version: 1,
    harness: { name: "pi", command: ["saved-pi", "--mode", "json"] },
  });
  const resolved = resolveSettings(
    {},
    { project: undefined, private: settings },
  );
  assert.equal(
    resolved.environment["CLOVING_PI_COMMAND"],
    '["saved-pi","--mode","json"]',
  );
  const entries = configurationEntries({
    project: undefined,
    private: settings,
    environment: {
      CLOVING_CLAUDE_COMMAND: '["foreign"]',
      CLOVING_PI_COMMAND: '["chosen"]',
    },
    field: "harness.command",
  });
  assert.deepEqual(entries[0]?.value, ["chosen"]);
  assert.equal(entries[0].source, "environment");
  assert.deepEqual(
    withoutFileVariables({ CLOVING_PI_COMMAND: '["old"]', HOME: "kept" }),
    { HOME: "kept" },
  );
});

await test("CLV-364 native Pi settings, environment and profiles share command selection", () => {
  assert.deepEqual(turnHarness({ worker: "pi" }).command, defaultPiCommand);
  assert.deepEqual(
    turnHarness({ harness: { name: "pi", command: ["saved"] } }).command,
    ["saved"],
  );
  assert.deepEqual(
    turnHarness(
      { worker: "claude", workerCommands: { pi: ["private"] } },
      { harness: "pi" },
    ).command,
    ["private"],
  );
  assert.deepEqual(
    configurationEntries({
      project: undefined,
      private: undefined,
      environment: { CLOVING_WORKER: "pi" },
      field: "harness.command",
    })[0]?.value,
    defaultPiCommand,
  );
  const changed = changedConfiguration(undefined, {
    action: "set",
    scope: "private",
    field: "harness.name",
    value: "pi",
  });
  assert.equal(resultOf(changed)["harness"] !== undefined, true);
});

await test("CLV-364 discovery accepts only the qualified Pi version", () => {
  const pattern = harnessDefinition("pi").versionPattern;
  assert.equal(harnessVersion("1.5.2\n", pattern), "1.5.2");
  for (const output of [
    "1.5.1",
    "1.5.20",
    "Pi shim 1.5.2 unavailable",
    "Configured agent is unavailable.",
    "oops 1.5.2",
    "1.5.2-beta",
  ])
    assert.equal(harnessVersion(output, pattern), null);
});

await test("CLV-364 help names the native Pi override", () => {
  assert.match(commandUsage["start"] ?? "", /^ {2}CLOVING_PI_COMMAND /m);
});
