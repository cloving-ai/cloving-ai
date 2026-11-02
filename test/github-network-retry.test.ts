import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { resultOf } from "./claude-worker-fixture.ts";
import { mergeCalls, movingMerge } from "./github-merge-fixture.ts";
import { opened, treeOf, withGithub } from "./github-worker-fixture.ts";

for (const status of [405, 409]) {
  await test(`CLV-256 refreshes main after an unchanged head merge gets HTTP ${String(status)}`, () =>
    withGithub(async (scene) => {
      const worker = scene.worker({
        gh: movingMerge(scene, { limit: 1 }),
        check: [process.execPath, "-e", ""],
      });
      const commit = await opened(scene, worker);
      scene.plan({ scores: [], mergeRefusals: 1, mergeStatus: status });
      const report = await scene.perform(worker, {
        method: "merge",
        payload: { number: 1, commit },
      });
      assert.ok(mergeCalls(scene)[0]?.includes(`sha=${commit}`));
      assert.equal(report.outcome, "completed", report.reason ?? "");
      const result = resultOf(report.result);
      const updated = String(result["updated"]);
      assert.notEqual(updated, commit);
      assert.equal(scene.state().prs[0]?.["mergedHead"], updated);
      assert.deepEqual(
        mergeCalls(scene).map((call) =>
          call.find((part) => part.startsWith("sha=")),
        ),
        [`sha=${commit}`, `sha=${updated}`],
      );
      const calls = scene.state().calls;
      const firstMerge = calls.findIndex((call) => call.includes("PUT"));
      assert.ok(
        calls
          .slice(0, firstMerge)
          .some((call) =>
            call.some((part) => part.includes(`/commits/${commit}/check-runs`)),
          ),
      );
      assert.deepEqual(calls[firstMerge + 1], [
        "api",
        "repos/{owner}/{repo}/pulls/1",
      ]);
      assert.ok(
        calls
          .slice(firstMerge + 1)
          .some((call) =>
            call.some((part) =>
              part.includes(`/commits/${updated}/check-runs`),
            ),
          ),
      );
    }));
}

await test("CLV-256 reconciles an unchanged head merged before its HTTP 405 reply", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    scene.plan({
      scores: [],
      failures: [
        {
          call: "api PUT merge",
          detail: "gh: Pull Request is not mergeable (HTTP 405)",
          after: true,
        },
      ],
    });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.deepEqual(resultOf(report.result), {
      number: 1,
      commit,
      updated: commit,
      merged: "f".repeat(40),
    });
    assert.equal(mergeCalls(scene).length, 1);
    assert.equal(existsSync(treeOf(scene)), false);
  }));
