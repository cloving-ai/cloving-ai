import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { inMergeTurn } from "../src/daemon/merge-turns.ts";
import { resultOf, until } from "./claude-worker-fixture.ts";
import { advancedBase, mergeCalls } from "./github-merge-fixture.ts";
import {
  enqueuedBefore,
  queueCalls,
  queued,
  queueWorker,
  settleQueue,
} from "./github-merge-queue-fixture.ts";
import { opened, withGithub } from "./github-worker-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

await test("CLV-297 with no merge mode the merge step merges with the REST endpoint and makes no merge queue call", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    settleQueue(scene, "merged");
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(mergeCalls(scene).length, 1);
    assert.deepEqual(
      scene.state().calls.filter((call) => call[1] === "graphql"),
      [],
    );
  }));

await test("CLV-297 queue mode checks main merged into the head, adds the reviewed head to the queue and gives the merge commit", () =>
  withGithub(async (scene) => {
    const trace = join(scene.directory, "git-trace");
    const checked = join(scene.directory, "checked");
    const worker = queueWorker(scene, {
      environment: {
        FAKE_GH_STATE: join(scene.directory, "gh-state.json"),
        FAKE_GH_ORIGIN: scene.origin,
        GIT_TRACE: trace,
      },
      check: [
        process.execPath,
        "-e",
        `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(checked)}, fs.readFileSync("src/base.ts", "utf8"));`,
      ],
    });
    const commit = await opened(scene, worker);
    advancedBase(scene);
    writeFileSync(trace, "");
    settleQueue(scene, "merged");
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.deepEqual(resultOf(report.result), {
      number: 1,
      commit,
      updated: commit,
      merged: "d".repeat(40),
    });
    assert.equal(readFileSync(checked, "utf8"), "2;\n");
    assert.doesNotMatch(readFileSync(trace, "utf8"), /built-in: git push/);
    assert.deepEqual(mergeCalls(scene), []);
    assert.equal(scene.state().prs[0]?.["mergedHead"], commit);
    const enqueued = queueCalls(scene, "enqueuePullRequest");
    assert.equal(enqueued.length, 1);
    assert.ok(enqueued[0]?.includes("id=PR_1"));
    assert.ok(enqueued[0]?.includes(`head=${commit}`));
    assert.match(String(enqueued[0]), /expectedHeadOid: \$head/);
  }));

await test("CLV-297 queue mode leaves the merge turn while the pull request waits in the queue", () =>
  withGithub(async (scene) => {
    const worker = queueWorker(scene);
    const commit = await opened(scene, worker);
    const merging = scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    await until(() => queued(scene));
    const second = await Promise.race([
      inMergeTurn(
        { repository: scene.repository, signal: new AbortController().signal },
        () => Promise.resolve("started"),
      ),
      delay(testMilliseconds(3000)).then(() => "waiting"),
    ]);
    assert.equal(second, "started");
    assert.equal(scene.state().prs[0]?.["state"], "OPEN");
    settleQueue(scene, "merged");
    const report = await merging;
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(resultOf(report.result)["merged"], "d".repeat(40));
  }));

await test("CLV-297 queue mode waits for a pull request that is already in the queue and does not add it again", () =>
  withGithub(async (scene) => {
    const worker = queueWorker(scene);
    const commit = await opened(scene, worker);
    enqueuedBefore(scene, commit);
    scene.plan({ scores: [], queuePolls: 2 });
    settleQueue(scene, "merged");
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(resultOf(report.result)["merged"], "d".repeat(40));
    assert.equal(queueCalls(scene, "enqueuePullRequest").length, 1);
  }));

await test("CLV-297 queue mode gives the known merge of a pull request that GitHub merged before the step", () =>
  withGithub(async (scene) => {
    const worker = queueWorker(scene);
    const commit = await opened(scene, worker);
    scene.gh([
      "api",
      "-X",
      "PUT",
      "repos/{owner}/{repo}/pulls/1/merge",
      "-f",
      `sha=${commit}`,
    ]);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(resultOf(report.result)["merged"], "f".repeat(40));
    assert.deepEqual(queueCalls(scene, "enqueuePullRequest"), []);
  }));

await test("CLV-297 queue mode gives the merge commit of a queued pull request that GitHub merged before the step read the queue", () =>
  withGithub(async (scene) => {
    const worker = queueWorker(scene);
    const commit = await opened(scene, worker);
    enqueuedBefore(scene, commit);
    settleQueue(scene, "merged");
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(resultOf(report.result)["merged"], "d".repeat(40));
    assert.equal(queueCalls(scene, "enqueuePullRequest").length, 1);
  }));
