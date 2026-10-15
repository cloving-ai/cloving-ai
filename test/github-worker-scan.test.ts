import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerReport } from "../src/daemon/operation-journal.ts";
import { journalKey, resultOf, until } from "./claude-worker-fixture.ts";
import {
  githubIntent,
  opened,
  treeOf,
  withGithub,
  type GithubScene,
} from "./github-worker-fixture.ts";

const signal = new AbortController().signal;
const kept = {
  runId: "run-7",
  inputDigest: `sha256:${"b".repeat(64)}`,
  leaseGeneration: 3,
};

function saved(
  scene: GithubScene,
  operation: {
    readonly operationId: string;
    readonly method: string;
    readonly payload: unknown;
    readonly result?: unknown;
  },
): void {
  const { operationId, method, payload, result } = operation;
  const folder = join(scene.journal, journalKey(operationId));
  mkdirSync(folder, { recursive: true });
  const started = {
    operationId,
    method,
    target: "ticket/one",
    startedAt: new Date().toISOString(),
    ...kept,
    payloadText: JSON.stringify(payload),
  };
  writeFileSync(join(folder, "started.json"), JSON.stringify(started));
  if (result !== undefined)
    writeFileSync(join(folder, "result.json"), JSON.stringify(result));
}

function statusOf(
  statuses: Readonly<Record<string, string>>,
): (operationId: string) => Promise<string | undefined> {
  return (operationId) => Promise.resolve(statuses[operationId]);
}

async function reportFor(
  scene: GithubScene,
  operationId: string,
): Promise<WorkerReport | undefined> {
  await until(() =>
    scene.reports.some((item) => item.operationId === operationId),
  );
  return scene.reports.find((item) => item.operationId === operationId);
}

await test("CLV-067 the scan sends again the saved result of an operation that the service shows as running with no gh call, and sends nothing for a settled operation", () =>
  withGithub(async (scene) => {
    const result = JSON.stringify({ number: 1, url: "u", commit: "c" });
    for (const operationId of ["operation-saved", "operation-settled"])
      saved(scene, {
        operationId,
        method: "open-pr",
        payload: { title: "t", body: "b" },
        result: { outcome: "completed", result, endedAt: "2026-10-14" },
      });
    const worker = scene.worker({
      operationStatus: statusOf({
        "operation-saved": "running",
        "operation-settled": "completed",
      }),
    });
    const receipt = journalKey("operation-saved");
    assert.deepEqual(
      await worker.reconcile(
        githubIntent({ operationId: "operation-saved" }),
        signal,
      ),
      { kind: "completed", receipt, worker: "github", result },
    );
    assert.deepEqual(scene.reports, [
      {
        ...kept,
        commandId: `github:${receipt}`,
        operationId: "operation-saved",
        worker: "github",
        outcome: "completed",
        result,
      },
    ]);
    assert.deepEqual(scene.state().calls, []);
  }));

await test("CLV-067 the scan continues a kept merge that the service shows as recovering, and reports the merge that GitHub made before the stop", () =>
  withGithub(async (scene) => {
    const commit = await opened(scene, scene.worker());
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
    saved(scene, {
      operationId: "operation-merge",
      method: "merge",
      payload: { number: 1, commit },
    });
    scene.worker({
      operationStatus: statusOf({ "operation-merge": "recovering" }),
    });
    const report = await reportFor(scene, "operation-merge");
    assert.deepEqual(
      [report?.outcome, resultOf(report?.result), report?.leaseGeneration],
      [
        "completed",
        { number: 1, commit, updated: commit, merged: "f".repeat(40) },
        kept.leaseGeneration,
      ],
    );
    assert.deepEqual(
      [
        scene.state().calls.filter((call) => call.includes("PUT")).length,
        existsSync(treeOf(scene)),
      ],
      [1, false],
    );
  }));

for (const status of ["blocked", "dispatch-pending"])
  await test(`CLV-067 the scan continues a kept wait that the service shows as ${status}, and reports the review`, () =>
    withGithub(async (scene) => {
      const commit = await opened(scene, scene.worker());
      scene.plan({ scores: [5] });
      saved(scene, {
        operationId: "operation-wait",
        method: "wait-review",
        payload: { number: 1, commit },
      });
      scene.worker({ operationStatus: statusOf({ "operation-wait": status }) });
      const report = await reportFor(scene, "operation-wait");
      assert.deepEqual(
        [report?.outcome, resultOf(report?.result)["score"]],
        ["completed", 5],
      );
    }));
