import assert from "node:assert/strict";
import { test } from "node:test";
import { resultOf } from "./claude-worker-fixture.ts";
import { advancedBase, mergeCalls } from "./github-merge-fixture.ts";
import { opened, withGithub } from "./github-worker-fixture.ts";
import { checkRun } from "./github-ci-fixture.ts";

await test("CLV-163 required green CI merges the checked SHA after pushing an updated head", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({
      check: [process.execPath, "-e", ""],
      environment: {
        FAKE_GH_STATE: `${scene.directory}/gh-state.json`,
        FAKE_GH_ORIGIN: scene.origin,
        CLOVING_REQUIRED_CHECKS: '["quality","quality_linux"]',
      },
    });
    const commit = await opened(scene, worker);
    advancedBase(scene);
    scene.plan({
      scores: [],
      replies: {
        "api GET check-runs": [
          {
            check_runs: [
              checkRun(),
              checkRun({ id: 102, name: "quality", conclusion: "neutral" }),
            ],
          },
        ],
      },
    });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    const result = resultOf(report.result);
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(result["merged"], "f".repeat(40));
    const updated = String(result["updated"]);
    assert.notEqual(updated, commit);
    assert.ok(
      scene
        .state()
        .calls.some((call) =>
          call.some((part) => part.includes(`/commits/${updated}/check-runs`)),
        ),
    );
    assert.ok(mergeCalls(scene)[0]?.includes(`sha=${updated}`));
  }));

await test("CLV-163 no CI merges after the grace period and a missing required check times out without merging", async () => {
  for (const required of [false, true])
    await withGithub(async (scene) => {
      const worker = scene.worker({
        timing: {
          pollMilliseconds: 5,
          triggerMilliseconds: 10,
          limitMilliseconds: 20,
          ciGraceMilliseconds: 60,
          ciLimitMilliseconds: 150,
        },
        environment: {
          FAKE_GH_STATE: `${scene.directory}/gh-state.json`,
          FAKE_GH_ORIGIN: scene.origin,
          ...(required ? { CLOVING_REQUIRED_CHECKS: '["quality_linux"]' } : {}),
        },
      });
      const commit = await opened(scene, worker);
      scene.plan({
        scores: [],
        replies: { "api GET check-runs": [{ check_runs: [] }] },
      });
      const report = await scene.perform(worker, {
        method: "merge",
        payload: { number: 1, commit },
      });
      assert.equal(report.outcome, "completed", report.reason ?? "");
      assert.equal(
        resultOf(report.result)["reason"],
        required ? "ci-pending" : undefined,
      );
      assert.equal(mergeCalls(scene).length, required ? 0 : 1);
    });
});
