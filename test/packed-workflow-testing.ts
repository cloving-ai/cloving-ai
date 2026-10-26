import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { operatorFiles } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

const files = {
  ...operatorFiles("project", "develop"),
  ...operatorFiles("user", "personal"),
  "repo/.cloving/workflows/develop.test.ts": `
import assert from "node:assert/strict";
import { test } from "node:test";
import { runScenario } from "cloving/workflows/testing";
await test("global package scenario", async () => {
  const result = await runScenario({
    workflow: new URL("./develop.ts", import.meta.url).href,
    exportName: "develop", input: {},
    turn: { kind: "completed", operationId: "global-turn", receipt: null, result: "global-result" },
  });
  assert.deepEqual(result.outcome, { kind: "completed", operationId: "global-turn", receipt: null, result: "global-result" });
});`,
  "config/cloving/workflows/personal.test.ts": `
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { personal } from "./personal.ts";
await test("global user scenario", async () => {
  using bridge = fakeStepBridge({ turn: { kind: "completed", operationId: "user", receipt: null, result: "user-result" } });
  assert.equal((await personal()).result, "user-result");
  assert.equal(bridge.requests.length, 1);
});`,
};

export async function packedWorkflowTesting(root: string): Promise<void> {
  const archive = (await readdir(root)).find((file) => file.endsWith(".tgz"));
  assert.ok(archive);
  const prefix = join(root, "global");
  const installed = spawnSync(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      join(root, archive),
    ],
    { cwd: root, encoding: "utf8", timeout: 120000 },
  );
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  await withFiles(
    files,

    async (directory) => {
      const repository = join(directory, "repo");
      await assert.rejects(lstat(join(repository, "node_modules")), {
        code: "ENOENT",
      });
      const result = spawnSync(
        join(prefix, "bin/cloving"),
        ["workflows", "test"],
        {
          cwd: repository,
          env: {
            ...process.env,
            NODE_OPTIONS: undefined,
            NODE_PATH: undefined,
            NODE_TEST_CONTEXT: undefined,
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, "config"),
          },
          encoding: "utf8",
          timeout: 30000,
        },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /global package scenario/);
      assert.match(result.stdout, /global user scenario/);
      await assert.rejects(lstat(join(repository, "node_modules")), {
        code: "ENOENT",
      });
    },
  );
}
