import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { Card } from "../src/cli/watch-board-view.ts";
import { rendered } from "./watch-dom.ts";
import { record } from "../src/protocol.ts";
import {
  blockedMergeModel,
  mergeCard,
  mergedJournal,
  mergeJournal,
  mergePull,
  mergeRepository,
} from "./watch-merge-fixture.ts";
import type { GithubRecords } from "../src/cli/watch-model.ts";
import {
  boardEvent,
  boardModel,
  boardRun,
  sampleStages,
  stageEvent,
} from "./watch-board-fixture.ts";
import { observedBoard } from "../src/cli/watch-pr-board.ts";

await test("CLV-263 blocked develop pull requests receive observations", () => {
  const model = workflowModel("develop", {
    records: [mergeJournal("A", { method: "open-pr", report: mergePull })],
  });
  const calls: unknown[] = [];
  const observed = observedBoard(model, {
    observe: (pull) => {
      calls.push(pull);
      return { status: "pending" };
    },
    close: () => undefined,
  });
  assert.deepEqual(mergeCard(model)?.completionMark, {
    text: "Needs attention",
    laterRunId: null,
  });
  assert.deepEqual(calls, [mergePull]);
  assert.deepEqual(mergeCard(observed)?.pullRequestObservation, {
    status: "pending",
  });
});

await test("CLV-263 a declared develop run with a pull request shows its phases and board card", () => {
  const model = boardModel(
    [
      boardRun("A", {
        workflowId: "develop",
        events: [boardEvent("github-wait-review")],
      }),
    ],
    {
      workflows: ["develop"],
      githubRecords: [
        mergeJournal("A", {
          method: "open-pr",
          report: {
            number: 12,
            url: "https://github.example/fixture/demo/pull/12",
          },
        }),
      ],
    },
  );
  assert.equal(
    model.runs[0]?.phases.find((phase) => phase.name === "Code review")?.state,
    "active",
  );
  const card = model.workflows[0]?.columns.find(
    (column) => column.name === "Code review",
  )?.cards[0];
  assert.equal(card?.pullRequestNumber, 12);
  assert.equal(card.round, 1);
});

function workflowModel(
  workflowId: string,
  input: {
    readonly records: readonly GithubRecords[];
    readonly outcome?: string;
  },
) {
  return blockedMergeModel(input.records, {
    workflows: [workflowId],
    runs: [
      {
        status: {
          runId: "A",
          workflowId,
          state: "completed",
          outcome: { kind: input.outcome ?? "blocked" },
          latestAt: "2026-10-14T12:00:00Z",
        },
      },
    ],
  });
}

for (const workflowId of ["develop", "custom-workflow"]) {
  await test(`CLV-227 ${workflowId} shows its pull request, review and merge proof on the board and in JSON`, () => {
    const records = [
      ...mergedJournal("A"),
      mergeJournal("A", {
        method: "wait-review",
        report: { number: 7, commit: "fixture-commit", score: 5 },
      }),
      ...mergedJournal("other-run"),
    ];
    const model = workflowModel(workflowId, { records });
    const run = model.runs[0];
    assert.equal(run?.pullRequest?.number, 7);
    assert.equal(run.reviews[0]?.score, 5);
    assert.deepEqual(run.mergeProof, { ...mergeRepository, number: 7 });
    const card = mergeCard(model);
    assert.ok(card);
    assert.equal(card.pullRequestNumber, 7);
    assert.equal(card.greptileScore, 5);
    const html = rendered(
      component(Card, { card, workflowId, now: model.updatedAt }),
    );
    assert.match(html, /review-pill">#7</);
    assert.match(html, /review-pill">5\/5</);
    assert.match(html, /PR merged · #7/);
    const data = record(JSON.parse(JSON.stringify(model)));
    const runs = data?.["runs"];
    assert.ok(Array.isArray(runs));
    assert.deepEqual(record(runs[0])?.["mergeProof"], run.mergeProof);
  });
}

await test("CLV-227 foreign repositories and runs cannot supply a workflow pull request or merge proof", () => {
  const foreign = mergeJournal("A", {
    method: "open-pr",
    report: { ...mergePull, url: "https://github.example/other/repo/pull/7" },
  });
  const spoofed = {
    ...foreign,
    started: { ...record(foreign.started), runId: "another-run" },
    result: { outcome: "completed", result: JSON.stringify(mergePull) },
  };
  for (const records of [[foreign], mergedJournal("another-run"), [spoofed]]) {
    const model = workflowModel("develop", { records });
    assert.equal(model.runs[0]?.pullRequest, null);
    assert.equal(model.runs[0].mergeProof, undefined);
    assert.equal(mergeCard(model)?.pullRequestNumber, null);
  }
});

await test("CLV-227 mergeWhenGreen operation identities prove a completed develop merge", () => {
  const records = mergedJournal("A").map((item) => {
    const started = record(item.started);
    return started?.["method"] === "merge"
      ? {
          ...item,
          started: {
            ...started,
            operationId: JSON.stringify([
              "cloving-operation",
              1,
              "A",
              "merge",
              "merge",
              null,
              "7:fixture-commit",
            ]),
          },
        }
      : item;
  });
  const model = workflowModel("develop", {
    records,
    outcome: "handoff_requested",
  });
  assert.deepEqual(model.runs[0]?.mergeProof, {
    ...mergeRepository,
    number: 7,
  });
  assert.deepEqual(mergeCard(model)?.completionMark, {
    text: "PR merged · #7",
    laterRunId: null,
  });
});

await test("CLV-227 develop reviews sharing round one follow their start time across repair commits", () => {
  const reviews = [
    { score: 5, commit: "repaired", startedAt: "2026-10-14T12:01:00Z" },
    { score: 2, commit: "original", startedAt: "2026-10-14T12:00:00Z" },
  ].map(({ startedAt, ...report }) => {
    const review = mergeJournal("A", {
      method: "wait-review",
      report: { ...report, number: 7 },
    });
    return {
      ...review,
      started: {
        ...record(review.started),
        startedAt,
        operationId: JSON.stringify([
          "cloving-operation",
          1,
          "A",
          "review",
          "greptile",
          null,
          report.commit,
        ]),
      },
    };
  });
  const model = workflowModel("develop", {
    records: [...mergedJournal("A"), ...reviews],
  });
  assert.deepEqual(
    model.runs[0]?.reviews.map((review) => review.score),
    [2, 5],
  );
  assert.equal(mergeCard(model)?.greptileScore, 5);
});

await test("CLV-263 a former bundled ID without a pull request uses declared phases", () => {
  const events = [stageEvent(1, { operation: "write-draft" })];
  const model = boardModel(
    [boardRun("project", { workflowId: "develop-issue", events })],
    {
      workflows: ["develop-issue"],
      workflowStages: { "develop-issue": sampleStages },
    },
  );
  assert.deepEqual(
    model.runs[0]?.phases.map((phase) => phase.name),
    ["Admitted", "Started", "Draft", "Review", "Completed"],
  );
  assert.equal(model.runs[0].phases[2]?.state, "active");
  assert.equal(model.runs[0].pullRequest, null);
  const card = model.workflows[0]?.columns[0]?.cards[0];
  assert.equal(card?.pullRequestNumber, null);
  assert.equal(card.round, null);
});

await test("CLV-263 a workflow keeps both pull request and ordinary review cards", () => {
  const model = boardModel(
    [
      boardRun("A", {
        workflowId: "develop",
        events: [boardEvent("github-wait-review")],
      }),
      boardRun("B", { workflowId: "develop", events: [boardEvent("review")] }),
    ],
    {
      workflows: ["develop"],
      githubRecords: [
        mergeJournal("A", { method: "open-pr", report: mergePull }),
      ],
    },
  );
  assert.deepEqual(
    model.workflows[0]?.columns.slice(-2).map((column) => column.name),
    ["Done", "Stopped"],
  );
  assert.deepEqual(
    model.workflows[0].columns
      .flatMap((column) => column.cards)
      .map((card) => card.runId)
      .sort(),
    ["A", "B"],
  );
});

await test("CLV-263 declared develop public review and merge steps select pull request phases", () => {
  for (const [phase, operation, expected] of [
    ["review", "greptile", "Code review"],
    ["merge", "merge", "Merge"],
  ] as const) {
    const event = {
      sequence: 2,
      type: "effect.requested",
      recordedAt: "2026-10-14T12:00:00Z",
      payload: {
        operationId: JSON.stringify([
          "cloving-operation",
          1,
          "A",
          phase,
          operation,
          null,
          "fixture-commit",
        ]),
      },
    };
    const model = boardModel(
      [
        boardRun("A", {
          workflowId: "develop",
          events: [
            boardEvent("claude-turn", { round: 2, at: "2026-10-14T11:00:00Z" }),
            event,
          ],
        }),
      ],
      {
        workflows: ["develop"],
        githubRecords: [
          mergeJournal("A", { method: "open-pr", report: mergePull }),
        ],
      },
    );
    assert.equal(model.runs[0]?.currentStep.name, expected);
    assert.equal(
      model.runs[0].phases.find((item) => item.name.startsWith(expected))
        ?.state,
      "active",
    );
  }
});
