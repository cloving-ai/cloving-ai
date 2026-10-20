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
    sequence: 1,
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
      state: "completed",
      outcome: "blocked",
      latestAt: "2026-10-14T10:05:00Z",
      events: [{ type: "run.completed", recordedAt: "2026-10-14T10:00:00Z" }],
    });
  return boardModel(
    [
      completed(ids.stopped ?? "A", "DEMO-1"),
      boardRun(ids.later ?? "B", {
        ticketId: "DEMO-1",
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
    { updatedAt: "2026-10-14T10:31:00Z" },
  );
}

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
  selector: { readonly operation?: string; readonly gateKind?: string } = {},
) {
  return {
    sequence,
    recordedAt: `2026-10-14T${String(23 - (sequence % 24)).padStart(2, "0")}:00:00Z`,
    type: selector.operation === undefined ? "gate.opened" : "effect.requested",
    payload:
      selector.operation === undefined
        ? { gateKind: selector.gateKind }
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
