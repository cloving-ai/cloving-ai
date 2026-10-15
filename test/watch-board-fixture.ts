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
    readonly events?: readonly unknown[];
  } = {},
): Record<string, unknown> {
  return {
    status: {
      runId,
      workflowId: options.workflowId ?? "develop-issue",
      state: options.state ?? "running",
      title: `Title of ${runId}`,
      latestAt: options.latestAt ?? boardTime,
      outcome: options.outcome === undefined ? null : { kind: options.outcome },
      claudeCostUsd: 1.25,
    },
    events: options.events ?? [],
  };
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
