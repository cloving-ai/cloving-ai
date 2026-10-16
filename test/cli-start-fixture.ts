import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { withHarness } from "./service-fixture.ts";

export async function refusedStart(
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
  return withHarness((harness) => {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../src/cli.ts"), "start"],
      {
        cwd: harness.projectDirectory,
        env: {
          ...process.env,
          CLOVING_RUNTIME_DIR: harness.runtimeDirectory,
          CLOVING_WATCH_PORT: "off",
          ...environment,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    return Promise.resolve(result.stderr);
  });
}
