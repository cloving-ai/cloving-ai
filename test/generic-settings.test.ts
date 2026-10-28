import assert from "node:assert/strict";
import { test } from "node:test";
import { configuration, validateSetting } from "../src/configuration-schema.ts";
import { changedConfiguration } from "../src/configuration-change.ts";
import { turnHarness } from "../src/harness-defaults.ts";
import { configurationEntries } from "../src/configuration-display.ts";

await test("CLV-215 generic configuration never inherits a native command and defaults to text output", () => {
  const input = {
    project: undefined,
    private: JSON.stringify({
      version: 1,
      harness: { name: "mytool", turn: ["mytool"] },
    }),
    environment: { CLOVING_CLAUDE_COMMAND: '["foreign"]' },
  };
  assert.deepEqual(
    configurationEntries({ ...input, field: "harness.command" })[0],
    { field: "harness.command", value: null, source: "default", hidden: [] },
  );
  assert.equal(
    configurationEntries({ ...input, field: "harness.output" })[0]?.value,
    "text",
  );
});

await test("CLV-215 private generic turn and output settings accept only a valid command form", () => {
  for (const turn of [
    ["mytool"],
    ["mytool", "", "{prompt}"],
    ["mytool", "literal {prompt}"],
  ]) {
    assert.doesNotThrow(() => {
      validateSetting("harness.turn", turn);
    });
    assert.deepEqual(
      configuration(
        { version: 1, harness: { name: "mytool", turn, output: "text" } },
        "private",
      ).harness?.turn,
      turn,
    );
  }
  for (const turn of [
    [],
    [""],
    ["{prompt}"],
    ["mytool", "{prompt}", "{prompt}"],
    [1],
    ["mytool", 1],
    ["bad\u0000program"],
    "mytool",
  ]) {
    assert.throws(
      () => {
        validateSetting("harness.turn", turn);
      },
      {
        message: "invalid-setting: harness.turn",
      },
    );
    assert.throws(
      () => configuration({ version: 1, harness: { turn } }, "private"),
      { message: "invalid-setting: harness.turn" },
    );
  }
  assert.doesNotThrow(() => {
    validateSetting("harness.output", "text");
  });
  for (const output of ["json", "", null])
    assert.throws(
      () => {
        validateSetting("harness.output", output);
      },
      {
        message: "invalid-setting: harness.output",
      },
    );
});

await test("CLV-215 config changes save generic fields privately and selection changes discard them", () => {
  let contents = changedConfiguration(undefined, {
    field: "harness.name",
    action: "set",
    value: "mytool",
    scope: "private",
  });
  contents = changedConfiguration(contents, {
    field: "harness.turn",
    action: "set",
    value: '["mytool","{prompt}"]',
    scope: "private",
  });
  contents = changedConfiguration(contents, {
    field: "harness.output",
    action: "set",
    value: '"text"',
    scope: "private",
  });
  assert.deepEqual(configuration(JSON.parse(contents), "private").harness, {
    name: "mytool",
    turn: ["mytool", "{prompt}"],
    output: "text",
  });
  contents = changedConfiguration(contents, {
    field: "harness.name",
    action: "set",
    value: "claude",
    scope: "private",
  });
  assert.deepEqual(configuration(JSON.parse(contents), "private").harness, {
    name: "claude",
  });
});

await test("CLV-215 generic commands win over turn and path only for the matching harness", () => {
  const harness = {
    name: "mytool",
    command: ["winner", "{prompt}"],
    turn: ["loser"],
    path: "also-unused",
  };
  assert.deepEqual(turnHarness({ harness }), {
    worker: "mytool",
    command: ["winner", "{prompt}"],
    output: "text",
  });
  assert.deepEqual(
    turnHarness({
      harness: { name: "mytool", turn: ["loser"], path: "also-unused" },
    }).command,
    ["also-unused"],
  );
  assert.equal(
    turnHarness({ harness }, { harness: "claude" }).worker,
    "claude",
  );
  assert.equal(
    turnHarness({ harness }, { harness: "claude" }).command[0],
    "claude",
  );
  assert.throws(() => turnHarness({ harness }, { harness: "other" }), {
    message: "harness-no-worker: other",
  });
  for (const turn of [[], [""], ["{prompt}"]])
    assert.throws(() => turnHarness({ harness: { name: "mytool", turn } }), {
      message: "invalid-setting: harness.turn",
    });
});
