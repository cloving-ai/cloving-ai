import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, resultOf } from "./claude-worker-fixture.ts";
import { advancedBase, mergeCalls } from "./github-merge-fixture.ts";
import { opened, withGithub } from "./github-worker-fixture.ts";
import {
  checkRun,
  movingCiScenario,
  workflowRun,
} from "./github-ci-fixture.ts";

function lateWorkflowPlan(commit: string) {
  const fast = checkRun({ name: "fast" });
  const fastWorkflow = workflowRun({
    path: ".github/workflows/fast.yml",
    head_sha: commit,
  });
  return {
    scores: [],
    sequences: {
      "api GET check-runs": [
        [{ check_runs: [fast] }],
        [{ check_runs: [fast] }],
        [
          {
            check_runs: [
              fast,
              checkRun({ status: "queued", conclusion: null }),
            ],
          },
        ],
        [{ check_runs: [fast, checkRun()] }],
      ],
      "api GET workflow-runs": [
        [{ workflow_runs: [fastWorkflow] }],
        [{ workflow_runs: [fastWorkflow] }],
        [
          {
            workflow_runs: [
              fastWorkflow,
              workflowRun({
                head_sha: commit,
                status: "in_progress",
                conclusion: null,
              }),
            ],
          },
        ],
        [
          {
            workflow_runs: [fastWorkflow, workflowRun({ head_sha: commit })],
          },
        ],
      ],
    },
  };
}

await test("CLV-258 merging waits for late Actions checks on the pushed head", () =>
  withGithub(async (scene) => {
    const folder = join(scene.repository, ".github/workflows");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "ci.yml"), "on: pull_request\n");
    writeFileSync(join(folder, "fast.yml"), "on: pull_request\n");
    git(scene.repository, ["add", ".github/workflows"]);
    git(scene.repository, ["commit", "-qm", "Add a pull-request workflow"]);
    git(scene.repository, ["push", "--quiet", "origin", "main"]);
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    scene.plan(lateWorkflowPlan(commit));
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(resultOf(report.result)["merged"], "f".repeat(40));
    const calls = scene.state().calls;
    const checks = calls.filter((call) =>
      call.some((part) => part.includes(`/commits/${commit}/check-runs`)),
    );
    assert.equal(checks.length, 4);
    const merge = calls.find((call) => call.includes("PUT"));
    assert.ok(merge);
    assert.ok(calls.indexOf(merge) > calls.indexOf(checks[3] ?? []));
  }));

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

await test("CLV-163 a base advance during CI repeats local checks and CI before merging", () =>
  withGithub(async (scene) => {
    const { result, commit, base, checked, ci } = await movingCiScenario(
      scene,
      {
        moves: 1,
        conclusion: "success",
      },
    );
    assert.ok("updated" in result);
    assert.notEqual(result.updated, commit);
    assert.equal(git(scene.origin, ["merge-base", result.updated, base]), base);
    assert.deepEqual(checked, [commit, result.updated]);
    assert.deepEqual(
      ci,
      [commit, result.updated].map(
        (head) =>
          `repos/{owner}/{repo}/commits/${head}/check-runs?filter=all&per_page=100`,
      ),
    );
    assert.ok(mergeCalls(scene)[0]?.includes(`sha=${result.updated}`));
  }));

await test("CLV-163 CI failure on the refreshed head prevents merging", () =>
  withGithub(async (scene) => {
    const { result, checked, ci } = await movingCiScenario(scene, {
      moves: 1,
      conclusion: "failure",
    });
    assert.ok("reason" in result);
    assert.equal(result.reason, "ci-failed");
    assert.match(result.output, /quality_linux/);
    assert.equal(checked.length, 2);
    assert.equal(ci.length, 2);
    assert.deepEqual(mergeCalls(scene), []);
  }));

await test("CLV-163 repeated base advances during CI stop after three attempts", () =>
  withGithub(async (scene) => {
    await assert.rejects(
      movingCiScenario(scene, {
        moves: 3,
        conclusion: "success",
      }),
      /base-moved/,
    );
    assert.deepEqual(mergeCalls(scene), []);
  }));
