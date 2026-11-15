import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { reloadQueueSettings } from "../src/daemon/queue-settings-reload.ts";
import { queueLimitsSource } from "../src/daemon/queue-limits.ts";
import { workflowReload } from "../src/daemon/workflow-reload.ts";
import { turnSettingsSource } from "../src/daemon/settings-reload.ts";
import { withFiles } from "./quality/files-fixture.ts";

import {
  declared,
  request,
  settings,
  command,
} from "./queue-settings-reload-fixture.ts";

await test("CLV-377 refused or malformed settings subprocess output preserves running limits and digests", async () => {
  const source = queueLimitsSource({ declarations: [declared] });
  const before = source.current("alpha");
  const digests = { queues: "old:old" };
  for (const [command, code, detail] of refusedCommands()) {
    const reply = await reloadQueueSettings({
      command,
      declarations: [declared],
      request,
      digests,
      source,
    });
    assert.equal(reply.outcome.kind, "refused");
    assert.equal(Reflect.get(reply.outcome, "code"), code);
    assert.match(String(Reflect.get(Object(reply.outcome), "detail")), detail);
    assert.deepEqual(source.current("alpha"), before);
    assert.deepEqual(reply.digests, digests);
  }
});

await test("CLV-377 settings reload keeps running workflow refusals, profiles and bundle identity", () =>
  withFiles({}, async (directory) => {
    const source = queueLimitsSource({
      declarations: [declared],
      queueLimits: { lanes: 3, workingLanes: 1 },
    });
    const turns = turnSettingsSource({
      profiles: {},
      fallbackModels: [],
      tokenPrices: {},
    });
    const refusal = {
      scope: "project",
      label: "broken.ts",
      codes: ["compile-failed"],
    } as const;
    const reload = workflowReload({
      directory,
      repository: directory,
      runtimeDirectory: directory,
      command: [],
      concurrency: 1,
      manifests: {},
      workflows: {},
      handler: () => Promise.resolve(new Response()),
      declarations: [declared],
      bundleDigest: "a".repeat(64),
      workflowRefusals: [refusal],
      reloadCommand: command(settings),
      loadBundle: () => {
        throw new Error("No bundle may load.");
      },
      generations: {
        replace: () => {
          throw new Error("No generation may change.");
        },
      },
      turnSettings: turns,
      queueLimitSource: source,
    });
    const reply = await reload(request);
    assert.equal(reply.kind, "unchanged");
    assert.deepEqual(Reflect.get(reply, "workflowRefusals"), [refusal]);
    assert.deepEqual(turns.current().profiles, {});
    assert.equal(source.current("alpha").lanes, 2);
  }));

function queueProgram(root: string, declarations: string) {
  return spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "../tools/self-host-reload.ts"),
      JSON.stringify({ directory: root, repository: root }),
      "--queue-settings",
      declarations,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(root, "config"),
        CLOVING_QUEUES: undefined,
      },
    },
  );
}

await test("CLV-377 queue settings preparation validates pinned declarations and config without preparing workflow source", () =>
  withFiles(
    {
      ".cloving/config.json": JSON.stringify({
        version: 1,
        queues: { alpha: { lanes: 2 } },
      }),
    },
    async (root) => {
      const reply = queueProgram(root, JSON.stringify([declared]));
      assert.equal(reply.status, 0, reply.stdout + reply.stderr);
      const value: unknown = JSON.parse(reply.stdout);
      assert.equal(
        Reflect.get(Object(Reflect.get(Object(value), "queueLimits")), "lanes"),
        2,
      );
      for (const declarations of [
        "null",
        "[null]",
        JSON.stringify([{ ...declared, functionName: undefined }]),
        "invalid",
      ]) {
        const rejected = queueProgram(root, declarations);
        assert.equal(rejected.status, 1);
        assert.match(rejected.stdout, /running declarations|SyntaxError/);
      }
      await writeFile(join(root, ".cloving/config.json"), "invalid");
      const invalid = queueProgram(root, JSON.stringify([declared]));
      assert.equal(invalid.status, 1);
      assert.match(invalid.stdout, /invalid-config-json/);
      await writeFile(
        join(root, ".cloving/config.json"),
        JSON.stringify({ version: 1, queue: { lanes: 3 } }),
      );
      const unqueued = queueProgram(root, "[]");
      assert.equal(unqueued.status, 1);
      assert.match(unqueued.stdout, /queue-lanes-needs-queue/);
    },
  ));

function refusedCommands(): readonly (readonly [
  readonly string[],
  string,
  RegExp,
])[] {
  return [
    [
      command({
        refusal: { code: "invalid-config-json", detail: "Fix private JSON." },
      }),
      "invalid-config-json",
      /Fix private JSON/,
    ],
    [
      command({ error: "Error: missing repository" }),
      "reload-failed",
      /missing repository/,
    ],
    [
      command({ ...settings, queueLimits: null }),
      "reload-failed",
      /no queue settings/,
    ],
    [
      [process.execPath, "-e", "process.stdout.write('invalid')", "--"],
      "reload-failed",
      /no queue settings/,
    ],
    [
      [
        process.execPath,
        "-e",
        "process.stderr.write('failed'); process.exit(3)",
        "--",
      ],
      "reload-failed",
      /code 3: failed/,
    ],
    [
      [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(JSON.stringify(settings))}); process.exit(2)`,
        "--",
      ],
      "reload-failed",
      /code 2/,
    ],
  ];
}
