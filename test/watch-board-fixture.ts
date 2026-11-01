export const reviewStages = [
  { name: "your-review", label: "Your review", gateIds: ["your-review"] },
  { name: "team-review", label: "Team review", gateIds: ["team-review"] },
  {
    name: "ready-to-merge",
    label: "Ready to merge",
    gateIds: ["merge-review"],
  },
] as const;

export const invalidGateIds = [
  undefined,
  null,
  "review",
  {},
  [undefined],
  [null],
  [1],
  [""],
  ["x".repeat(129)],
  ["a b"],
  ["a\tb"],
  ["a\nb"],
  ["é"],
  ["a+b"],
  ["*"],
  ["review", "review"],
  new Array<unknown>(1),
];

export const stageSelectors = [
  { operations: [], gateIds: ["x", "A".repeat(128), "._:/-AZaz09"] },
  { operations: ["approval"], gateKinds: ["approval"] },
  { operations: ["approval"], gateKinds: ["approval"], gateIds: [] },
  { operations: ["approval"], gateIds: ["approval"] },
  { operations: [], gateKinds: ["approval"], gateIds: ["approval"] },
  { operations: ["approval"], gateKinds: ["approval"], gateIds: ["approval"] },
  { gateIds: [] },
  { operations: [], gateKinds: ["question"], gateIds: [] },
];

export const invalidStageSelectors = [
  ...invalidGateIds.map((gateIds) => ({ gateIds })),
  ...[
    null,
    "write-draft",
    [1],
    [""],
    ["x".repeat(129)],
    ["a b"],
    ["é"],
    ["a+b"],
    ["write-draft", "write-draft"],
  ].map((operations) => ({ operations })),
  ...[null, "approval", [1], ["other"], ["approval", "approval"]].map(
    (gateKinds) => ({ gateKinds }),
  ),
];

import { mergeRepository, mergedJournal } from "./watch-merge-fixture.ts";
import { watchModel, type WatchInputs } from "../src/cli/watch-model.ts";

export const boardTime = "2026-10-14T12:00:00.000Z";
export const workflowIds = [
  "develop-issue",
  "develop-ticket",
  "develop-prompt",
];

export function boardEvent(
  operation: string,
  options: { readonly at?: string; readonly round?: number } = {},
): Record<string, unknown> {
  return {
    sequence: Date.parse(options.at ?? boardTime),
    recordedAt: options.at ?? boardTime,
    type: operation === "review" ? "gate.opened" : "effect.requested",
    payload: {
      operationId: JSON.stringify([
        "cloving-operation",
        options.round ?? 1,
        "run-1",
        "implement",
        operation,
      ]),
    },
  };
}

export function boardRun(
  runId: string,
  options: {
    readonly workflowId?: string;
    readonly state?: string;
    readonly latestAt?: string | null;
    readonly outcome?: string;
    readonly ticketId?: unknown;
    readonly issueIdentity?: unknown;
    readonly events?: readonly unknown[];
  } = {},
): Record<string, unknown> {
  return {
    status: {
      runId,
      workflowId: options.workflowId ?? "develop-issue",
      state: options.state ?? "running",
      title: `Title of ${runId}`,
      ticketId: options.ticketId,
      issueIdentity: options.issueIdentity,
      latestAt: options.latestAt ?? boardTime,
      outcome: options.outcome === undefined ? null : { kind: options.outcome },
      claudeCostUsd: 1.25,
    },
    events: options.events ?? [],
  };
}

export function completionScenario(
  ids: { readonly stopped?: string; readonly later?: string } = {},
): ReturnType<typeof watchModel> {
  const completed = (runId: string, ticketId: string) =>
    boardRun(runId, {
      ticketId,
      issueIdentity: {
        owner: "fixture",
        repository: "demo",
        number: ticketId === "DEMO-1" ? 7 : 8,
      },
      state: "completed",
      outcome: "blocked",
      latestAt: "2026-10-14T10:05:00Z",
      events: [{ type: "run.completed", recordedAt: "2026-10-14T10:00:00Z" }],
    });
  const model = boardModel(
    [
      completed("A", "DEMO-1"),
      boardRun("B", {
        ticketId: "DEMO-1",
        issueIdentity: { owner: "fixture", repository: "demo", number: 7 },
        state: "completed",
        outcome: "handoff_requested",
        latestAt: "2026-10-14T10:30:00Z",
        events: [
          { type: "run.created", recordedAt: "2026-10-14T10:01:00Z" },
          { type: "run.completed", recordedAt: "2026-10-14T10:30:00Z" },
        ],
      }),
      completed("C", "DEMO-2"),
    ],
    {
      updatedAt: "2026-10-14T10:31:00Z",
      repository: mergeRepository,
      githubRecords: mergedJournal("B"),
    },
  );
  return renamedScenario(model, { A: ids.stopped ?? "A", B: ids.later ?? "B" });
}

function renamedScenario(
  model: ReturnType<typeof watchModel>,
  names: Readonly<Record<string, string>>,
): ReturnType<typeof watchModel> {
  const rename = (runId: string): string => names[runId] ?? runId;
  return {
    ...model,
    runs: model.runs.map((run) => ({
      ...run,
      runId: rename(run.runId),
      title: `Title of ${rename(run.runId)}`,
    })),
    workflows: model.workflows.map((workflow) => ({
      ...workflow,
      columns: workflow.columns.map((column) => ({
        ...column,
        cards: column.cards.map((card) => ({
          ...card,
          runId: rename(card.runId),
          title: `Title of ${rename(card.runId)}`,
          completionMark: card.completionMark?.laterRunId
            ? {
                ...card.completionMark,
                laterRunId: rename(card.completionMark.laterRunId),
              }
            : card.completionMark,
        })),
      })),
    })),
  };
}

export const pullStages = [
  { name: "prepare", label: "Work tree", operations: ["github-prepare"] },
  { name: "work", label: "Agent turn", operations: ["claude-turn"] },
  { name: "pull", label: "Pull request", operations: ["github-open-pr"] },
  { name: "review", label: "Code review", operations: ["github-wait-review"] },
  { name: "merge", label: "Merge", operations: ["github-merge"] },
] as const;

export function boardModel(
  runs: readonly unknown[],
  changes: Partial<WatchInputs> = {},
): ReturnType<typeof watchModel> {
  return watchModel({
    home: "/fixture/home",
    client: "cloving",
    updatedAt: boardTime,
    service: "up",
    workflows: workflowIds,
    workflowStages: { "develop-issue": pullStages },
    runs,
    decisions: [],
    turns: [],
    githubRecords: [],
    ...changes,
  });
}

export function activeBoardModel(): ReturnType<typeof watchModel> {
  const operations = [
    "github-prepare",
    "claude-turn",
    "github-open-pr",
    "github-wait-review",
    "github-merge",
  ];
  const runs = operations.map((operation) =>
    boardRun(operation, { events: [boardEvent(operation)] }),
  );
  return boardModel([
    ...runs,
    boardRun("round-2", {
      events: [
        boardEvent("github-wait-review", { at: "2026-10-14T10:00:00Z" }),
        boardEvent("claude-turn", { at: "2026-10-14T11:00:00Z", round: 2 }),
      ],
    }),
    boardRun("not-started"),
    boardRun("ticket", {
      workflowId: "develop-ticket",
      events: [boardEvent("review")],
    }),
  ]);
}

export const sampleStages = [
  { name: "draft", label: "Draft", operations: ["write-draft"] },
  { name: "review", label: "Review", gateKinds: ["approval"] },
] as const;

export function stagedModel(
  events: readonly unknown[] = [],
  changes: Partial<WatchInputs> = {},
) {
  return boardModel(
    [boardRun("sample-run", { workflowId: "sample", events })],
    {
      workflows: ["sample"],
      workflowStages: { sample: sampleStages },
      ...changes,
    },
  );
}

export function stageEvent(
  sequence: number,
  selector: {
    readonly operation?: string;
    readonly gateKind?: string;
    readonly gateId?: unknown;
  } = {},
) {
  return {
    sequence,
    recordedAt: `2026-10-14T${String(23 - (sequence % 24)).padStart(2, "0")}:00:00Z`,
    type: selector.operation === undefined ? "gate.opened" : "effect.requested",
    payload:
      selector.operation === undefined
        ? {
            ...(selector.gateKind === undefined
              ? {}
              : { gateKind: selector.gateKind }),
            ...(selector.gateId === undefined
              ? {}
              : { gateId: selector.gateId }),
          }
        : {
            operationId: JSON.stringify([
              "cloving-operation",
              1,
              "sample-run",
              "work",
              selector.operation,
            ]),
          },
  };
}

const opens = reviewStages.map((stage, index) =>
  stageEvent(index + 1, { gateId: stage.gateIds[0], gateKind: "approval" }),
);
export const reviewStageHistory = [
  ...opens,
  ...["gate.decided", "effect.reported", "worker.output"].map(
    (type, index) => ({
      ...stageEvent(4 + index, {
        gateId: "your-review",
        gateKind: "approval",
      }),
      type,
    }),
  ),
  stageEvent(7, { operation: "write-draft" }),
  stageEvent(8, { gateId: "your-review", gateKind: "approval" }),
  stageEvent(9, { gateId: "unmatched", gateKind: "approval" }),
  stageEvent(10, { operation: "unmatched" }),
];

export const reviewStagePositions = [
  ["Your review", 0],
  ["Team review", 1],
  ["Ready to merge", 2],
  ["Ready to merge", 2],
  ["Ready to merge", 2],
  ["Ready to merge", 2],
  ["Draft", 6],
  ["Your review", 7],
  ["Other", 8],
  ["Other", 9],
] as const;

export function paginatedReviewHistory() {
  return Array.from({ length: 1003 }, (_, index) => {
    const sequence = index * 2 + 1;
    if (sequence === 2001)
      return {
        ...stageEvent(sequence, {
          gateId: "your-review",
          gateKind: "approval",
        }),
        recordedAt: boardTime,
      };
    if (sequence === 2003)
      return {
        ...stageEvent(sequence, {
          gateId: "team-review",
          gateKind: "approval",
        }),
        recordedAt: "2026-10-14T01:00:00Z",
      };
    return {
      sequence,
      recordedAt: boardTime,
      type: "effect.reported",
      payload: {},
    };
  });
}
