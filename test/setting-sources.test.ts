import assert from "node:assert/strict";
import { test } from "node:test";
import { settingFields } from "../src/configuration-schema.ts";
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
    "CLOVING_SCHEDULES: environment",
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
  assert.equal(sources["CLOVING_SCHEDULES"], "environment");
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
    }),
    {
      PATH: "/bin",
      CLOVING_RUNTIME_DIR: "/run",
      CLOVING_SCHEDULES: "{}",
    },
  );
});
