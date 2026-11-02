import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { git } from "./claude-worker-fixture.ts";
import { mergeCalls } from "./github-merge-fixture.ts";
import { opened, treeOf, withGithub } from "./github-worker-fixture.ts";

await test("CLV-078 rejects malformed known merge commits without cleanup", async () => {
  for (const merged of [undefined, null, 42, false, {}, []])
    await withGithub(async (scene) => {
      const worker = scene.worker();
      const commit = await opened(scene, worker);
      scene.plan({
        scores: [],
        replies: {
          "api GET pull": {
            merged: true,
            head: { sha: commit },
            merge_commit_sha: merged,
          },
        },
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
      assert.equal(
        git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
        commit,
      );
    });
});
