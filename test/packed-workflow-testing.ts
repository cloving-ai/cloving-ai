import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { operatorFiles } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

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
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
import { reviewByPerson } from "cloving/workflows/steps/review-by-person";
import { sleep } from "cloving/workflows";
import { sleep as pause } from "cloving/workflows/steps/sleep";
import { personal } from "./personal.ts";
await test("global user scenario", async () => {
  using bridge = fakeStepBridge({ decisions: [{ decision: "approved", answer: null }, { decision: "denied", answer: "Revise the draft." }], turn: { kind: "completed", operationId: "user", receipt: null, result: "user-result" } });
  assert.equal((await personal()).result, "user-result");
  assert.deepEqual(await waitForDecision({ gateId: "review", kind: "approval", prompt: "Approve?" }), { decision: "approved", answer: null });
  assert.equal(bridge.requests.length, 2);
  assert.equal(bridge.requests[1][0], "waitForDecision");
  const review = await reviewByPerson({ subject: { draft: "The packed draft." } });
  assert.deepEqual({ ...review, subjectDigest: "digest" }, { accepted: false, feedback: "Revise the draft.", commit: null, subjectDigest: "digest" });
  assert.match(review.subjectDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(bridge.requests[2][0], "waitForDecision");
  await sleep({ seconds: 86400 });
  await pause({ seconds: 1 });
  assert.deepEqual(bridge.requests.slice(3), [["sleep", { seconds: 86400 }], ["sleep", { seconds: 1 }]]);
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
          timeout: testMilliseconds(30000),
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
