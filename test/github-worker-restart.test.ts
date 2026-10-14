import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { DeliveryIntent } from "../src/broker/actor/delivery-intents.ts";
import { git, journalKey, resultOf, until } from "./claude-worker-fixture.ts";
import {
  githubIntent,
  opened,
  treeOf,
  withGithub,
  type GithubScene,
} from "./github-worker-fixture.ts";

const signal = new AbortController().signal;
const slow = {
  pollMilliseconds: 10,
  triggerMilliseconds: 60_000,
  limitMilliseconds: 60_000,
};
const kept = {
  runId: "run-7",
  inputDigest: `sha256:${"b".repeat(64)}`,
  leaseGeneration: 3,
};

function folderOf(scene: GithubScene, operationId: string): string {
  return join(scene.journal, journalKey(operationId));
}

function accepted(operationId: string): unknown {
  return {
    kind: "accepted",
    receipt: journalKey(operationId),
    worker: "github",
  };
}

async function interruptedWait(
  scene: GithubScene,
): Promise<DeliveryIntent & { readonly commit: string }> {
  const worker = scene.worker({ timing: slow });
  const commit = await opened(scene, worker);
  const first = scene.worker({
    timing: slow,
    document: () => Promise.resolve(JSON.stringify({ number: 1, commit })),
  });
  const given = githubIntent({
    ...kept,
    operationId: "operation-wait",
    method: "wait-review",
  });
  await first.deliver(given, signal);
  await first.close();
  return { ...given, commit };
}

function leftBehind(
  scene: GithubScene,
  operation: { readonly operationId: string; readonly value: unknown },
): void {
  const folder = folderOf(scene, operation.operationId);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "started.json"), JSON.stringify(operation.value));
}

function mergedBefore(scene: GithubScene, commit: string): void {
  scene.gh([
    "api",
    "-X",
    "PUT",
    "repos/{owner}/{repo}/pulls/1/merge",
    "-f",
    "merge_method=merge",
    "-f",
    `sha=${commit}`,
  ]);
}

function localBranch(scene: GithubScene): string {
  return git(scene.repository, ["branch", "--list", "cloving/ticket-one"]);
}

await test("CLV-067 the GitHub worker ends an active wait at close with no result and no report, and a new worker with the same journal continues it after its scan and reports the review with the kept intent", () =>
  withGithub(async (scene) => {
    const { commit, ...given } = await interruptedWait(scene);
    const folder = folderOf(scene, "operation-wait");
    assert.deepEqual(
      [
        existsSync(join(folder, "result.json")),
        scene.reports.some((item) => item.operationId === "operation-wait"),
      ],
      [false, false],
    );
    const started: unknown = JSON.parse(
      readFileSync(join(folder, "started.json"), "utf8"),
    );
    assert.deepEqual(
      { ...Object(started), startedAt: undefined },
      {
        operationId: "operation-wait",
        method: "wait-review",
        target: "ticket/one",
        startedAt: undefined,
        ...kept,
        payloadText: JSON.stringify({ number: 1, commit }),
      },
    );
    const second = scene.worker({
      timing: slow,
      document: () => Promise.resolve(undefined),
    });
    const receipt = journalKey("operation-wait");
    assert.deepEqual(
      await second.reconcile(given, signal),
      accepted("operation-wait"),
    );
    scene.plan({ scores: [5] });
    await until(() =>
      scene.reports.some((item) => item.operationId === "operation-wait"),
    );
    const report = scene.reports.find(
      (item) => item.operationId === "operation-wait",
    );
    assert.deepEqual(
      { ...report, result: undefined },
      {
        ...kept,
        commandId: `github:${receipt}`,
        operationId: "operation-wait",
        worker: "github",
        outcome: "completed",
        result: undefined,
      },
    );
    assert.deepEqual(
      [resultOf(report?.result)["score"], resultOf(report?.result)["commit"]],
      [5, commit],
    );
  }));

await test("CLV-067 a reconcile call that comes before the scan waits for the scan and gives accepted for the continued operation, and a worker with no scan starts no operation", () =>
  withGithub(async (scene) => {
    const given = await interruptedWait(scene);
    const calls = scene.state().calls.length;
    const reported = scene.reports.length;
    scene.unscanned({ timing: slow });
    await delay(100);
    assert.deepEqual(
      [scene.state().calls.length, scene.reports.length],
      [calls, reported],
    );
    const later = scene.unscanned({ timing: slow });
    const reconciling = later.reconcile(given, signal);
    await later.scan();
    assert.deepEqual(await reconciling, accepted("operation-wait"));
    await until(() => scene.state().calls.length > calls);
  }));

await test("CLV-067 the scan makes no gh call for a kept merge of a cancelled run, and reports it as stopped with the kept intent", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    const first = scene.worker({
      check: [process.execPath, "-e", "setTimeout(() => {}, 60_000)"],
      document: () => Promise.resolve(JSON.stringify({ number: 1, commit })),
    });
    const given = githubIntent({
      ...kept,
      operationId: "operation-merge",
      method: "merge",
    });
    await first.deliver(given, signal);
    await until(() =>
      scene.state().calls.some((call) => call.join(" ").endsWith("pulls/1")),
    );
    await first.close();
    const calls = scene.state().calls.length;
    scene.worker({ runStatus: () => Promise.resolve("cancelled") });
    await until(() =>
      scene.reports.some((item) => item.operationId === "operation-merge"),
    );
    const report = scene.reports.find(
      (item) => item.operationId === "operation-merge",
    );
    assert.deepEqual(
      [report?.outcome, report?.runId, report?.leaseGeneration],
      ["stopped", kept.runId, kept.leaseGeneration],
    );
    assert.deepEqual(
      [scene.state().calls.length, scene.state().prs[0]?.["state"]],
      [calls, "OPEN"],
    );
    assert.ok(
      existsSync(join(folderOf(scene, "operation-merge"), "result.json")),
    );
  }));

await test("CLV-067 the scan reports stopped for a kept operation that does not run in the service, gives a start file of the old form the result github-call-interrupted, and ends the waits when a read of the service fails", () =>
  withGithub(async (scene) => {
    const value = (operationId: string): unknown => ({
      operationId,
      method: "merge",
      target: "ticket/one",
      startedAt: new Date().toISOString(),
      ...kept,
      payloadText: JSON.stringify({ number: 1, commit: "1".repeat(40) }),
    });
    for (const operationId of ["operation-done", "operation-unread"])
      leftBehind(scene, { operationId, value: value(operationId) });
    leftBehind(scene, { operationId: "operation-old", value: {} });
    const worker = scene.worker({
      operationStatus: (operationId) =>
        operationId === "operation-done"
          ? Promise.resolve("completed")
          : Promise.reject(new Error("service-unavailable")),
    });
    const outcome = async (operationId: string): Promise<unknown> =>
      worker.reconcile(githubIntent({ operationId }), signal);
    assert.deepEqual(await outcome("operation-done"), {
      kind: "stopped",
      receipt: journalKey("operation-done"),
      worker: "github",
    });
    assert.ok(
      existsSync(join(folderOf(scene, "operation-old"), "result.json")),
    );
    for (const operationId of ["operation-unread", "operation-old"])
      assert.deepEqual(await outcome(operationId), {
        kind: "failed",
        receipt: journalKey(operationId),
        worker: "github",
        reason: "github-call-interrupted",
      });
    assert.deepEqual(
      [scene.reports.map((item) => item.outcome), scene.state().calls],
      [["stopped"], []],
    );
  }));

await test("CLV-067 a merge of a pull request that is merged already runs no check and makes no merge call, gives the merge commit of the pull request, and removes the work tree and the local branch", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    mergedBefore(scene, commit);
    const failing = scene.worker({
      check: [process.execPath, "-e", "process.exitCode = 4"],
    });
    const report = await scene.perform(failing, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.deepEqual(
      [report.outcome, resultOf(report.result)],
      ["completed", { number: 1, merged: "f".repeat(40) }],
    );
    assert.equal(
      scene.state().calls.filter((call) => call.includes("PUT")).length,
      1,
    );
    assert.deepEqual(
      [existsSync(treeOf(scene)), localBranch(scene)],
      [false, ""],
    );
  }));

await test("CLV-067 a merge of a pull request that is merged already completes with its merge commit when the work tree and the local branch are removed already", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    mergedBefore(scene, commit);
    git(scene.repository, ["worktree", "remove", "--force", treeOf(scene)]);
    git(scene.repository, ["branch", "-D", "cloving/ticket-one"]);
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.deepEqual(
      [report.outcome, resultOf(report.result)],
      ["completed", { number: 1, merged: "f".repeat(40) }],
    );
  }));
