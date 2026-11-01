import assert from "node:assert/strict";
import { test } from "node:test";
import { watchModel, type GithubRecords } from "../src/cli/watch-model.ts";
import { observedBoard } from "../src/cli/watch-pr-board.ts";
import { boardModel, boardRun } from "./watch-board-fixture.ts";
import { fields } from "./service-fixture.ts";
import {
  blockedMergeModel,
  mergeCard,
  mergedJournal,
  mergeJournal,
  mergePull,
  mergeRepository,
} from "./watch-merge-fixture.ts";

function proofScenario(githubRecords: readonly GithubRecords[]) {
  const issueIdentity = { owner: "fixture", repository: "demo", number: 7 };
  return boardModel(
    [
      boardRun("A", {
        state: "completed",
        outcome: "blocked",
        issueIdentity,
        events: [{ type: "run.completed", recordedAt: "2026-10-14T10:00:00Z" }],
      }),
      boardRun("B", {
        state: "completed",
        outcome: "handoff_requested",
        issueIdentity,
        events: [{ type: "run.created", recordedAt: "2026-10-14T10:01:00Z" }],
      }),
    ],
    { repository: mergeRepository, githubRecords },
  );
}

await test("CLV-129 a successful merge after an earlier repair can prove own or successor completion", () => {
  for (const runId of ["A", "B"]) {
    const repaired = mergeJournal(runId, {
      method: "merge",
      report: { reason: "check-failed" },
    });
    const model = proofScenario([repaired, ...mergedJournal(runId, 2)]);
    assert.deepEqual(
      mergeCard(model)?.completionMark,
      runId === "A"
        ? { text: "PR merged · #7", laterRunId: null }
        : { text: "Ticket completed by later run", laterRunId: "B" },
    );
  }
});

await test("CLV-129 own proof precedes successor proof and both prevent an observation", () => {
  for (const records of [
    [...mergedJournal("A"), ...mergedJournal("B")],
    mergedJournal("B"),
  ]) {
    const model = proofScenario(records);
    const shown = observedBoard(model, {
      observe: () => assert.fail("Local completion prevents reads"),
      close: () => undefined,
    });
    assert.deepEqual(
      mergeCard(shown)?.completionMark,
      records.length === 4
        ? { text: "PR merged · #7", laterRunId: null }
        : { text: "Ticket completed by later run", laterRunId: "B" },
    );
    assert.equal(
      shown.runs.find((run) => run.runId === "A")?.outcome,
      "blocked",
    );
  }
});

await test("CLV-129 local proof rejects malformed or conflicting journal attribution and completion envelopes", () => {
  const opened = mergedJournal("A")[0];
  const merged = mergedJournal("A")[1];
  assert.ok(opened && merged);
  const operation = [
    "cloving-operation",
    1,
    "A",
    "pull-request",
    "github-merge",
    null,
    null,
  ];
  const invalidOperations = [
    ["foreign-operation", ...operation.slice(1)],
    [operation[0], "not-a-round", ...operation.slice(2)],
    [operation[0], -1, ...operation.slice(2)],
    [...operation.slice(0, 3), "other-phase", ...operation.slice(4)],
    [...operation.slice(0, 4), "github-label", null, null],
    operation.slice(0, 5),
  ];
  const invalidMerges = [
    ...invalidOperations.map((value) => ({
      ...merged,
      started: {
        ...fields(merged.started),
        operationId: JSON.stringify(value),
      },
    })),
    { ...merged, started: { ...fields(merged.started), runId: "B" } },
    { ...merged, result: { ...fields(merged.result), reason: "check-failed" } },
  ];
  for (const record of invalidMerges)
    assert.equal(
      mergeCard(blockedMergeModel([opened, record]))?.completionMark?.text,
      "Needs attention",
    );
  const conflictingOpen = {
    ...opened,
    started: { ...fields(opened.started), runId: "B" },
  };
  assert.equal(
    mergeCard(blockedMergeModel([conflictingOpen, merged]))?.completionMark
      ?.text,
    "Needs attention",
  );
});

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

await test("CLV-065 the watch model gives a pull request run its steps, its pull request, its completed reviews in the order of the rounds and its merge commit from the records of the GitHub journal", () => {
  const model = watchModel({
    home: "/fixture/home",
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
      ["run-3", null, [], null, 5],
    ],
  );
});

await test("CLV-129 a successful matching local merge proves completion without a remote read or outcome change", () => {
  const model = blockedMergeModel(mergedJournal("A"));
  const before = JSON.stringify(model);
  const shown = observedBoard(model, {
    observe: () => {
      assert.fail("Local merge proof must prevent PR reads");
    },
    close: () => undefined,
  });
  assert.deepEqual(mergeCard(shown)?.completionMark, {
    text: "PR merged · #7",
    laterRunId: null,
  });
  assert.equal(shown.runs[0]?.outcome, "blocked");
  assert.equal(shown.runs[0].mergeCommit, "fixture-commit");
  assert.equal(JSON.stringify(model), before);
});

await test("CLV-129 failed, stopped, malformed, conflicting and repair reports never prove local completion", () => {
  const valid = { number: 7, merged: "fixture-commit" };
  const reports = [
    null,
    [],
    "bad",
    {},
    { merged: "commit" },
    ...[0, -1, 8, 7.5, Number.MAX_SAFE_INTEGER + 1, "7"].map((number) => ({
      ...valid,
      number,
    })),
    ...[null, "", " \n\t", 7].map((merged) => ({ ...valid, merged })),
    { ...valid, reason: "check-failed" },
    { ...valid, reason: "" },
  ];
  const records = [
    ...reports.map((report) => [
      mergeJournal("A", { method: "merge", report }),
    ]),
    ...["failed", "stopped"].map((outcome) => [
      mergeJournal("A", { method: "merge", report: valid, outcome }),
    ]),
    [mergeJournal("B", { method: "merge", report: valid })],
    [
      mergeJournal("A", { method: "merge", report: valid }),
      mergeJournal("A", { method: "merge", report: { ...valid, number: 8 } }),
    ],
  ];
  for (const results of records) {
    const model = blockedMergeModel([
      mergeJournal("A", { method: "open-pr", report: mergePull }),
      ...results,
    ]);
    assert.deepEqual(mergeCard(model)?.completionMark, {
      text: "Needs attention",
      laterRunId: null,
    });
  }
  for (const repository of [
    null,
    { host: "other.example", owner: "fixture", repository: "demo" },
  ])
    assert.equal(
      mergeCard(blockedMergeModel(mergedJournal("A"), { repository }))
        ?.completionMark?.text,
      "Needs attention",
    );
});

await test("CLV-129 recorded PR conflicts and different successful merge commits prevent proof", () => {
  const opened = mergeJournal("A", { method: "open-pr", report: mergePull });
  const merged = mergeJournal("A", {
    method: "merge",
    report: { number: 7, merged: "commit" },
  });
  for (const report of [
    { ...mergePull, number: "7" },
    { ...mergePull, number: 0 },
    ...[
      "other.example/fixture/demo",
      "github.example/other/demo",
      "github.example/fixture/other",
    ].map((repository) => ({ number: 7, url: `https://${repository}/pull/7` })),
    { ...mergePull, url: `${mergePull.url}?private=fixture` },
  ]) {
    const badOpen = mergeJournal("A", { method: "open-pr", report });
    for (const records of [
      [badOpen, merged],
      [opened, badOpen, merged],
    ])
      assert.equal(
        mergeCard(blockedMergeModel(records))?.completionMark?.text,
        "Needs attention",
      );
  }
  const conflict = mergeJournal("A", {
    method: "merge",
    report: { number: 7, merged: "other-commit" },
  });
  assert.equal(
    mergeCard(blockedMergeModel([opened, merged, conflict]))?.completionMark
      ?.text,
    "Needs attention",
  );
});
