import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { git } from "./claude-worker-fixture.ts";
import { mergeCalls } from "./github-merge-fixture.ts";
import { opened, treeOf, withGithub } from "./github-worker-fixture.ts";

await test("CLV-078 rejects malformed merge replies and retains the branch", async () => {
  for (const reply of [null, [], 42, {}, { sha: null }, { sha: 42 }])
    await withGithub(async (scene) => {
      const worker = scene.worker();
      const commit = await opened(scene, worker);
      scene.plan({ scores: [], replies: { "api PUT merge": reply } });
      const report = await scene.perform(worker, {
        method: "merge",
        payload: { number: 1, commit },
      });
      assert.deepEqual(
        [report.outcome, report.reason],
        ["failed", "github-call-failed"],
      );
      assert.equal(existsSync(treeOf(scene)), true);
      assert.equal(
        git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
        commit,
      );
      assert.equal(mergeCalls(scene).length, 1);
    });
});
