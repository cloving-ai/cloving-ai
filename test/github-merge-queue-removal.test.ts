import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "../src/authority/commands.ts";
import { git, resultOf, until } from "./claude-worker-fixture.ts";
import {
  checkRuns,
  conflictingBase,
  groupRuns,
  observer,
  queueCalls,
  queued,
  queueWorker,
  settleQueue,
} from "./github-merge-queue-fixture.ts";
import {
  committed,
  fastTiming,
  opened,
  treeOf,
  withGithub,
} from "./github-worker-fixture.ts";

await test("CLV-297 a pull request that leaves the queue after a failed merge group run gives ci-failed with the failed checks", () =>
  withGithub(async (scene) => {
    const worker = queueWorker(scene);
    const commit = await opened(scene, worker);
    scene.plan({
      scores: [],
      replies: {
        "api GET workflow-runs": groupRuns([
          { id: 78, branch: "gh-readonly-queue/main/pr-12-abc" },
          { id: 77, branch: `gh-readonly-queue/main/pr-1-${commit}` },
        ]),
      },
      sequences: {
        "api GET check-runs": [checkRuns("success"), checkRuns("failure")],
      },
    });
    settleQueue(scene, "removed");
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    const result = resultOf(report.result);
    assert.equal(result["reason"], "ci-failed");
    assert.match(
      String(result["output"]),
      /^Failed check: quality_linux \(failure\)\nFailed step: Run quality\n/,
    );
    assert.ok(
      scene
        .state()
        .calls.some((call) =>
          call.some((part) =>
            part.includes(`/commits/${"77".repeat(20)}/check-runs`),
          ),
        ),
    );
  }));

await test("CLV-297 a pull request that leaves the queue with no merge group run gives merge-queue-removed", () =>
  withGithub(async (scene) => {
    const worker = queueWorker(scene);
    const commit = await opened(scene, worker);
    scene.plan({
      scores: [],
      replies: {
        "api GET workflow-runs": groupRuns([
          { id: 78, branch: "gh-readonly-queue/main/pr-12-abc" },
        ]),
      },
    });
    settleQueue(scene, "removed");
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.deepEqual(resultOf(report.result), {
      reason: "merge-queue-removed",
      output:
        "The pull request left the merge queue without a merge. No failed check of a merge group run was found.",
    });
  }));

await test("CLV-297 a pull request that leaves the queue and now conflicts with main gives the merge-conflict repair", () =>
  withGithub(async (scene) => {
    const worker = queueWorker(scene);
    const commit = await opened(scene, worker);
    const merging = scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    await until(() => queued(scene));
    conflictingBase(scene);
    settleQueue(scene, "removed");
    const report = await merging;
    assert.equal(report.outcome, "completed", report.reason ?? "");
    const result = resultOf(report.result);
    assert.equal(result["reason"], "merge-conflict");
    assert.match(String(result["output"]), /CONFLICT.*src\/one\.ts/s);
    assert.equal(git(treeOf(scene), ["rev-parse", "HEAD"]), commit);
  }));

await test("CLV-297 a pull request that stays in the queue past the wait limit leaves the queue with merge-queue-timeout", () =>
  withGithub(async (scene) => {
    const worker = queueWorker(scene, {
      timing: { ...fastTiming, queueLimitMilliseconds: 200 },
    });
    const commit = await opened(scene, worker);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    const result = resultOf(report.result);
    assert.equal(result["reason"], "merge-queue-timeout");
    assert.match(String(result["output"]), /merge queue.*removed it/);
    const dequeued = queueCalls(scene, "dequeuePullRequest");
    assert.equal(dequeued.length, 1);
    assert.ok(dequeued[0]?.includes("id=PR_1"));
    assert.equal(scene.state().prs[0]?.["dequeued"], true);
    assert.equal(scene.state().prs[0]?.["state"], "OPEN");
  }));

await test("CLV-297 the merge step reports each queue state and position once, then clears the queue notice", () =>
  withGithub(async (scene) => {
    const watched = observer();
    const worker = queueWorker(scene, { observe: watched.observe });
    const commit = await opened(scene, worker);
    scene.plan({ scores: [], queuePolls: 4, queuePosition: 2 });
    settleQueue(scene, "merged");
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.deepEqual(
      watched.reports.map(({ reason, evidence, condition }) => ({
        reason,
        evidence,
        condition,
      })),
      [
        {
          reason: "github-merge-queued",
          evidence: "merge-queue/QUEUED/2",
          condition: "working",
        },
        { reason: "in-progress", evidence: undefined, condition: "working" },
      ],
    );
    for (const observation of watched.reports)
      assert.notEqual(
        parseCommand({ kind: "report-observation", ...observation }),
        null,
      );
  }));

await test("CLV-297 a queue merge of another head than the reviewed head fails the step", () =>
  withGithub(async (scene) => {
    const worker = queueWorker(scene);
    const commit = await opened(scene, worker);
    const merging = scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    await until(() => queued(scene));
    committed(treeOf(scene), { name: "late.ts", text: "3;\n" });
    git(treeOf(scene), [
      "push",
      "--quiet",
      "origin",
      "HEAD:cloving/ticket-one",
    ]);
    settleQueue(scene, "merged");
    const report = await merging;
    assert.equal(report.outcome, "failed");
    assert.equal(report.reason, "merged-other-commit");
  }));

await test("CLV-297 a lost enqueue reply does not add the pull request to the queue again", () =>
  withGithub(async (scene) => {
    const worker = queueWorker(scene);
    const commit = await opened(scene, worker);
    scene.plan({
      scores: [],
      queuePolls: 2,
      failures: [{ call: "api graphql enqueue", detail: "EOF", after: true }],
    });
    settleQueue(scene, "merged");
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(queueCalls(scene, "enqueuePullRequest").length, 1);
  }));

await test("CLV-297 a queue state reply without a pull request fails the step", () =>
  withGithub(async (scene) => {
    const worker = queueWorker(scene);
    const commit = await opened(scene, worker);
    scene.plan({
      scores: [],
      replies: { "api graphql pull": { data: { node: null } } },
    });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "failed");
    assert.equal(report.reason, "github-call-failed");
    assert.deepEqual(queueCalls(scene, "enqueuePullRequest"), []);
  }));
