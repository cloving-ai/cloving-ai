import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { withHarness } from "./service-fixture.ts";
import { writeQueueWorkflow } from "./workflow-folder-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

export async function refusedStart(
  environment: Readonly<NodeJS.ProcessEnv>,
  options: { readonly queue?: true; readonly entry?: string } = {},
): Promise<string> {
  return withHarness(async (harness) => {
    if (options.queue === true)
      await writeQueueWorkflow(
        join(harness.projectDirectory, ".cloving/workflows"),
      );
    const result = spawnSync(
      process.execPath,
      [options.entry ?? join(import.meta.dirname, "../src/cli.ts"), "start"],
      {
        cwd: harness.projectDirectory,
        env: {
          ...process.env,
          CLOVING_RUNTIME_DIR: harness.runtimeDirectory,
          CLOVING_WATCH_PORT: "off",
          ...environment,
        },
        encoding: "utf8",
        timeout: testMilliseconds(10000),
      },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    return result.stderr;
  });
}
