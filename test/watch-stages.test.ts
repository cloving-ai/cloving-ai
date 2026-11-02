import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boardEvent,
  boardModel,
  boardRun,
  boardTime,
  sampleStages,
  reviewStageHistory,
  reviewStagePositions,
  stagedModel,
  reviewStages,
  stageEvent,
} from "./watch-board-fixture.ts";

await test("CLV-234 an exact gate ID precedes kind selection in either declaration order", () => {
  for (const stages of [
    [sampleStages[1], ...reviewStages],
    [...reviewStages, sampleStages[1]],
  ]) {
    for (const gateKind of ["approval", "question", undefined]) {
      const event = stageEvent(1, {
        gateId: "team-review",
        ...(gateKind === undefined ? {} : { gateKind }),
      });
      const model = stagedModel([event], {
        workflowStages: { sample: stages },
      });
      assert.deepEqual(model.runs[0]?.currentStep, {
        name: "Team review",
        startedAt: event.recordedAt,
      });
    }
  }
});

await test("CLV-234 gate IDs fall back by kind then Other with exact case and no prefix matching", () => {
  const stages = [
    { name: "fallback", label: "Fallback", gateKinds: ["approval"] },
    { name: "id", label: "Exact", gateIds: ["review"] },
  ] as const;
  for (const gateId of [
    undefined,
    null,
    1,
    {},
    ["review"],
    "REVIEW",
    "review-2",
    "unused",
  ]) {
    for (const gateKind of ["approval", "question"]) {
      const event = stageEvent(1, { gateId, gateKind });
      const model = stagedModel([event], {
        workflowStages: { sample: stages },
      });
      assert.deepEqual(model.runs[0]?.currentStep, {
        name: gateKind === "approval" ? "Fallback" : "Other",
        startedAt: event.recordedAt,
      });
    }
  }
  const effect = stageEvent(2, { operation: "write-draft" });
  const event = {
    ...effect,
    payload: { ...effect.payload, gateId: "review", gateKind: "approval" },
  };
  assert.equal(
    stagedModel([event], {
      workflowStages: { sample: [...sampleStages, stages[1]] },
    }).runs[0]?.currentStep.name,
    "Draft",
  );
});

await test("CLV-234 same-kind gate histories move exactly one card by committed sequence", () => {
  const stages = [...reviewStages, sampleStages[0]];
  const history = reviewStageHistory;
  for (const [index, [name, source]] of reviewStagePositions.entries()) {
    const events = history.slice(0, index + 1);
    for (const input of [
      events,
      events.toReversed(),
      [...events.slice(1), events[0]],
    ]) {
      const model = stagedModel(input, { workflowStages: { sample: stages } });
      const column = model.workflows[0]?.columns.find(
        (item) => item.name === name,
      );
      assert.equal(
        model.workflows[0]?.columns.flatMap((item) => item.cards).length,
        1,
      );
      assert.deepEqual(column?.cards[0]?.currentStep, {
        name,
        startedAt: history[source]?.recordedAt,
      });
    }
  }
});

await test("CLV-234 separate workflows reuse gate IDs without adding cards for unused selectors", () => {
  const events = [
    stageEvent(1, { gateId: "team-review", gateKind: "approval" }),
  ];
  const model = boardModel(
    [
      boardRun("a", { workflowId: "first", events }),
      boardRun("b", { workflowId: "second", events }),
    ],
    {
      workflows: ["first", "second"],
      workflowStages: { first: reviewStages, second: reviewStages },
    },
  );
  for (const workflow of model.workflows) {
    assert.equal(workflow.columns.flatMap((column) => column.cards).length, 1);
    assert.equal(
      workflow.columns[1]?.cards[0]?.currentStep?.name,
      "Team review",
    );
    assert.equal(workflow.columns[0]?.cards.length, 0);
    assert.equal(workflow.columns[2]?.cards.length, 0);
  }
});

await test("CLV-128 staged boards declare ordered columns with or without runs", () => {
  for (const runs of [[], [boardRun("sample-run", { workflowId: "sample" })]]) {
    const model = stagedModel([], { runs });
    assert.deepEqual(
      model.workflows[0]?.columns.map((column) => column.name),
      ["Draft", "Review", "Other", "Done", "Stopped"],
    );
    assert.equal(model.workflows[0].columns[2]?.cards.length, runs.length);
  }
  assert.deepEqual(stagedModel().runs[0]?.currentStep, {
    name: "Other",
    startedAt: null,
  });
});

await test("CLV-128 loops move one card by latest committed sequence despite reversed timestamps and shuffled input", () => {
  const history = [
    stageEvent(1, { operation: "write-draft" }),
    stageEvent(2, { gateKind: "approval" }),
    {
      sequence: 3,
      type: "gate.decided",
      recordedAt: boardTime,
      payload: { verdict: "denied" },
    },
    stageEvent(4, { operation: "write-draft" }),
    stageEvent(5, { operation: "unmatched" }),
  ];
  for (const [index, expected] of [
    "Draft",
    "Review",
    "Review",
    "Draft",
    "Other",
  ].entries()) {
    const events = history.slice(0, index + 1);
    for (const input of [events, events.toReversed()]) {
      const model = stagedModel(input);
      const cards = model.workflows.flatMap((board) =>
        board.columns.flatMap((column) => column.cards),
      );
      assert.equal(cards.length, 1);
      assert.equal(cards[0]?.runId, "sample-run");
      assert.deepEqual(cards[0].currentStep, {
        name: expected,
        startedAt: history[index === 2 ? 1 : index]?.recordedAt,
      });
    }
  }
});

await test("CLV-128 equal timestamps, reports, worker output and gate decisions cannot select a later stage", () => {
  const draft = {
    ...stageEvent(3, { operation: "write-draft" }),
    recordedAt: boardTime,
  };
  const gate = {
    ...stageEvent(2, { gateKind: "approval" }),
    recordedAt: boardTime,
  };
  const ignored = [
    "effect.reported",
    "gate.decided",
    "worker.output",
    "run.started",
  ].map((type, index) => ({
    sequence: 4 + index,
    type,
    recordedAt: boardTime,
    payload: {
      gateKind: "approval",
      operationId: JSON.stringify([
        "cloving-operation",
        1,
        "sample-run",
        "work",
        "unknown",
      ]),
    },
  }));
  for (const events of [
    [draft, ...ignored, gate],
    [gate, ...ignored, draft],
  ]) {
    assert.deepEqual(stagedModel(events).runs[0]?.currentStep, {
      name: "Draft",
      startedAt: boardTime,
    });
  }
});

await test("CLV-128 unmatched, untyped and malformed relevant events select Other with their own timestamp", () => {
  const draft = stageEvent(1, { operation: "write-draft" });
  const unknowns = [
    stageEvent(2, { gateKind: "question" }),
    stageEvent(2),
    stageEvent(2, { operation: "WRITE-DRAFT" }),
    ...[
      {},
      { operationId: "not-json" },
      { operationId: "{}" },
      { operationId: "[1,2,3,4,5]" },
    ].map((payload) => ({
      ...stageEvent(2, { operation: "unknown" }),
      payload,
    })),
  ];
  for (const event of unknowns) {
    assert.deepEqual(stagedModel([event, draft]).runs[0]?.currentStep, {
      name: "Other",
      startedAt: event.recordedAt,
    });
  }
  const model = stagedModel([stageEvent(1, { gateKind: "question" })], {
    workflowStages: {
      sample: [{ name: "q", label: "Ask", gateKinds: ["question"] }],
    },
  });
  assert.equal(model.runs[0]?.currentStep.name, "Ask");
});

await test("CLV-128 unstaged workflows without pull requests share generic columns and placement", () => {
  const events = [
    boardEvent("github-prepare"),
    boardEvent("github-merge", { at: "2026-10-14T11:00:00Z" }),
    stageEvent(3),
  ];
  const runs = [
    boardRun("issue", { events }),
    boardRun("ticket", { workflowId: "develop-ticket", events }),
  ];
  const supplied = boardModel(runs, { workflowStages: {} });
  assert.equal(
    supplied.runs.find((run) => run.runId === "issue")?.currentStep.name,
    "Your review",
  );
  assert.equal(
    supplied.runs.find((run) => run.runId === "ticket")?.currentStep.name,
    "Your review",
  );
});

await test("CLV-128 inherited object keys cannot supply stages for an unstaged workflow", () => {
  const model = boardModel([boardRun("plain", { workflowId: "constructor" })], {
    workflows: ["constructor"],
    workflowStages: {},
  });
  assert.deepEqual(
    model.workflows[0]?.columns.map((column) => column.name),
    ["Agent turn", "Your review", "Done", "Stopped"],
  );
});

await test("CLV-128 terminal rules override stages and retain inclusive bounds and per-column caps", () => {
  const runs = [
    ...Array.from({ length: 22 }, (_, index) =>
      boardRun(`done-${String(index)}`, {
        workflowId: "sample",
        state: "completed",
        outcome: "handoff_requested",
        latestAt: `2026-10-13T${String(index).padStart(2, "0")}:00:00Z`,
      }),
    ),
    ...Array.from({ length: 22 }, (_, index) =>
      boardRun(`stopped-${String(index)}`, {
        workflowId: "sample",
        state: "completed",
        outcome: "blocked",
        latestAt: `2026-10-13T${String(index).padStart(2, "0")}:00:00Z`,
      }),
    ),
  ];
  const capped = stagedModel([], {
    workflowStages: { sample: reviewStages },
    runs: runs.map((run) => ({
      ...run,
      events: [stageEvent(1, { gateId: "team-review" })],
    })),
  }).workflows[0];
  for (const [column, prefix] of [
    ["Done", "done"],
    ["Stopped", "stopped"],
  ] as const)
    assert.deepEqual(
      capped?.columns
        .find((item) => item.name === column)
        ?.cards.map((card) => card.runId),
      Array.from(
        { length: 20 },
        (_, index) => `${prefix}-${String(21 - index)}`,
      ),
    );
});

await test("CLV-128 terminal retention is inclusive, excludes future times and omits other outcomes", () => {
  const boundary = stagedModel([], {
    runs: [
      ...["failed", "cancelled"].map((state) =>
        boardRun(state, { workflowId: "sample", state }),
      ),
      boardRun("inclusive", {
        workflowId: "sample",
        state: "completed",
        outcome: "handoff_requested",
        latestAt: "2026-10-07T12:00:00.000Z",
      }),
      boardRun("old", {
        workflowId: "sample",
        state: "failed",
        latestAt: "2026-10-07T11:59:59.999Z",
      }),
      boardRun("future", {
        workflowId: "sample",
        state: "failed",
        latestAt: "2026-10-14T12:00:00.001Z",
      }),
      boardRun("omitted", {
        workflowId: "sample",
        state: "completed",
        outcome: "other",
      }),
    ].map((run) => ({
      ...run,
      events: [stageEvent(1, { gateId: "team-review" })],
    })),
    workflowStages: { sample: reviewStages },
  }).workflows[0];
  assert.deepEqual(
    boundary?.columns
      .find((column) => column.name === "Done")
      ?.cards.map((card) => card.runId),
    ["inclusive"],
  );
  assert.deepEqual(
    boundary.columns
      .find((column) => column.name === "Stopped")
      ?.cards.map((card) => card.runId),
    ["failed", "cancelled"],
  );
});

await test("CLV-128 active stages have no retention or card cap and prioritize pending decisions then oldest start", () => {
  const runs = Array.from({ length: 25 }, (_, index) =>
    boardRun(`active-${String(index)}`, {
      workflowId: "sample",
      state: "paused",
      latestAt: "2020-01-01T00:00:00Z",
      events: [
        {
          ...stageEvent(index + 1, { operation: "write-draft" }),
          recordedAt: `2020-01-01T00:00:${String(index).padStart(2, "0")}Z`,
        },
      ],
    }),
  );
  const model = stagedModel([], {
    runs,
    decisions: [{ runId: "active-24" }, { runId: "active-23" }],
  });
  const cards = model.workflows[0]?.columns[0]?.cards;
  assert.equal(cards?.length, 25);
  assert.deepEqual(
    cards.map((card) => card.runId),
    [
      "active-23",
      "active-24",
      ...Array.from({ length: 23 }, (_, index) => `active-${String(index)}`),
    ],
  );
});
