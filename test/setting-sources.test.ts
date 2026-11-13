import assert from "node:assert/strict";
import { test } from "node:test";
import {
  settingFields,
  settingScope,
  validateSetting,
} from "../src/configuration-schema.ts";
import {
  resolveSettings,
  settingSourceMap,
  startSettingLines,
  withoutFileVariables,
} from "../src/project-settings.ts";

await test("CLV-306 the start guide warns for each environment value that hides a file value", () => {
  const resolved = resolveSettings(
    {
      CLOVING_MERGE_MODE: "direct",
      CLOVING_QUEUE_LANES: "2",
      CLOVING_SCHEDULES: "{}",
    },
    {
      project: JSON.stringify({
        version: 1,
        merge: { mode: "queue" },
        queue: { everySeconds: 60 },
      }),
      private: JSON.stringify({ version: 1, queue: { lanes: 3 } }),
    },
  );
  assert.deepEqual(startSettingLines(resolved), [
    "merge.mode: environment",
    "queue.everySeconds: project",
    "queue.lanes: environment",
    "schedules: environment",
    "Warning: CLOVING_MERGE_MODE in the environment hides merge.mode in the project file.",
    "Warning: CLOVING_QUEUE_LANES in the environment hides queue.lanes in the private file.",
  ]);
});

await test("CLV-306 the start records the source of each setting, and default for a setting with no source", () => {
  const resolved = resolveSettings(
    { CLOVING_MERGE_MODE: "direct", CLOVING_SCHEDULES: "{}" },
    {
      project: JSON.stringify({ version: 1, queue: { lanes: 2 } }),
      private: undefined,
    },
  );
  const sources = settingSourceMap(resolved.sources);
  assert.equal(sources["merge.mode"], "environment");
  assert.equal(sources["queue.lanes"], "project");
  assert.equal(sources["watch.port"], "default");
  assert.equal(sources["schedules"], "environment");
  for (const field of settingFields())
    assert.ok(Object.hasOwn(sources, field), field);
});

await test("CLV-315 the private demo.tool setting gives the service CLOVING_DEMO_TOOL", () => {
  const resolved = resolveSettings(
    {},
    {
      project: undefined,
      private: JSON.stringify({ version: 1, demo: { tool: "/tools/demo" } }),
    },
  );
  assert.equal(resolved.environment["CLOVING_DEMO_TOOL"], "/tools/demo");
  assert.equal(resolved.sources["demo.tool"], "private");
  assert.throws(
    () =>
      resolveSettings(
        {},
        {
          project: JSON.stringify({
            version: 1,
            demo: { tool: "/tools/demo" },
          }),
          private: undefined,
        },
      ),
    /private-setting-in-project-file: demo/,
  );
});

await test("CLV-306 a start from the files drops each variable that a settings file can set", () => {
  assert.deepEqual(
    withoutFileVariables({
      PATH: "/bin",
      CLOVING_MERGE_MODE: "queue",
      CLOVING_WORKER: "codex",
      CLOVING_CODEX_COMMAND: "[]",
      CLOVING_CLAUDE_COMMAND: "[]",
      CLOVING_PROFILES: "profiles.json",
      CLOVING_RUNTIME_DIR: "/run",
      CLOVING_SCHEDULES: "{}",
      CLOVING_COMMANDS: "{}",
      CLOVING_COMMAND_SECONDS: "60",
    }),
    {
      PATH: "/bin",
      CLOVING_RUNTIME_DIR: "/run",
    },
  );
});

await test("CLV-320 the private file sets commands, commandSeconds and schedules with the checks of their variables, and the environment wins", () => {
  const commands = { scan: ["/bin/echo", "scan"] };
  const schedules = { scan: { everySeconds: 300, input: {} } };
  const resolved = resolveSettings(
    { CLOVING_COMMAND_SECONDS: "90" },
    {
      project: undefined,
      private: JSON.stringify({
        version: 1,
        commands,
        commandSeconds: 30,
        schedules,
      }),
    },
  );
  assert.equal(
    resolved.environment["CLOVING_COMMANDS"],
    JSON.stringify(commands),
  );
  assert.equal(resolved.environment["CLOVING_COMMAND_SECONDS"], "90");
  assert.equal(
    resolved.environment["CLOVING_SCHEDULES"],
    JSON.stringify(schedules),
  );
  assert.deepEqual(
    [
      resolved.sources["commands"],
      resolved.sources["commandSeconds"],
      resolved.sources["schedules"],
    ],
    ["private", "environment", "private"],
  );
  for (const [field, value] of [
    ["commands", { scan: ["relative-path"] }],
    ["commands", { "bad name": ["/bin/echo"] }],
    ["commandSeconds", 0],
    ["commandSeconds", 3601],
    ["schedules", { scan: { everySeconds: 30, input: {} } }],
    ["schedules", { scan: 5 }],
    ["schedules", "daily"],
  ] as const)
    assert.throws(
      () => {
        validateSetting(field, value);
      },
      new RegExp(`invalid-setting: ${field}`),
    );
  assert.equal(settingScope("commands"), "private");
  assert.throws(
    () =>
      resolveSettings(
        {},
        {
          project: JSON.stringify({ version: 1, commands }),
          private: undefined,
        },
      ),
    /private-setting-in-project-file: commands/,
  );
});

await test("CLV-359 the project and the private file set queues, the private file wins, and the checks refuse bad values", () => {
  const resolved = resolveSettings(
    {},
    {
      project: JSON.stringify({
        version: 1,
        queues: { develop: { state: "off" } },
      }),
      private: JSON.stringify({
        version: 1,
        queues: { develop: { lanes: 3, workingLanes: 2, everySeconds: 60 } },
      }),
    },
  );
  assert.equal(
    resolved.environment["CLOVING_QUEUES"],
    JSON.stringify({
      develop: { state: "off", lanes: 3, workingLanes: 2, everySeconds: 60 },
    }),
  );
  assert.equal(resolved.sources["queues"], "private");
  assert.equal(settingScope("queues"), "project");
  validateSetting("queues", { develop: { state: "on", lanes: 16 } });
  for (const value of [
    { develop: { state: "paused" } },
    { develop: { everySeconds: 9 } },
    { develop: { lanes: 17 } },
    { develop: { lanes: 2, workingLanes: 3 } },
    { develop: { interval: 10 } },
    { "bad name": {} },
    "develop",
  ])
    assert.throws(() => {
      validateSetting("queues", value);
    }, /invalid-setting: queues|unknown-setting: queues/);
});
