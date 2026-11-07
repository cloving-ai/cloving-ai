import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const program = join(import.meta.dirname, "../tools/self-host-reload.ts");

function reloadedWith(root: string): Readonly<Record<string, unknown>> {
  const result = spawnSync(
    process.execPath,
    [
      program,
      JSON.stringify({
        directory: join(root, "host"),
        home: root,
        repository: join(root, "repository"),
      }),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: join(root, "config") },
      timeout: testMilliseconds(90_000),
    },
  );
  const reply = record(JSON.parse(result.stdout));
  assert.ok(reply, result.stdout + result.stderr);
  return reply;
}

await test("CLV-322 the reload program refuses an effect reserve of 9 or -1 with invalid-effect-settings", () =>
  withFiles({ "host/marker": "", "repository/README.md": "" }, async (root) => {
    await mkdir(join(root, "repository/.cloving"), { recursive: true });
    for (const reserved of [9, -1]) {
      await writeFile(
        join(root, "repository/.cloving/config.json"),
        JSON.stringify({ version: 1, effects: { reserved } }),
      );
      const reply = reloadedWith(root);
      assert.deepEqual(
        record(reply["refusal"])?.["code"],
        "invalid-effect-settings",
        JSON.stringify(reply),
      );
    }
  }));
