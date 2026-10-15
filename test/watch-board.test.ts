import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeBoardModel,
  boardEvent,
  boardModel,
  boardRun,
  boardTime,
  workflowIds,
} from "./watch-board-fixture.ts";

await test("CLV-079 an active run with only a creation event has no step start time", () => {
  const model = boardModel([
    boardRun("created", {
      events: [{ type: "run.created", recordedAt: boardTime }],
    }),
  ]);
  assert.deepEqual(model.runs[0]?.currentStep, {
    name: "Work tree",
    startedAt: null,
  });
});

await test("CLV-077 boards follow registration order and place each active run at its newest step start", () => {
  const model = activeBoardModel();
  assert.deepEqual(
    model.workflows.map((board) => board.workflowId),
    workflowIds,
  );
  const [issue, ticket, prompt] = model.workflows;
  assert.ok(issue);
  assert.ok(ticket);
  assert.ok(prompt);
  assert.deepEqual(
    issue.columns.map((column) => column.name),
    [
      "Work tree",
      "Claude turn",
      "Pull request",
      "Greptile review",
      "Merge",
      "Done",
      "Stopped",
    ],
  );
  assert.deepEqual(
    ticket.columns.map((column) => column.name),
    ["Claude turn", "Your review", "Done", "Stopped"],
  );
  assert.deepEqual(
    prompt.columns.map((column) => column.name),
    ticket.columns.map((column) => column.name),
  );
});

await test("CLV-077 active cards identify the newest step and Claude round", () => {
  const [issue, ticket] = activeBoardModel().workflows;
  assert.ok(issue);
  assert.ok(ticket);
  assert.deepEqual(
    issue.columns.map((column) => column.cards.map((card) => card.runId)),
    [
      ["not-started", "github-prepare"],
      ["round-2", "claude-turn"],
      ["github-open-pr"],
      ["github-wait-review"],
      ["github-merge"],
      [],
      [],
    ],
  );
  assert.deepEqual(
    ticket.columns[1]?.cards.map((card) => card.runId),
    ["ticket"],
  );
  assert.deepEqual(issue.columns[1]?.cards[0], {
    runId: "round-2",
    title: "Title of round-2",
    claudeCostUsd: 1.25,
    currentStep: { name: "Claude turn", startedAt: "2026-10-14T11:00:00Z" },
    endedAt: null,
    decisionWaiting: false,
    round: 2,
    greptileScore: null,
    pullRequestNumber: null,
  });
  assert.equal(issue.columns[0]?.cards[0]?.round, 1);
  assert.equal(issue.latestAt, boardTime);
});

await test("CLV-077 terminal cards use outcomes, include only the last seven days, and cap each column at twenty newest runs", () => {
  const completed = Array.from({ length: 22 }, (_, index) =>
    boardRun(`done-${String(index)}`, {
      state: "completed",
      outcome: "handoff_requested",
      latestAt: `2026-10-13T${String(index).padStart(2, "0")}:00:00Z`,
    }),
  );
  const stopped = Array.from({ length: 22 }, (_, index) =>
    boardRun(`stop-${String(index)}`, {
      state: "completed",
      outcome: "blocked",
      latestAt: `2026-10-13T${String(index).padStart(2, "0")}:00:00Z`,
    }),
  );
  const [board] = boardModel([
    ...completed,
    ...stopped,
    boardRun("legacy", { state: "completed" }),
    boardRun("old", {
      state: "completed",
      outcome: "handoff_requested",
      latestAt: "2026-10-07T11:59:59.999Z",
    }),
    boardRun("future", { state: "failed", latestAt: "2026-10-15T00:00:00Z" }),
  ]).workflows;
  assert.ok(board);
  const done = board.columns[5];
  const stoppedColumn = board.columns[6];
  assert.ok(done);
  assert.ok(stoppedColumn);
  assert.deepEqual(
    done.cards.map((card) => card.runId),
    Array.from({ length: 20 }, (_, index) => `done-${String(21 - index)}`),
  );
  assert.deepEqual(
    stoppedColumn.cards.map((card) => card.runId),
    Array.from({ length: 20 }, (_, index) => `stop-${String(21 - index)}`),
  );
  assert.equal(done.cards[0]?.endedAt, "2026-10-13T21:00:00Z");
  assert.equal(done.cards[0].currentStep, null);
});

await test("CLV-077 failed and dropped runs are stopped and the seven-day boundary is inclusive", () => {
  const boundary = boardModel([
    boardRun("failed", { state: "failed" }),
    boardRun("dropped", { state: "cancelled" }),
    boardRun("boundary", {
      state: "completed",
      outcome: "handoff_requested",
      latestAt: "2026-10-07T12:00:00Z",
    }),
  ]).workflows[0];
  assert.ok(boundary);
  assert.deepEqual(
    boundary.columns[5]?.cards.map((card) => card.runId),
    ["boundary"],
  );
  assert.deepEqual(
    boundary.columns[6]?.cards.map((card) => card.runId).sort(),
    ["dropped", "failed"],
  );
});

await test("CLV-077 step cards put pending decisions first and then order each group by its oldest current start", () => {
  const inputs = [
    ["working-new", "running", "11:00:00"],
    ["waiting-new", "waiting_gate", "10:00:00"],
    ["working-old", "paused", "08:00:00"],
    ["waiting-old", "waiting_gate", "09:00:00"],
  ];
  const model = boardModel(
    inputs.map(([runId = "", state = "", time = ""]) =>
      boardRun(runId, {
        state,
        events: [boardEvent("claude-turn", { at: `2026-10-14T${time}Z` })],
      }),
    ),
    { decisions: [{ runId: "waiting-old" }, { runId: "waiting-new" }] },
  );
  const [issue, ticket] = model.workflows;
  assert.ok(issue);
  assert.ok(ticket);
  assert.deepEqual(
    issue.columns[1]?.cards.map((card) => [card.runId, card.decisionWaiting]),
    [
      ["waiting-old", true],
      ["waiting-new", true],
      ["working-old", false],
      ["working-new", false],
    ],
  );
  assert.equal(issue.activeCount, 4);
  assert.equal(issue.waitingCount, 2);
  assert.equal(ticket.activeCount, 0);
  assert.equal(ticket.waitingCount, 0);
  assert.equal(ticket.latestAt, null);
});

await test("CLV-077 start workflow prefers pending decisions and breaks ties by the newest event among all workflow runs", () => {
  const issue = boardRun("issue", {
    state: "waiting_gate",
    latestAt: "2026-10-14T09:00:00Z",
  });
  const ticket = boardRun("ticket", {
    workflowId: "develop-ticket",
    state: "waiting_gate",
    latestAt: "2026-10-14T10:00:00Z",
  });
  const prompt = boardRun("prompt", { workflowId: "develop-prompt" });
  assert.equal(
    boardModel([issue, ticket, prompt], {
      decisions: [{ runId: "issue" }, { runId: "ticket" }],
    }).startWorkflowId,
    "develop-ticket",
  );
  assert.equal(
    boardModel([issue, ticket, prompt], { decisions: [{ runId: "issue" }] })
      .startWorkflowId,
    "develop-issue",
  );
  assert.equal(
    boardModel([issue, ticket, prompt]).startWorkflowId,
    "develop-prompt",
  );
  assert.equal(boardModel([]).startWorkflowId, "develop-issue");
  assert.equal(boardModel([], { workflows: [] }).startWorkflowId, null);
  const summaries = [
    {
      runId: "old",
      workflowId: "develop-ticket",
      state: "completed",
      latestAt: "2020-01-01T00:00:00Z",
      pendingDecisions: [],
    },
  ];
  assert.equal(boardModel([], { summaries }).startWorkflowId, "develop-ticket");
});

await test("CLV-077 issue cards retain the last Claude round, Greptile score and pull request number", () => {
  const githubRecords = [
    [
      "open-pr",
      { number: 79, url: "https://github.com/example/project/pull/79" },
    ],
    ["wait-review", { score: 4, commit: "aaa" }],
  ].map(([method, report]) => ({
    started: {
      method,
      operationId: JSON.stringify([
        "cloving-operation",
        1,
        "issue",
        "pull-request",
      ]),
    },
    result: { outcome: "completed", result: JSON.stringify(report) },
  }));
  const model = boardModel(
    [
      boardRun("issue", {
        events: [
          boardEvent("claude-turn", { round: 2, at: "2026-10-14T10:00:00Z" }),
          boardEvent("github-wait-review", { round: 3 }),
        ],
      }),
    ],
    { githubRecords },
  );
  const card = model.workflows[0]?.columns[3]?.cards[0];
  assert.deepEqual(
    [card?.round, card?.greptileScore, card?.pullRequestNumber],
    [2, 4, 79],
  );
});
