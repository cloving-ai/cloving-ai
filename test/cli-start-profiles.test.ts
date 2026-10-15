import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withHarness } from "./service-fixture.ts";

await test("CLV-086 start refuses unreadable or invalid profile files before preparing the service", async () => {
  for (const contents of [
    undefined,
    "not JSON",
    '{"profiles":{"checker":{"env":{"GH_TOKEN":"secret"}}}}',
    '{"profiles":{"checker":{"env":{"GH_CONFIG_DIR":"config"}}}}',
  ]) {
    await withHarness((harness) => {
      const file = join(harness.projectDirectory, "profiles.json");
      if (contents !== undefined) writeFileSync(file, contents);
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dirname, "../src/cli.ts"), "start"],
        {
          cwd: harness.projectDirectory,
          env: {
            ...process.env,
            CLOVING_RUNTIME_DIR: harness.runtimeDirectory,
            CLOVING_WATCH_PORT: "off",
            CLOVING_PROFILES: file,
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /invalid-profiles/);
      return Promise.resolve();
    });
  }
});
