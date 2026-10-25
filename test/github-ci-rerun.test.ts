import assert from "node:assert/strict";
import { test } from "node:test";
import { resultOf, until } from "./claude-worker-fixture.ts";
import { mergeCalls } from "./github-merge-fixture.ts";
import { githubIntent, opened, withGithub } from "./github-worker-fixture.ts";
import { checkRun } from "./github-ci-fixture.ts";

await test("CLV-198 a refused rerun request is a transient GitHub failure, not a fix round", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    scene.plan({
      scores: [],
      replies: {
        "api GET check-runs": [
          { check_runs: [checkRun({ conclusion: "failure" })] },
        ],
        "api GET workflow-run": {
          run_attempt: 1,
          status: "completed",
          head_sha: commit,
        },
      },
      failures: [{ call: "run rerun", detail: "TLS handshake timeout" }],
    });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "failed");
    assert.equal(report.reason, "github-network-failed");
    assert.deepEqual(mergeCalls(scene), []);
  }));

await test("CLV-198 restarting while GitHub still shows attempt one does not repeat the rerun", () =>
  withGithub(async (scene) => {
    const commit = await opened(scene, scene.worker());
    const first = scene.worker({
      document: () => Promise.resolve(JSON.stringify({ number: 1, commit })),
      timing: {
        pollMilliseconds: 100,
        triggerMilliseconds: 10,
        limitMilliseconds: 600,
      },
    });
    const checks = [{ check_runs: [checkRun({ conclusion: "failure" })] }];
    const workflow = { run_attempt: 1, status: "completed", head_sha: commit };
    scene.plan({
      scores: [],
      replies: {
        "api GET check-runs": checks,
        "api GET workflow-run": workflow,
      },
    });
    const intent = githubIntent({ operationId: "ci-restart", method: "merge" });
    await first.deliver(intent, new AbortController().signal);
    await until(() => scene.state().calls.some((call) => call[1] === "rerun"));
    await first.close();
    scene.plan({
      scores: [],
      sequences: {
        "api GET check-runs": [
          checks,
          [{ check_runs: [checkRun({ id: 102 })] }],
        ],
        "api GET workflow-run": [
          workflow,
          { run_attempt: 2, status: "completed", head_sha: commit },
        ],
      },
    });
    scene.worker();
    await until(() =>
      scene.reports.some((report) => report.operationId === "ci-restart"),
    );
    const report = scene.reports.find(
      (report) => report.operationId === "ci-restart",
    );
    assert.equal(resultOf(report?.result)["merged"], "f".repeat(40));
    assert.equal(
      scene.state().calls.filter((call) => call[1] === "rerun").length,
      1,
    );
  }));

await test("CLV-198 a second failed attempt reports both outputs without another rerun", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    scene.plan({
      scores: [],
      sequences: {
        "api GET check-runs": [
          [{ check_runs: [checkRun({ conclusion: "failure" })] }],
          [{ check_runs: [checkRun({ id: 102, conclusion: "failure" })] }],
        ],
        "api GET workflow-run": [
          { run_attempt: 1, status: "completed", head_sha: commit },
          { run_attempt: 2, status: "completed", head_sha: commit },
        ],
        "run view": [
          "first failure output",
          "first failure tail",
          "second failure output",
          "second failure tail",
        ],
      },
    });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    const result = resultOf(report.result);
    assert.equal(result["reason"], "ci-failed");
    assert.match(
      String(result["output"]),
      /Attempt 1[\s\S]*first failure tail/,
    );
    assert.match(
      String(result["output"]),
      /Attempt 2[\s\S]*second failure tail/,
    );
    assert.equal(
      scene.state().calls.filter((call) => call[1] === "rerun").length,
      1,
    );
    assert.deepEqual(mergeCalls(scene), []);
  }));

await test("CLV-198 a first failed CI attempt reruns failed jobs and merges after passing", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    scene.plan({
      scores: [],
      sequences: {
        "api GET check-runs": [
          [{ check_runs: [checkRun({ conclusion: "failure" })] }],
          [{ check_runs: [checkRun({ id: 102 })] }],
        ],
        "api GET workflow-run": [
          { run_attempt: 1, status: "completed", head_sha: commit },
          { run_attempt: 2, status: "completed", head_sha: commit },
        ],
      },
    });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.deepEqual(
      scene.state().calls.filter((call) => call[1] === "rerun"),
      [["run", "rerun", "88", "--failed"]],
    );
    assert.equal(resultOf(report.result)["merged"], "f".repeat(40));
    assert.equal(mergeCalls(scene).length, 1);
  }));
