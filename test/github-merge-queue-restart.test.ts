import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  operationKey,
  type WorkerReport,
} from "../src/daemon/operation-journal.ts";
import { resultOf, until } from "./claude-worker-fixture.ts";
import {
  queueCalls,
  queued,
  queueWorker,
} from "./github-merge-queue-fixture.ts";
import {
  fastTiming,
  githubIntent,
  opened,
  withGithub,
  type GithubScene,
} from "./github-worker-fixture.ts";

const operationId = "queue-restart";

interface Stopped {
  readonly commit: string;
  readonly record: string;
  readonly startedAt: number;
}

function document(commit: string): () => Promise<string> {
  return () => Promise.resolve(JSON.stringify({ number: 1, commit }));
}

async function stoppedInQueue(scene: GithubScene): Promise<Stopped> {
  const commit = await opened(scene, scene.worker());
  const first = queueWorker(scene, { document: document(commit) });
  await first.deliver(
    githubIntent({ operationId, method: "merge" }),
    new AbortController().signal,
  );
  await until(() => queued(scene));
  await first.close();
  const record = join(
    scene.journal,
    operationKey(operationId),
    `queue-${operationKey(commit)}.json`,
  );
  const saved = resultOf(readFileSync(record, "utf8"));
  assert.equal(saved["commit"], commit);
  assert.equal(typeof saved["startedAt"], "number");
  return { commit, record, startedAt: Number(saved["startedAt"]) };
}

async function resumed(
  scene: GithubScene,
  commit: string,
): Promise<WorkerReport> {
  queueWorker(scene, {
    document: document(commit),
    timing: { ...fastTiming, queueLimitMilliseconds: 1500 },
  });
  await until(() =>
    scene.reports.some((report) => report.operationId === operationId),
  );
  const report = scene.reports.find((item) => item.operationId === operationId);
  if (report === undefined) throw new Error("no report");
  return report;
}

await test("CLV-297 a restart keeps the start of the queue wait, so the wait limit does not begin again", () =>
  withGithub(async (scene) => {
    const stopped = await stoppedInQueue(scene);
    writeFileSync(
      stopped.record,
      JSON.stringify({
        commit: stopped.commit,
        startedAt: stopped.startedAt - 7_200_000,
      }),
    );
    const report = await resumed(scene, stopped.commit);
    assert.equal(report.outcome, "completed", report.reason ?? "");
    const result = resultOf(report.result);
    assert.equal(result["reason"], "merge-queue-timeout");
    assert.match(String(result["output"]), /queue for 120 minutes/);
    assert.equal(queueCalls(scene, "enqueuePullRequest").length, 1);
    assert.equal(queueCalls(scene, "dequeuePullRequest").length, 1);
  }));

await test("CLV-297 a malformed start record of the queue wait fails the step and keeps the pull request in the queue", () =>
  withGithub(async (scene) => {
    const stopped = await stoppedInQueue(scene);
    writeFileSync(
      stopped.record,
      JSON.stringify({ commit: stopped.commit, startedAt: "wrong" }),
    );
    const report = await resumed(scene, stopped.commit);
    assert.equal(report.outcome, "failed");
    assert.equal(report.reason, "github-call-failed");
    assert.deepEqual(queueCalls(scene, "dequeuePullRequest"), []);
    assert.ok(queued(scene));
  }));
