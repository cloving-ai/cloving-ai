import assert from "node:assert/strict";
import { test } from "node:test";
import { watchModel, type GithubRecords } from "../src/cli/watch-model.ts";

const pullUrl = "https://github.com/cloving-ai/cloving-ai/pull/61";

function github(
  scope: { readonly runId: string; readonly round: number },
  call: { readonly method: string; readonly result: unknown },
): GithubRecords {
  const { runId, round } = scope;
  const operation = `github-${call.method}`;
  const operationId = JSON.stringify([
    "cloving-operation",
    round,
    runId,
    "pull-request",
    operation,
    null,
    null,
  ]);
  return {
    started: {
      operationId,
      method: call.method,
      target: "clv-065-1e28b544",
      startedAt: "2026-10-14T10:00:00.000Z",
    },
    result: call.result,
  };
}

function completed(value: unknown): Record<string, unknown> {
  return {
    outcome: "completed",
    result: JSON.stringify(value),
    endedAt: "2026-10-14T10:05:00.000Z",
  };
}

function reviewed(commit: string, score: number): Record<string, unknown> {
  return completed({
    number: 61,
    commit,
    score,
    summary: "A summary.",
    findings: [],
  });
}

function run(
  runId: string,
  shown: { readonly workflowId: string; readonly minute: number },
): Record<string, unknown> {
  return {
    status: { runId, workflowId: shown.workflowId, state: "running" },
    events: [
      {
        sequence: 1,
        recordedAt: `2026-10-14T10:0${String(shown.minute)}:00Z`,
        type: "run.created",
        payload: {},
      },
    ],
  };
}

const first = { runId: "run-1", round: 1 };
const second = { runId: "run-1", round: 2 };
const third = { runId: "run-1", round: 3 };
const other = { runId: "run-2", round: 1 };

const records = [
  github(first, { method: "prepare", result: completed({}) }),
  github(second, { method: "wait-review", result: reviewed("bbb", 5) }),
  github(first, {
    method: "open-pr",
    result: completed({ number: 61, url: pullUrl, commit: "aaa" }),
  }),
  github(first, { method: "wait-review", result: reviewed("aaa", 4) }),
  github(third, { method: "wait-review", result: null }),
  github(third, {
    method: "wait-review",
    result: { outcome: "failed", reason: "github-call-failed", endedAt: "" },
  }),
  github(third, {
    method: "wait-review",
    result: { outcome: "stopped", endedAt: "" },
  }),
  github(second, {
    method: "merge",
    result: completed({ number: 61, merged: "ccc" }),
  }),
  github(other, {
    method: "open-pr",
    result: completed({ number: 62, url: `${pullUrl}2`, commit: "ddd" }),
  }),
  github(other, { method: "wait-review", result: reviewed("ddd", 3) }),
  github(
    { runId: "run-3", round: 1 },
    {
      method: "open-pr",
      result: completed({ number: 63, url: "javascript:alert(1)" }),
    },
  ),
  { started: { operationId: "not a list" }, result: null },
];

await test("CLV-065 the watch model gives a develop-issue run its steps, its pull request, its completed reviews in the order of the rounds and its merge commit from the records of the GitHub journal", () => {
  const model = watchModel({
    host: "/host",
    client: "cloving",
    updatedAt: "2026-10-14T10:10:00.000Z",
    service: "up",
    workflows: ["develop-issue", "develop-ticket", "develop-prompt"],
    runs: [
      run("run-1", { workflowId: "develop-issue", minute: 3 }),
      run("run-4", { workflowId: "develop-ticket", minute: 2 }),
      run("run-3", { workflowId: "develop-issue", minute: 1 }),
    ],
    decisions: [],
    turns: [],
    githubRecords: records,
  });
  assert.deepEqual(
    model.runs.map((item) => [
      item.runId,
      item.pullRequest,
      item.reviews,
      item.mergeCommit,
      item.phases.length,
    ]),
    [
      [
        "run-1",
        { number: 61, url: pullUrl },
        [
          { round: 1, commit: "aaa", score: 4 },
          { round: 2, commit: "bbb", score: 5 },
        ],
        "ccc",
        8,
      ],
      ["run-4", null, [], null, 5],
      ["run-3", null, [], null, 8],
    ],
  );
});
