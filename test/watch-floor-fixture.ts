import type { WatchInputs } from "../src/cli/watch-model.ts";
import {
  boardEvent,
  boardModel,
  boardRun,
  boardTime,
  pullStages,
  sampleStages,
} from "./watch-board-fixture.ts";

export function minutesBefore(minutes: number): string {
  return new Date(Date.parse(boardTime) - minutes * 60000).toISOString();
}

export function floorRun(
  runId: string,
  options: {
    readonly workflowId?: string;
    readonly state?: string;
    readonly operation?: string;
    readonly minutes?: number;
    readonly ticketId?: string;
    readonly issueIdentity?: unknown;
    readonly harness?: string;
    readonly awaitedRunId?: string;
    readonly commandWaits?: readonly unknown[];
  },
): Record<string, unknown> {
  const run = boardRun(runId, {
    state: options.state ?? "running",
    ...(options.workflowId === undefined
      ? {}
      : { workflowId: options.workflowId }),
    ...(options.ticketId === undefined ? {} : { ticketId: options.ticketId }),
    issueIdentity: options.issueIdentity,
    events:
      options.operation === undefined
        ? []
        : [
            boardEvent(options.operation, {
              at: minutesBefore(options.minutes ?? 0),
            }),
          ],
  });
  const status = run["status"];
  return {
    ...run,
    status: {
      ...(typeof status === "object" ? status : {}),
      ...(options.harness === undefined
        ? {}
        : {
            workerTurns: [{ operationId: "turn-1", harness: options.harness }],
          }),
      ...(options.awaitedRunId === undefined
        ? {}
        : { awaitedRunId: options.awaitedRunId }),
      ...(options.commandWaits === undefined
        ? {}
        : { commandWaits: options.commandWaits }),
    },
  };
}

export function floorModel(
  runs: readonly unknown[],
  changes: Partial<WatchInputs> = {},
) {
  return boardModel(runs, {
    workflows: ["develop-issue", "idea"],
    workflowStages: { "develop-issue": pullStages, idea: sampleStages },
    ...changes,
  });
}

export function twoLineModel() {
  return floorModel([
    floorRun("pr-583", {
      operation: "github-open-pr",
      minutes: 38,
      ticketId: "583",
      harness: "claude",
    }),
    floorRun("turn-585", {
      operation: "claude-turn",
      minutes: 3,
      ticketId: "585",
      harness: "claude",
    }),
    floorRun("draft-run", {
      workflowId: "idea",
      operation: "write-draft",
      minutes: 12,
      harness: "codex",
    }),
  ]);
}
