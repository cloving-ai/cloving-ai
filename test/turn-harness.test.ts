import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultCommand,
  defaultCodexCommand,
  turnHarness,
} from "../src/harness-defaults.ts";

await test("CLV-210 private harness is the default with its saved program", () => {
  assert.deepEqual(turnHarness({}), {
    worker: "claude",
    command: defaultCommand,
  });
  assert.deepEqual(
    turnHarness({
      harness: { name: "codex", kind: "file", path: "/opt/bin/codex" },
    }),
    {
      worker: "codex",
      command: ["/opt/bin/codex", ...defaultCodexCommand.slice(1)],
    },
  );
});

await test("CLV-210 profile then environment override the private harness without its settings", () => {
  const settings = {
    worker: "codex",
    harness: {
      name: "codex",
      kind: "shell" as const,
      path: "private-program",
      command: ["private-command"],
    },
    workerCommands: { claude: ["environment-claude"] },
    shell: "/bin/test-shell",
  };
  assert.deepEqual(turnHarness(settings, { harness: "claude" }), {
    worker: "claude",
    command: ["environment-claude"],
  });
  assert.deepEqual(
    turnHarness({ ...settings, workerCommands: {} }, { harness: "claude" }),
    {
      worker: "claude",
      command: defaultCommand,
    },
  );
  assert.deepEqual(turnHarness({ ...settings, worker: "claude" }), {
    worker: "claude",
    command: ["environment-claude"],
  });
});

await test("CLV-210 matching harness commands precede saved commands and saved paths", () => {
  const harness = { name: "codex", command: ["private-codex"], path: "unused" };
  assert.deepEqual(turnHarness({ harness }).command, ["private-codex"]);
  assert.deepEqual(
    turnHarness({ harness, workerCommands: { codex: ["environment-codex"] } })
      .command,
    ["environment-codex"],
  );
  assert.deepEqual(
    turnHarness({
      harness: { name: "codex", kind: "shell" },
      shell: "/bin/test-shell",
    }),
    {
      worker: "codex",
      command: defaultCodexCommand,
      shell: "/bin/test-shell",
    },
  );
});

await test("CLV-210 unsupported harnesses identify the missing worker", () => {
  for (const settings of [
    { worker: "gemini" },
    { harness: { name: "gemini" } },
  ])
    assert.throws(() => turnHarness(settings), {
      message: "harness-no-worker: gemini",
    });
  assert.throws(() => turnHarness({}, { harness: "gemini" }), {
    message: "harness-no-worker: gemini",
  });
});
