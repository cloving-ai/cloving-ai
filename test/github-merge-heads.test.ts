import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { mergeCalls } from "./github-merge-fixture.ts";
import { opened, treeOf, withGithub } from "./github-worker-fixture.ts";

await test("CLV-078 rejects malformed pull request heads before merging", async () => {
  for (const head of [undefined, null, [], 42, {}, { sha: null }, { sha: 42 }])
    await withGithub(async (scene) => {
      const worker = scene.worker();
      const commit = await opened(scene, worker);
      scene.plan({
        scores: [],
        replies: { "api GET pull": { merged: false, head } },
      });
      const report = await scene.perform(worker, {
        method: "merge",
        payload: { number: 1, commit },
      });
      assert.deepEqual(
        [report.outcome, report.reason],
        ["failed", "github-call-failed"],
      );
      assert.deepEqual(mergeCalls(scene), []);
      assert.equal(existsSync(treeOf(scene)), true);
    });
});
