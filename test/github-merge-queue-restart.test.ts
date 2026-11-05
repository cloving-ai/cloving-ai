import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkerReport } from "../src/daemon/operation-journal.ts";
import { resultOf, until } from "./claude-worker-fixture.ts";
import {
  queueCalls,
  queued,
  queueWorker,
  settleAfterPolls,
  settleQueue,
} from "./github-merge-queue-fixture.ts";
import {
  fastTiming,
  githubIntent,
  opened,
  withGithub,
  type GithubScene,
} from "./github-worker-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const operationId = "queue-restart";

function document(commit: string): () => Promise<string> {
  return () => Promise.resolve(JSON.stringify({ number: 1, commit }));
}

async function stopped(
  scene: GithubScene,
  reached: () => boolean,
): Promise<string> {
  const commit = await opened(scene, scene.worker());
  const first = queueWorker(scene, { document: document(commit) });
  await first.deliver(
    githubIntent({ operationId, method: "merge" }),
    new AbortController().signal,
  );
  await until(reached);
  await first.close();
  return commit;
}

async function resumed(
  scene: GithubScene,
  wait: { readonly commit: string; readonly limit: number },
): Promise<WorkerReport> {
  queueWorker(scene, {
    document: document(wait.commit),
    timing: { ...fastTiming, queueLimitMilliseconds: wait.limit },
  });
  await until(() =>
    scene.reports.some((report) => report.operationId === operationId),
  );
  const report = scene.reports.find((item) => item.operationId === operationId);
  if (report === undefined) throw new Error("no report");
  return report;
}

await test("CLV-297 a restart keeps the start of the queue wait that GitHub reports, so the wait limit does not begin again", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      enqueuedAt: new Date(Date.now() - 7_200_000).toISOString(),
    });
    const commit = await stopped(scene, () => queued(scene));
    settleAfterPolls(scene, { result: "merged", polls: 3 });
    const report = await resumed(scene, { commit, limit: 3_600_000 });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    const result = resultOf(report.result);
    assert.equal(result["reason"], "merge-queue-timeout");
    assert.match(String(result["output"]), /queue for 120 minutes/);
    assert.equal(queueCalls(scene, "enqueuePullRequest").length, 1);
    assert.equal(queueCalls(scene, "dequeuePullRequest").length, 1);
  }));

await test("CLV-297 a restart after a stop in the enqueue call gives the pull request the full queue wait", () =>
  withGithub(async (scene) => {
    const limit = testMilliseconds(2000);
    scene.plan({ scores: [], holds: ["api graphql enqueue"] });
    const commit = await stopped(scene, () =>
      existsSync(join(scene.directory, "gh-state.json.held")),
    );
    assert.equal(queued(scene), false);
    scene.plan({ scores: [], holds: [], queuePolls: 2 });
    await delay(limit + testMilliseconds(500));
    settleQueue(scene, "merged");
    const report = await resumed(scene, { commit, limit });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    assert.equal(resultOf(report.result)["merged"], "d".repeat(40));
    assert.deepEqual(queueCalls(scene, "dequeuePullRequest"), []);
  }));
